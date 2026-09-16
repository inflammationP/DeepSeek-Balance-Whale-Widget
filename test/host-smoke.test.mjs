// 自检：把宿主插件真跑起来（stub ctx），打一次 /dsh-whale/api-models.json，
// 验证「Claude Code（本地会话）」这条链路端到端通了：模板注册 → 本地会话统计 → payload 里的 codex 字段（含金额）。
// 跑法：node test/host-smoke.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../lib/index.js'

const routes = new Map()
const ctx = {
  get: () => null,
  on: () => () => {},
  effect: () => {},
  credentials: {
    // 一律当「没配密钥」：本地会话模式本来就不该需要密钥
    resolve: async () => ({ value: '' }),
    set: async () => {},
  },
  webServer: {
    register: (r) => { routes.set(r.path, r); return () => {} },
    tapIndex: () => {},
  },
}

plugin.apply(ctx)

const route = routes.get('/dsh-whale/api-models.json')
assert.ok(route, '/dsh-whale/api-models.json 应当被注册')

// 造一个假的 req/res 收 JSON
function call(route, { method = 'GET', url = '', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = {
      method, url,
      headers: { host: '127.0.0.1:3080' },
      on: (ev, cb) => {
        if (ev === 'data' && body != null) cb(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') cb()
      },
    }
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}) },
      end(s) { resolve({ status: this.statusCode, text: s == null ? '' : String(s) }) },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const res = await call(route)
assert.equal(res.status, 200, 'api-models.json 应当返回 200，实际 ' + res.status)
const data = JSON.parse(res.text)

// ① 新模板必须出现在下发给前端的模板列表里
const tpl = (data.templates || []).find((t) => t.id === 'claude_code')
assert.ok(tpl, '模板列表里应当有 claude_code')
assert.equal(tpl.kind, 'claude_code')
assert.equal(tpl.name, 'Claude Code（本地会话）')
assert.equal(tpl.hasBalance, false, '本地会话模板不该带余额接口')

// ② 模板的 kind 必须是「本地会话」家族，前端据此隐藏余额接口行、显示本地会话行
assert.ok(['codex', 'claude_code'].includes(tpl.kind))

