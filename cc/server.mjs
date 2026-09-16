#!/usr/bin/env node
// ============================================================================
// 小鲸鱼挂件 · Claude Code 版 —— DSH 运行时替身
// ============================================================================
// 目标：让 lib/index.js（宿主）和 assets/whale-widget.js（前端）**一行都不改**地跑起来。
//
// 原版是 DSH 的 bundle 插件，它只跟 ctx 要 7 样东西：
//   ctx.webServer.register(route)     注册 /dsh-whale/* 路由
//   ctx.webServer.tapIndex(fn)        往页面 </body> 前插一行 <script>
//   ctx.credentials.resolve/set/unset/deleteRecord
//   ctx.get('connection').requestRejection(req)   浏览器信任栅栏
//   ctx.on('session/event'|'session/disposed', fn)
//   ctx.effect(fn)
// 这里把 ctx 用真实现填上，插件本体原封不动。
//
// 唯一需要「翻译」的是会话事件：DSH 有自己的 turn/assistant 事件总线，Claude Code 没有。
// 所以这里起一个 transcript 跟随器，读 ~/.claude/projects/**/*.jsonl 合成同样形状的事件。
//
// 跑法：node cc/server.mjs       （或直接 run.cmd）
// ============================================================================

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')

// 挂件自己的配置目录（缩放/泡泡/音效/帐本…），与 DSH 的 ~/.dsh 完全隔离
const WHALE_HOME = process.env.WHALE_CC_HOME || path.join(os.homedir(), '.whale-cc')
const PORT = Number(process.env.WHALE_CC_PORT || 3081)
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

// ⚠ 必须在 import 插件之前设好：插件在模块顶层就把它读走了
fs.mkdirSync(WHALE_HOME, { recursive: true })
process.env.DSH_HOME = WHALE_HOME

const log = (...a) => { try { console.log('[whale-cc]', ...a) } catch (err) {} }

// ============================================================================
// 1. 凭据：DSH 的 credentials 服务替身
// ============================================================================
// 优先级：挂件自己存的 → 环境变量 → （仅当 CC 跑在 DeepSeek 上时）CC 自己的 key
//
// ⚠ 最后一条必须有 baseUrl 守卫：只有当用户的 Claude Code 确实指向 api.deepseek.com 时，
//    才把它的 token 拿去查 DeepSeek 余额。否则（比如用真 Anthropic key）把 token 发去
//    api.deepseek.com 就成了凭据外泄，绝不允许。
const CRED_FILE = path.join(WHALE_HOME, 'credentials.json')

