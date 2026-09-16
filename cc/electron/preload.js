// ============================================================================
// 小鲸鱼桌宠 · preload（拖拽信号 + 键盘按需）
// ============================================================================
// 这里只做两件事：
//   ① 把「挂件正在拖拽」告诉主进程 —— 拖拽中光标会短暂离开鲸鱼轮廓，
//      主进程得知道这时不能切成点穿，否则拖拽会断。
//   ② 键盘按需开关（见下）。
//
// 命中判定**不在这里**。挂件自己开了对外接口 `window.dshWhaleWidget`
// （见 assets/whale-widget.js 末尾的「对外只读接口」一节），
// 但 contextIsolation:true 下 preload 和页面是两个 JS 上下文 ——
// DOM 共享，window 上的东西互相看不见，所以这里读不到它。
// 于是判定放在主进程，用 executeJavaScript 在页面上下文里执行（见 main.js）。
//
// 早先的版本是在这里**复刻**挂件的逐像素 alpha 命中和 UI 元素清单，
// 上游改任何一处都会静默失效（鲸鱼点不到 / 某面板点不到，且不报错）。
// ============================================================================

const { ipcRenderer } = require('electron')

// ---------------------------------------------------------------------------
// 键盘按需开关 —— ⚠ 必须保证「必然回弹」，否则会变成抢焦点
// ---------------------------------------------------------------------------
// 窗口平时是不可激活的（不抢你在用的窗口）。只有点进输入框时才临时打开。
//
// 踩过的坑：一开始只在 mousedown 和 window.blur 上收尾。结果一旦某次
// `setFocusable(true)` 之后 blur 没来，窗口就**永远停在可激活状态** ——
// 表现是「第一次进入没事，第二次进入就被抢焦点」，而且越点越明显。
//
// 关键是要意识到：点了不吃焦点的控件（比如滑块的 input[type=range]）**不会**触发
// focusout，光靠它收尾会漏。所以开了之后立刻回验一次：没有可输入元素真的拿到焦点
// 就当场收回。窗口保持可激活的时间因此只有 ~250ms，不是一个不确定的长窗口。
const KB_VERIFY_MS = 250
let kbTimer = null

function isEditable(el) {
  if (!el || !el.tagName) return false
  const t = el.tagName
  return t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable === true
}

function wantKeyboard(on) {
  try {
    clearTimeout(kbTimer)
    kbTimer = null
    ipcRenderer.send('whale:focus', !!on)
    if (!on) return
    kbTimer = setTimeout(() => {
      kbTimer = null
      let ok = false
      try { ok = isEditable(document.activeElement) } catch (err) {}
      if (!ok) ipcRenderer.send('whale:focus', false)
    }, KB_VERIFY_MS)
  } catch (err) {}
}

// ---------------------------------------------------------------------------
// 事件接线
// ---------------------------------------------------------------------------
// 拖拽期间强制保持可交互：快速拖动时光标会短暂离开鲸鱼轮廓，
// 那一瞬间要是切回点穿，拖拽就断了
window.addEventListener('mousedown', (e) => {
  try { ipcRenderer.send('whale:drag', true) } catch (err) {}
  // 点进输入框才要键盘（要趁点击落下之前就打开，否则 DOM 拿不到焦点）
  try {
    const el = e.target
    const needs = isEditable(el) ||
      (el && el.closest && el.closest('input,textarea,[contenteditable="true"]'))
    wantKeyboard(!!needs)
  } catch (err) {}
}, true)
window.addEventListener('mouseup', () => {
  try { ipcRenderer.send('whale:drag', false) } catch (err) {}
}, true)
window.addEventListener('mouseleave', () => {
  try { ipcRenderer.send('whale:drag', false) } catch (err) {}
})

// 焦点一离开可输入元素就立刻还回去（比 window.blur 可靠：
// 窗口没真正拿到焦点时 blur 根本不会触发）
document.addEventListener('focusout', () => {
  setTimeout(() => {
    try {
      if (!isEditable(document.activeElement)) wantKeyboard(false)
    } catch (err) {}
  }, 120)
}, true)

window.addEventListener('blur', () => wantKeyboard(false))