// ③ 真起一遍本地会话统计：本机有 ~/.claude/projects 就应该 ok
const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
if (!fs.existsSync(projects)) {
  console.log('③ 跳过：本机没有 ' + projects)
} else {
  // 直接按模板 kind 走一遍 host 的取数逻辑：注册一个该模板的模型，再读 payload
  const saved = await call(route, {
    method: 'PUT',
    body: {
      model: {
        id: 'test-claude-code', name: 'Claude Code 测试', provider: 'claude_code',
        currency: 'CNY', keyRef: '', matchIds: ['claude'],
      },
    },
  })
  assert.equal(saved.status, 200, '写入测试模型应当成功，实际 ' + saved.status + ' ' + saved.text.slice(0, 200))

  const res2 = await call(route)
  assert.equal(res2.status, 200)
  const d2 = JSON.parse(res2.text)
  const m = (d2.models || []).find((x) => x.id === 'test-claude-code')
  assert.ok(m, 'payload 里应当有刚写入的模型')
  assert.ok(m.codex, '本地会话模型必须带 codex 字段（Claude Code 与 Codex 共用该字段名）')
  assert.equal(m.codex.ok, true, '本机有 ~/.claude/projects，统计应当 ok：' + (m.codex.error || ''))
  assert.equal(m.codex.kind, 'claude_code', 'kind 必须是 claude_code，前端据此显示 Claude Code 文案')
  assert.equal(m.codex.label, 'Claude Code')
  assert.ok(m.codex.sessions > 0, '应当扫到会话文件，实际 ' + m.codex.sessions)
  assert.ok(m.codex.todayTokens >= 0 && m.codex.totalTokens > 0, '累计 token 应当 > 0')
  assert.ok(Array.isArray(m.codex.days7) && m.codex.days7.length === 7, 'days7 应当是 7 天')
  // 金额：本机日志是 deepseek-* 模型，命中内置价目表 → 应当算出钱
  assert.ok(Number(m.codex.totalCost) > 0, '应当折算出累计金额，实际 ' + m.codex.totalCost)
  assert.ok(Number(m.codex.days7.reduce((s, d) => s + (Number(d.cost) || 0), 0)) <= Number(m.codex.totalCost) + 1e-6,
    '近 7 天金额不应超过累计金额')

  // ④ 汇总不能丢量：按模型分桶的和必须等于总量（峰谷拆桶最容易在这里漏）
  const bmTokens = Object.keys(m.codex.byModel).reduce((s, k) => s + (Number(m.codex.byModel[k].tokens) || 0), 0)
  assert.equal(bmTokens, m.codex.totalTokens, 'byModel 的 token 之和必须等于 totalTokens')
  const bmCost = Object.keys(m.codex.byModel).reduce((s, k) => s + (Number(m.codex.byModel[k].cost) || 0), 0)
  assert.ok(Math.abs(bmCost - m.codex.totalCost) < 0.02, 'byModel 的金额之和必须等于 totalCost（' + bmCost + ' vs ' + m.codex.totalCost + '）')
  assert.ok(m.codex.cachedTokens <= m.codex.totalTokens, '缓存命中 token 不可能超过总量')
  assert.ok(m.codex.todayTokens <= m.codex.totalTokens, '今日 token 不可能超过累计')

  // ⑤ Codex 那条老链路不能被改坏：kind 与缓存文件必须还是它自己的
  const codexTpl = (data.templates || []).find((t) => t.id === 'codex')
  assert.equal(codexTpl.kind, 'codex')

  console.log('③ Claude Code 本地会话：' + m.codex.sessions + ' 个会话文件'
    + ' · 今日 ' + m.codex.todayTokens.toLocaleString() + ' tokens'
    + ' · 累计 ' + m.codex.totalTokens.toLocaleString() + ' tokens'
    + ' · 折合 ¥' + m.codex.totalCost)

  // ④ 额度面板的「本地会话」已用来源：沿用历史取值 'codex'，但要真的取到 Claude Code 的数
  //    （这是最容易被改坏的一处：取值是 codex，数据源必须由模板 kind 决定）
  const setQ = await call(route, {
    method: 'PUT',
    body: { action: 'model-settings', id: 'test-claude-code', quota: { on: true, mode: 'codex', unit: 'tokens', total: 1000000000, used: 0, reset: 'daily' } },
  })
  assert.equal(setQ.status, 200, '设置额度应当成功：' + setQ.text.slice(0, 200))
  const d3 = JSON.parse((await call(route)).text)
  const m3 = (d3.models || []).find((x) => x.id === 'test-claude-code')
  assert.ok(m3.quota, 'payload 里应当带 quota')
  assert.equal(m3.quota.mode, 'codex')
  assert.equal(m3.quota.autoUsed, m.codex.todayTokens,
    '「本地会话」额度的已用必须等于 Claude Code 今日 token（而不是 Codex 的）：' + m3.quota.autoUsed + ' vs ' + m.codex.todayTokens)

  console.log('④ 额度「本地会话」来源（mode=codex）→ 已用 ' + m3.quota.autoUsed.toLocaleString() + ' tokens = Claude Code 今日用量 ✓')

  // 清掉测试模型，别把用户注册表弄脏
  await call(route, { method: 'PUT', body: { action: 'delete', id: 'test-claude-code' } })
}

// ⑥ 两个来源的缓存文件必须分开，不能互相覆盖
const cacheDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
for (const f of ['.dshw-codex.json', '.dshw-claude.json']) {
  const p = path.join(cacheDir, f)
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    assert.ok(j && j.files && typeof j.files === 'object', f + ' 应当是 { files: {...} } 结构')
    const sample = Object.keys(j.files)[0]
    if (sample) {
      const isClaude = f.includes('claude')
      assert.equal(/(^|[\\/])projects[\\/]/.test(sample), isClaude,
        f + ' 里不该混入另一个来源的会话文件（样例：' + sample + '）')
    }
  }
}

console.log('OK — 宿主端 Claude Code 本地会话链路全部通过')
// 插件自己注册了 5 分钟的预热 interval，不主动退出的话 node 会一直挂着
process.exit(0)