function readCredStore() {
  try {
    const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch (err) { return {} }
}
function writeCredStore(store) {
  try {
    fs.writeFileSync(CRED_FILE, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (err) { return false }
}

// 从 Claude Code 的 settings 里取「它自己在用的 DeepSeek key」——只取不发，且带 baseUrl 守卫
function deepseekKeyFromClaudeCode() {
  const files = [
    path.join(CLAUDE_HOME, 'settings.json'),
    path.join(CLAUDE_HOME, 'settings.local.json'),
  ]
  for (const f of files) {
    let j = null
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (err) { continue }
    const env = (j && j.env) || {}
    const base = String(env.ANTHROPIC_BASE_URL || '')
    // 守卫①：CC 必须真的指向 DeepSeek
    if (!/deepseek\.com/i.test(base)) continue
    const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.DEEPSEEK_API_KEY
    if (key) return String(key)
  }
  return ''
}

const credentials = {
  async resolve(ref) {
    const name = String(ref || '')
    if (!name) return null
    const store = readCredStore()
    if (store[name]) return { value: String(store[name]) }
    // 挂件面板里填的 key 会走 set() 落到 CRED_FILE；环境变量只作兜底
    if (process.env[name]) return { value: String(process.env[name]) }
    if (name === 'DEEPSEEK_API_KEY') {
      const k = deepseekKeyFromClaudeCode()
      if (k) return { value: k }
    }
    return null
  },
  async set(ref, value) {
    const store = readCredStore()
    store[String(ref)] = String(value)
    return writeCredStore(store)
  },
  async unset(ref) {
    const store = readCredStore()
    delete store[String(ref)]
    return writeCredStore(store)
  },
  async deleteRecord(ref) { return this.unset(ref) },
}

// ============================================================================
// 2. 会话事件：跟随 ~/.claude/projects 的 transcript，合成 DSH 形状的事件
// ============================================================================
// 事件契约（读自 lib/index.js 的 handleSessionEvent）：
//   { type:'assistant/message', data:{ turn, usage:{ inputTokens, cacheReadTokens,
//                                                       outputTokens, reasoningTokens },
//                                      message:{ source:{ model } } } }
//   { type:'turn/end', data:{} }
//
// ⚠ Claude Code 会把**一次 API 响应**按 content block 拆成多条 assistant 行，每行携带
//   逐字段完全相同的 usage → 必须按 message.id 去重（实测某会话 1282 行只对应 501 条真实请求，
//   直接求和会多算 2.7 倍）。注意不能用 requestId：实测同一文件里它只有 1 个值。
//
// ⚠ 启动时从每个文件的**末尾**开始跟（offset = 当前大小），不回放历史 ——
//   否则一启动就把几百条旧轮次当成新消耗，疯狂弹泡泡。
const listeners = new Map() // event -> [fn]

function emit(type, data, sessionId) {
  const fns = listeners.get('session/event') || []
  for (const fn of fns) {
    try { fn({ id: sessionId }, { type, data }) } catch (err) {}
  }
}

const watch = new Map() // file -> { offset, turn, ids:Set, pending, lastTs, skipId }

// ---- 读取位置持久化 --------------------------------------------------------
// ⚠ 不持久化的话每次重启都从文件末尾重新跟，**停机期间的账永久丢失** ——
// 表现是「今日已用」（余额差，准）和「明细」（逐轮事件）对不上，
// 差额被挂件补成一行「(未入明细)」。实测某天 356 条真实请求只记到 166 条。
// 存下 offset 后，重启会接着上次读，把停机那段补回来。
const TAIL_FILE = path.join(WHALE_HOME, '.whale-cc-tail.json')
const TAIL_MAX_BACKFILL = 64 * 1024 * 1024 // 落后太多就别补了（比如停了几天），从头补会刷爆台账

function readTailState() {
  try {
    const j = JSON.parse(fs.readFileSync(TAIL_FILE, 'utf8'))
    if (j && j.files && typeof j.files === 'object') return j
  } catch (err) {}
  return { version: 1, files: {} }
}
function writeTailState() {
  try {
    const files = {}
    for (const [f, s] of watch) {
      files[f] = { offset: s.offset, lastId: s.lastId || '' }
    }
    fs.writeFileSync(TAIL_FILE, JSON.stringify({ version: 1, files, savedAt: Date.now() }), 'utf8')
  } catch (err) {}
}

const tail = readTailState()

function listTranscripts() {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.jsonl$/i.test(e.name)) out.push(p)
    }
  }
  walk(path.join(CLAUDE_HOME, 'projects'), 0)
  return out
}

function endTurn(sid, st) {
  if (!st.pending) return
  st.pending = false
  st.turn += 1
  emit('turn/end', {}, sid)
}

