// ============================================================================
// 小鲸鱼桌宠 · Electron 外壳
// ============================================================================
// 为什么要有这一层：pywebview + WebView2 做不到「透明 + 可点击」两者兼得 ——
// Win32 的分层命中检测只认窗体自己那一层，而 WebView2 是子窗口，画在另一层。
// 于是色键抠了透明 = 整窗点穿（连鲸鱼都点不到），不抠色键 = 一块实心方块。
// （实测：WindowFromPoint 在鲸鱼身上返回的是底下的编辑器窗口。）
//
// Electron 有原生的解法，正是为这种场景准备的：
//   win.setIgnoreMouseEvents(true)  → 默认整窗点穿
//   主进程轮询真实光标位置发给页面 → 页面判断光标是否落在可交互元素上
//     → 是就通知主进程关掉点穿
// 这样透明和可点击就都拿到了，而且页面（原版 whale-widget.js）一行不用改。
//
// ⚠ 光标位置必须由主进程 screen.getCursorScreenPoint() 取，不能用页面自己的 mousemove：
//   窗口处于 ignoreMouseEvents 时，即使开 forward:true，转发到页面的坐标也是错的
//   （实测光标在屏幕右下角，页面收到的是 (796,412)）。
//
// 窗口铺满整屏，所以鲸鱼能拖到屏幕任何位置 —— 因为「铺满屏幕」在 Electron 下
// 不再是雷：透明是真透明，空白处本来就会点穿。
// ============================================================================

const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('node:path')

const PORT = Number(process.env.WHALE_CC_PORT || 3081)
const URL = `http://127.0.0.1:${PORT}/`
const TITLE = '小鲸鱼'

// 单实例：重复启动就把已有窗口提到前面，而不是叠一层
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win = null
let interactive = false

function setInteractive(next) {
  if (!win || next === interactive) return
  interactive = next
  win.setIgnoreMouseEvents(!next, { forward: true })
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea

  win = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    transparent: true,        // ← 真透明，不需要色键，也就没有命中检测那一堆坑
    frame: false,             // transparent 要求无边框
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,        // 别在任务栏留一个条目
    hasShadow: false,
    alwaysOnTop: true,
    // ⚠ 桌宠必须不可激活（Windows 上对应 WS_EX_NOACTIVATE）：
    // 否则鼠标一靠近鲸鱼、窗口从「点穿」切成「接收鼠标」的那一刻，系统就把它当成
    // 活动窗口 —— 你在用的窗口会失活、被压到后面，不点一下回不来（已踩过）。
    // 注意 focusable:false **不影响鼠标事件**，鲸鱼照样能点能拖，只是不抢焦点。
    // 需要键盘时（泡泡编辑器那些输入框）再由 preload 临时打开，见下面的 whale:focus。
    focusable: false,
    title: TITLE,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 挂件要一直轮询余额/轮次，别被降频
    },
  })

  // 'screen-saver' 层级能压住绝大多数窗口；默认的 'floating' 有些程序会盖住它
  win.setAlwaysOnTop(true, 'screen-saver')

  win.loadURL(URL)
  win.once('ready-to-show', () => {
    win.show()
    // 默认整窗点穿：初始状态下鼠标不在鲸鱼上
    win.setIgnoreMouseEvents(true, { forward: true })
    startCursorPoll()
  })

  // 渲染进程的报错在主进程终端里看不到 —— 挂件和 preload 都在那边跑，
  // 出问题只能靠这个转发才能查（WHALE_CC_DEBUG=1 时落盘）
  if (DEBUG) {
    win.webContents.on('console-message', (...args) => {
      // Electron 新旧签名不同：新版是单个事件对象，旧版是 (event, level, message, line, sourceId)
      const a = args[0]
      const o = (a && typeof a === 'object' && 'message' in a)
        ? { level: a.level, message: a.message, line: a.lineNumber, source: a.sourceId }
        : { level: args[1], message: args[2], line: args[3], source: args[4] }
      dbg({ t: Date.now(), console: o })
    })
    win.webContents.on('preload-error', (_e, file, err) => {
      dbg({ t: Date.now(), preloadError: { file, message: String(err && err.message || err) } })
    })
    win.webContents.on('render-process-gone', (_e, d) => {
      dbg({ t: Date.now(), renderGone: d })
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      dbg({ t: Date.now(), failLoad: { code, desc, url } })
    })
  }

  win.on('closed', () => {
    win = null
    if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null }
  })
}

