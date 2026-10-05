import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestChat } from '../src/api/chat.ts'
import { estimateMessageTokens, prepareContextBudget } from '../src/api/contextBudget.ts'
import { subscribeChatMetrics } from '../src/api/chatMetrics.ts'

const request = {
  baseUrl: 'https://provider.test/v1', apiKey: 'private-test-key', model: 'test-model',
  providerId: 'preset-1', purpose: 'agent', contextTokens: 4096, maxTokens: 512, historyTokens: 200,
}
const messages = [
  { role: 'system', content: '完整协议与作者锁定规则，必须始终保留。' },
  { role: 'user', content: '旧的用户需求。'.repeat(70) },
  { role: 'assistant', content: '旧的模型回复。'.repeat(70) },
  { role: 'user', content: '最近需求。' },
  { role: 'assistant', content: '最近回复。' },
  { role: 'user', content: '创建人物，保留锁定字段。' },
]

test('the real request budgets the complete message list once and exposes only safe metrics', async (t) => {
  let sent
  const snapshots = []
  const unsubscribe = subscribeChatMetrics((value) => snapshots.push(value))
  t.after(unsubscribe)
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body)
    return Response.json({ ok: true, text: '结果', usage: { inputTokens: 91, outputTokens: 20, cachedInputTokens: 0 } })
  })
  const original = structuredClone(messages)
  const expected = prepareContextBudget(messages, request)
  await requestChat((path) => `http://local.test${path}`, { ...request, messages })
  assert.deepEqual(sent.messages, expected.messages)
  assert.deepEqual(messages, original)
  assert.equal(sent.messages[0].content, messages[0].content)
  assert.equal(sent.messages.at(-1).content, messages.at(-1).content)
  for (const key of ['providerId', 'purpose', 'contextTokens', 'historyTokens', 'signal']) assert.equal(key in sent, false)
  const final = snapshots.at(-1)
  assert.deepEqual(final.budget, expected.report)
  assert.equal(final.status, 'done')
  assert.equal(final.usage.cachedInputTokens, 0)
  assert.equal(final.usage.cacheWriteTokens, undefined)
  assert.equal(final.budget.trimmedMessages, 2)
  for (const snapshot of snapshots) {
    const json = JSON.stringify(snapshot)
    assert.equal(json.includes(request.apiKey), false)
    assert.equal(json.includes(request.baseUrl), false)
    assert.equal(json.includes(messages[0].content), false)
  }
})

test('oversized protected input stops locally and cannot send truncated JSON or protocol', async (t) => {
  let calls = 0
  const snapshots = []
  const unsubscribe = subscribeChatMetrics((value) => snapshots.push(value))
  t.after(unsubscribe)
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return Response.json({ text: '不应被发送' }) })
  await assert.rejects(requestChat((path) => path, {
    ...request, contextTokens: 1024, maxTokens: 128,
    messages: [
      { role: 'system', content: JSON.stringify({ schema: '不可截断的协议'.repeat(1000) }) },
      { role: 'user', content: '当前请求' },
    ],
  }), /必要输入超出上下文预算/)
  assert.equal(calls, 0)
  assert.equal(snapshots.at(-1).status, 'error')
})

test('stream usage snapshots merge known fields and final metrics never inherit prior requests', async (t) => {
  const snapshots = []
  const unsubscribe = subscribeChatMetrics((value) => snapshots.push(value))
  t.after(unsubscribe)
  t.mock.method(globalThis, 'fetch', async () => new Response([
    { type: 'usage', usage: { inputTokens: 55, cachedInputTokens: 0 } },
    { type: 'delta', text: '流式正文' },
    { type: 'usage', usage: { outputTokens: 20 } },
    { type: 'done' },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }))
  await requestChat((path) => path, { ...request, stream: true, messages: [messages[0], messages.at(-1)] })
  const final = snapshots.at(-1)
  assert.deepEqual(final.usage, { inputTokens: 55, cachedInputTokens: 0, outputTokens: 20 })
  assert.equal(final.budget.estimatedInputTokens, estimateMessageTokens([messages[0], messages.at(-1)]))
  t.mock.method(globalThis, 'fetch', async () => Response.json({ text: '没有用量数据' }))
  await requestChat((path) => path, { ...request, messages: [messages.at(-1)] })
  assert.equal(snapshots.at(-1).status, 'done')
  assert.equal(snapshots.at(-1).usage, undefined)
})