function handleLine(sid, st, line, now) {
  if (!line || line.charCodeAt(0) !== 123) return
  let o = null
  try { o = JSON.parse(line) } catch (err) { return }

  // 真实用户输入（不是工具结果）＝ 上一轮结束，立刻结算，不用等静默
  if (o.type === 'user') {
    const c = o.message && o.message.content
    const isToolResult = Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')
    if (!isToolResult) endTurn(sid, st)
    return
  }
  if (o.type !== 'assistant') return

  const m = o.message
  if (!m || typeof m !== 'object') return
  const u = m.usage
  if (!u || typeof u !== 'object') return

  const id = m.id ? String(m.id) : ''
  if (id) {
    // 断点续读的边界：上次读到一半的那条响应，剩下的 content block 不能再算一遍
    if (st.skipId && id === st.skipId) return
    if (st.skipId) st.skipId = ''
    if (st.ids.has(id)) return // 同一响应的后续 content block，跳过
    if (st.ids.size > 20000) st.ids.clear() // ponytail: 无上限会一直涨；真撞上就重算一次
    st.ids.add(id)
    st.lastId = id
  }

  const model = String(m.model || '')
  if (!model || model === '<synthetic>' || o.isApiErrorMessage) return // 本地报错合成的条目，不计费

  // 缓存写入并进「输入」：账本公式里输入按未命中价计，与 cache_creation 同档
  const input = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
  const cache = Number(u.cache_read_input_tokens) || 0
  const output = Number(u.output_tokens) || 0
  // 推理 token 已含在 output 内（是其子集），只作展示拆分；插件侧有 reasoning>output 的兜底
  const reasoning = Number((u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0) || 0
  if (input + cache + output <= 0) return

  st.pending = true
  st.lastTs = now
  emit('assistant/message', {
    turn: st.turn,
    usage: { inputTokens: input, cacheReadTokens: cache, outputTokens: output, reasoningTokens: reasoning },
    message: { source: { model } },
  }, sid)
}

function pollTranscripts() {
  const now = Date.now()
  let moved = false
  for (const file of listTranscripts()) {
    let st = null
    try { st = fs.statSync(file) } catch (err) { continue }
    const sid = path.basename(file, '.jsonl')
    let s = watch.get(file)
    if (!s) {
      const saved = tail.files[file]
      let start = st.size // 第一次见：从末尾跟，不回放历史（否则一启动就狂弹旧泡泡）
      let skipId = ''
      if (saved && typeof saved.offset === 'number' && saved.offset <= st.size) {
        if (st.size - saved.offset <= TAIL_MAX_BACKFILL) {
          start = saved.offset   // 接着上次读：把停机期间的账补回来
          skipId = saved.lastId || ''
        } else {
          log('会话文件落后太多，跳过补账：' + path.basename(file))
        }
      }
      // ⚠ 必须同时赋给 s：watch.set() 不会更新局部变量，只 set 不赋值的话
      // 下面的 s.offset 会直接 TypeError（重启必崩，已踩过）
      s = {
        offset: start, turn: 0, ids: new Set(), pending: false, lastTs: 0,
        skipId, lastId: skipId,
      }
      watch.set(file, s)
      moved = true
      if (start === st.size) continue
      // 有要补的：落到下面正常读取流程，一次读完
    }
    if (st.size < s.offset) { s.offset = 0; s.ids.clear() } // 被截断/重写
    if (st.size === s.offset) {
      if (s.pending && now - s.lastTs > 1500) endTurn(sid, s) // 静默 1.5s ＝ 这轮说完了
      continue
    }
    let chunk = ''
    try {
      const fd = fs.openSync(file, 'r')
      const len = st.size - s.offset
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, s.offset)
      fs.closeSync(fd)
      chunk = buf.toString('utf8')
    } catch (err) { continue }
    // 只吃完整行：末尾半行留到下次，否则会 JSON 解析失败并丢数据
    const cut = chunk.lastIndexOf('\n')
    if (cut < 0) continue
    const usable = chunk.slice(0, cut + 1)
    s.offset += Buffer.byteLength(usable, 'utf8')
    moved = true
    for (const line of usable.split('\n')) handleLine(sid, s, line, now)
    if (s.pending && now - s.lastTs > 1500) endTurn(sid, s)
  }
  return moved
}

// ============================================================================
// 3. ctx 替身 + 加载插件本体（原封不动）
// ============================================================================
const routes = []

const ctx = {
  // 信任栅栏：这里没有浏览器会话，栅栏不适用。返回 false = 放行，
  // 同时也让插件不必打那条「栅栏不可用」的 warn。
  get: (name) => (name === 'connection' ? { requestRejection: () => false } : null),
  on: (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
    return () => {
      const arr = listeners.get(event) || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
  },
  effect: (fn) => { try { fn() } catch (err) {} },
  credentials,
  webServer: {
    register: (route) => { routes.push(route); return () => {} },
    // 原版用它往 DSH 页面 </body> 前插 <script src="/dsh-whale/widget.js">。
    // 我们的 pet.html 里已经手写了同一行，这里只需要接住、别让插件报错。
    tapIndex: () => () => {},
  },
}

const plugin = (await import(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'index.js')).href)).default
plugin.apply(ctx)
log('插件已挂载：' + routes.length + ' 条路由')

// ============================================================================
// 4. HTTP 服务
// ============================================================================
const PET_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鲸鱼</title>
<style>
  /*
    页面必须是透明的 —— 这是透明桌宠的「上半截」。
    下半截在 whale.py：pywebview 的 transparent=True 让 WebView2 不画底色，
    再由 make_form_transparent() 给承载它的 WinForms 窗体设 TransparencyKey。
    少任何一半都是个方块：只有 WebView2 透明 → 白方块；只有窗体键色 → 整块实心色。

    这里**不要**写 background:#fff 之类的实色，否则直接把 WebView2 那半截废掉。
  */
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
</style>
</head><body>
<!--
  替身「聊天输入框」——必须留着，删了挂件就不启动。
  挂件开头有一道页面自检（dshwIsChatRoot）：它只在 #root 里能找到 textarea 或
  contenteditable 时才认为处在 DSH 主聊天界面，否则静默 return（见 whale-widget.js:15-47）。
  这里放一个 0 尺寸、不可聚焦、不接收事件的替身满足它，挂件本体因此无需改动。