// ---------------------------------------------------------------------------
// 主动轮询光标位置 + 命中判定
// ---------------------------------------------------------------------------
// ⚠ 不能指望渲染进程的 mousemove。窗口处于 ignoreMouseEvents 时，
// 即使带 forward:true，转发过去的坐标也是错的（实测光标在屏幕右下角，
// 页面收到的却是 (796,412)）—— 判定逻辑再准，喂错坐标也没用。
// 所以由主进程用 screen.getCursorScreenPoint() 拿真值。
//
// ⚠ 判定必须用 executeJavaScript **在页面上下文里**执行，不能在 preload 里做：
// contextIsolation:true 时 preload 和页面是两个 JS 上下文，DOM 共享但 window 上的东西
// 互相看不见 —— preload 读不到挂件暴露的 window.dshWhaleWidget。
// 放主进程还有个好处：判定结果和 setIgnoreMouseEvents 待在同一个地方，不用来回传。
// 诊断落盘（默认关，WHALE_CC_DEBUG=1 开）
const DEBUG = !!process.env.WHALE_CC_DEBUG
const DEBUG_LOG = path.join(require('node:os').tmpdir(), 'whale-electron.log')
if (DEBUG) { try { require('node:fs').writeFileSync(DEBUG_LOG, '') } catch (err) {} }
function dbg(o) {
  if (!DEBUG) return
  try { require('node:fs').appendFileSync(DEBUG_LOG, JSON.stringify(o) + '\n') } catch (err) {}
}

const CURSOR_MS = 60
const API_MIN_VERSION = 1

let cursorTimer = null
let queryInFlight = false    // executeJavaScript 是异步的，防止超时后调用堆积
let dragging = false         // 挂件自己的拖拽期间必须一直可交互（由 preload 告知）

const hitExpr = (x, y) => `(function () {
  try {
    var w = window.dshWhaleWidget
    if (!w || typeof w.version !== 'number' || w.version < ${API_MIN_VERSION}) return null
    return (w.isUiHit(${x}, ${y}) || w.isWhaleHit(${x}, ${y})) ? 1 : 0
  } catch (e) { return null }
})()`

function startCursorPoll() {
  if (cursorTimer) return
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || queryInFlight) return
    try {
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const x = Math.round(p.x - b.x)
      const y = Math.round(p.y - b.y)
      queryInFlight = true
      win.webContents.executeJavaScript(hitExpr(x, y), true)
        .then((v) => {
          dbg({ t: Date.now(), x, y, v, dragging })
          // null = 接口没就绪（挂件还没 init 完），这时不接管鼠标
          if (v === null || v === undefined) return
          setInteractive(dragging || v === 1)
        })
        .catch(() => {})
        .finally(() => { queryInFlight = false })
    } catch (err) { queryInFlight = false }
  }, CURSOR_MS)
}

// 拖拽状态由页面告知：挂件拖拽时快速移动会让光标短暂离开鲸鱼轮廓，
// 那一瞬间若切成点穿，拖拽就断了。所以拖拽期间强制保持可交互。
ipcMain.on('whale:drag', (_e, on) => {
  dragging = !!on
  if (dragging) setInteractive(true)
})

// 键盘按需：平时窗口不可激活（不抢焦点），只有点进输入框时才临时打开。
// ⚠ 关的时候必须**同时**把可激活和实际焦点都放掉：只调 setFocusable(false)
// 的话，窗口可能还拿着焦点，之后鼠标一靠近又会被激活（就是「第二次进入被抢」）。
ipcMain.on('whale:focus', (_e, on) => {
  if (!win || win.isDestroyed()) return
  try {
    if (on) {
      win.setFocusable(true)
      win.focus()
    } else {
      if (win.isFocused()) win.blur()   // 先把焦点还回去，再收回可激活
      win.setFocusable(false)
    }
  } catch (err) {}
})

app.whenReady().then(createWindow)

app.on('second-instance', () => {
  if (win) { win.show(); win.focus() }
})

app.on('window-all-closed', () => app.quit())

// 给 whale.py 的 stop 用：收到信号就干净退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => app.quit())
}
