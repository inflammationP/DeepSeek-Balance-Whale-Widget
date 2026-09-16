// 自检：Claude Code 会话日志的解析与去重口径。
// 跑法：node test/parse-claude-transcript.test.mjs
// 断言的是 lib/index.js 里真正发货的那个函数，不是副本。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseClaudeTranscriptLines } from '../lib/index.js'

const line = (o) => JSON.stringify(o)
// 一次 API 响应被拆成 3 条 assistant 行：usage 逐字段相同，只有 apiBlockIndex 不同
const blockTriple = (id, model, ts, usage) =>
  [0, 1, 2].map((i) => line({
    type: 'assistant', apiBlockIndex: i, timestamp: ts, sessionId: 's1',
    message: { id, model, usage },
  })).join('\n')

const U = {
  input_tokens: 1187, cache_read_input_tokens: 29952, cache_creation_input_tokens: 0,
  output_tokens: 111, output_tokens_details: { thinking_tokens: 40 },
}

// ① 同一个 message.id 出现 3 次 → 只算一次（这是整个功能最容易算错的地方）
{
  const recs = parseClaudeTranscriptLines(blockTriple('m1', 'deepseek-flash', '2026-09-15T10:00:00Z', U))
  assert.equal(recs.length, 1, '同 id 的多条 content block 必须去重成 1 条')
  assert.equal(recs[0].cached, 29952)
  assert.equal(recs[0].out, 111)
  assert.equal(recs[0].reason, 40)
  // total = input + cache_read + cache_creation + output
  assert.equal(recs[0].total, 1187 + 29952 + 0 + 111)
}

// ② 不同 message.id 各自计数，且同一 id 的重复行不会跨 id 互相吞掉
{
  const text = [
    blockTriple('a', 'deepseek-v4-pro', '2026-09-15T10:00:00Z', { ...U, input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 }),
    blockTriple('b', 'deepseek-v4-pro', '2026-09-15T10:01:00Z', { ...U, input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0 }),
  ].join('\n')
  const recs = parseClaudeTranscriptLines(text)
  assert.equal(recs.length, 2)
  assert.equal(recs.reduce((s, r) => s + r.total, 0), 110 + 220)
}

// ③ 非 assistant 行、合成模型、零用量、坏 JSON 都要被丢掉
{
  const text = [
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),           // 不是 assistant
    line({ type: 'assistant', message: { id: 'x', model: '<synthetic>', usage: U } }), // 合成条目
    line({ type: 'assistant', message: { id: 'y', model: 'deepseek-flash', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), // 零用量
    line({ type: 'assistant', message: { id: 'z', model: 'deepseek-flash', usage: U } }), // 没有 timestamp
    '{ 坏 JSON',
    '',
  ].join('\n')
  assert.equal(parseClaudeTranscriptLines(text).length, 0)
}

// ④ 无 message.id 时不参与去重（宁可多算也不漏算）
{
  const one = (o) => line(o)
  const text = [
    one({ type: 'assistant', timestamp: '2026-09-15T10:00:00Z', message: { model: 'deepseek-flash', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    one({ type: 'assistant', timestamp: '2026-09-15T10:00:01Z', message: { model: 'deepseek-flash', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ].join('\n')
  assert.equal(parseClaudeTranscriptLines(text).length, 2)
}

// ⑤ 拿本机真实日志验一次：去重必须真的生效，且各字段自洽
{
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
  let files = []
  try {
    files = fs.readdirSync(dir, { recursive: true })
      .filter((f) => String(f).endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
  } catch (err) { files = [] }
  if (!files.length) {
    console.log('⑤ 跳过：本机没有 ~/.claude/projects/*.jsonl')
  } else {
    const file = files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
    const text = fs.readFileSync(file, 'utf8')
    const recs = parseClaudeTranscriptLines(text)
    const rawLines = text.split('\n').filter((l) => l.startsWith('{') && JSON.parse(l).type === 'assistant').length
    assert.ok(recs.length > 0, '真实日志应当解析出记录')
    assert.ok(rawLines >= recs.length, 'assistant 原始行数不应少于去重后的记录数')
    for (const r of recs) {
      assert.equal(r.total, r.input + r.cached + r.cwrite + r.out, 'total 必须等于四项之和')
      assert.ok(r.ts > 0 && r.model && r.model !== '<synthetic>')
    }
    const sum = (k) => recs.reduce((s, r) => s + r[k], 0)
    console.log('⑤ 真实日志 ' + path.basename(file) + '：'
      + 'assistant 行 ' + rawLines + ' → 去重后 ' + recs.length + ' 条'
      + '（去掉 ' + (rawLines - recs.length) + ' 条重复 content block）'
      + ' · cache_read ' + sum('cached').toLocaleString() + ' tokens')
    assert.ok(rawLines > recs.length, '本机日志应当存在重复 content block，否则这条断言失去意义')
  }
}

// ⑥ 峰谷归属：高峰(周三 10:00 北京) 与 谷价(周三 02:00 北京) 必须落到不同档
{
  // 2026-09-16 是周三；北京 10:00 = UTC 02:00，北京 02:00 = UTC 前一天 18:00
  const peak = parseClaudeTranscriptLines(line({ type: 'assistant', timestamp: '2026-09-16T02:00:00Z', message: { id: 'p', model: 'deepseek-flash', usage: U } }))
  const off = parseClaudeTranscriptLines(line({ type: 'assistant', timestamp: '2026-09-15T18:00:00Z', message: { id: 'o', model: 'deepseek-flash', usage: U } }))
  assert.equal(peak.length, 1)
  assert.equal(off.length, 1)
  const hourBJ = (r) => new Date(r.ts + 8 * 3600 * 1000).getUTCHours()
  assert.equal(hourBJ(peak[0]), 10, 'case ⑥ 的 peak 样本应当落在北京 10 点')
  assert.equal(hourBJ(off[0]), 2, 'case ⑥ 的 off 样本应当落在北京 2 点')
}

console.log('OK — Claude Code 转录解析与去重口径全部通过')