-->
<div id="root"><div contenteditable="true" tabindex="-1" aria-hidden="true"
  style="position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none"></div></div>
<script src="/pet.js"></script>
<script defer src="/dsh-whale/widget.js"></script>
</body></html>`

// 页面引导脚本。**刻意放成外部文件**而不是内联：内联脚本会逼着 CSP 的 script-src 开
// 'unsafe-inline'，而挂件本身不需要 eval，脚本完全可以收到 'self'。
// 顺序和原来一致（它在 defer 的挂件之前执行）。
const PET_JS = `// 补发 resize —— 不加这段挂件会白屏。
// 挂件在 dshwInit() 里读一次 root.getBoundingClientRect() 定初始位置，之后只靠 window 的
// resize 事件重算（见 whale-widget.js:13900）。而 Edge app 窗口创建时视口还是默认的 800x600，
// 等窗口缩到 300x300 时挂件早已把自己定位到窗口外（实测 inset 落在 614px/349px），
// 于是内容区一片空白。这里在页面稳定后补发几次 resize，逼它按真实视口重新落位。
(function () {
  // Edge 兜底路径带 ?opaque=1：浏览器做不到透明，给个白底免得变成一片黑
  try {
    if (location.search.indexOf('opaque') !== -1) {
      document.documentElement.style.background = '#fff'
      document.body.style.background = '#fff'
    }
  } catch (e) {}
  function nudge() { try { window.dispatchEvent(new Event('resize')) } catch (e) {} }
  window.addEventListener('load', function () {
    setTimeout(nudge, 200); setTimeout(nudge, 900); setTimeout(nudge, 2200)
  })
})()
`

// 内容安全策略。不发这个头 Electron 会打警告（开发时可见，打包后自动消失），
// 但更重要的是它真的有意义：页面会加载用户上传的角色图/泡泡图/音频，收紧来源能挡掉意外。
//   script-src 'self'        挂件和引导脚本都是同源外部文件，不需要 unsafe-inline/eval
//   style-src  'unsafe-inline' 挂件运行时大量动态插 <style> 和内联样式，这条去不掉
//   img-src    data:         用户上传的图片有走 data URL 的路径
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const server = http.createServer((req, res) => {
  let pathname = '/'
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname } catch (err) {}

  if (pathname === '/' || pathname === '/pet.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
    })
    res.end(PET_HTML)
    return
  }
  if (pathname === '/pet.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
    })
    res.end(PET_JS)
    return
  }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, routes: routes.length, home: WHALE_HOME, claudeHome: CLAUDE_HOME }))
    return
  }
  // 插件的 21 条路由全是 kind:'exact'，精确匹配路径即可（query 由 handler 自己从 req.url 取）
  const route = routes.find((r) => r.path === pathname)
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 ' + pathname)
    return
  }
  Promise.resolve()
    .then(() => route.handler(req, res))
    .catch((err) => {
      try {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      } catch (e2) {}
    })
})

server.listen(PORT, '127.0.0.1', () => {
  log('小鲸鱼已就绪 → http://127.0.0.1:' + PORT + '/')
  log('配置目录 ' + WHALE_HOME)
  log('会话日志 ' + path.join(CLAUDE_HOME, 'projects'))
  const k = deepseekKeyFromClaudeCode()
  log(k ? '余额：用 Claude Code 自己的 DeepSeek key（已从 settings 读到）' : '余额：未找到 DeepSeek key —— 到挂件菜单「自定义 API」里填，或设 DEEPSEEK_API_KEY')
})

// 跟随 transcript：每秒一次（挂件那边轮询 last-turn.json 也是 1s，两边节奏对齐）。
// 只在位置真的推进时才落盘，否则每秒写一次这个 JSON 纯属浪费。
pollTranscripts()
writeTailState()
setInterval(() => { if (pollTranscripts()) writeTailState() }, 1000)

// 退出前存一次，尽量少丢
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { writeTailState() } catch (err) {} })
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { server.close() } catch (err) {}; process.exit(0) })
}
