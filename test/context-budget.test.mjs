import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  estimateMessageTokens,
  estimateTextTokens,
  prepareContextBudget,
} from '../src/api/contextBudget.ts'

const settings = { contextTokens: 4096, maxTokens: 512, historyTokens: 2048 }
const message = (role, content) => ({ role, content })

test('token estimates account for Chinese, ASCII word runs and complete Unicode code points', () => {
  assert.equal(estimateTextTokens(''), 0)
  assert.equal(estimateMessageTokens([]), 0)
  assert.ok(estimateTextTokens('中文测试') > estimateTextTokens('test'))
  assert.equal(estimateTextTokens('😀'), 4)
  assert.equal(estimateTextTokens('𠮷'), estimateTextTokens('汉'))
  assert.ok(estimateTextTokens('你好 world！🧙🏽‍♂️\n') > estimateTextTokens('world'))
  assert.ok(estimateTextTokens('👨‍👩‍👧‍👦') > estimateTextTokens('👨'))
  assert.ok(estimateTextTokens('e\u0301') > estimateTextTokens('e'))
  for (const text of ['ASCII name', '繁體中文', 'こんにちは', '한국어', '\uD83D', '🎉🚀']) {
    assert.ok(Number.isSafeInteger(estimateTextTokens(text)))
    assert.ok(estimateTextTokens(text) > 0)
  }
})

test('reports an explicit input estimate with output reservation and safety margin', () => {
  const messages = [message('system', '协议'), message('user', '当前需求')]
  const { report } = prepareContextBudget(messages, settings)
  assert.equal(report.estimated, true)
  assert.equal(report.contextTokens, settings.contextTokens)
  assert.equal(report.maxTokens, settings.maxTokens)
  assert.ok(report.safetyTokens > 0)
  assert.equal(report.inputBudget, report.contextTokens - report.maxTokens - report.safetyTokens)
  assert.equal(report.estimatedInputTokens, estimateMessageTokens(messages))
  assert.equal(report.remainingTokens, report.inputBudget - report.estimatedInputTokens)
  assert.equal(report.usedPercent, Math.round(report.estimatedInputTokens / report.contextTokens * 10000) / 100)
  assert.equal(report.historyTokensUsed, 0)
  assert.equal(report.trimmedMessages, 0)
})

test('keeps the full protocol and latest author request at the exact input budget boundary', () => {
  const protocol = `{"operations":{"type":"array"},"rules":"${'保持契约。'.repeat(20)}"}`
  const request = `  ${'按这些设定创建角色，姓名不要改。'.repeat(10)}\n`
  const messages = [message('system', protocol), message('user', request)]
  const contextTokens = 2048
  const safetyTokens = Math.ceil(contextTokens * 0.05)
  const requiredTokens = estimateMessageTokens(messages)
  const boundary = { contextTokens, maxTokens: contextTokens - safetyTokens - requiredTokens, historyTokens: 0 }

  const prepared = prepareContextBudget(messages, boundary)
  assert.deepEqual(prepared.messages, messages)
  assert.equal(prepared.report.remainingTokens, 0)
  assert.equal(prepared.messages[0].content, protocol)
  assert.equal(prepared.messages[1].content, request)
  assert.throws(() => prepareContextBudget([
    messages[0],
    message('user', `${request}再`),
  ], boundary), /必要输入超出上下文预算/)
})

test('keeps only the newest complete history rounds within the history token budget', () => {
  const oldRound = [message('user', '早期问题'), message('assistant', '早期回答')]
  const newestRound = [message('user', '最近问题'), message('assistant', '最近回答')]
  const required = [message('system', '当前协议'), message('user', '当前请求')]
  const original = [required[0], ...oldRound, ...newestRound, required[1]]
  const untouched = structuredClone(original)
  const prepared = prepareContextBudget(original, { ...settings, historyTokens: estimateMessageTokens(newestRound) })

  assert.deepEqual(prepared.messages, [required[0], ...newestRound, required[1]])
  assert.equal(prepared.report.historyTokensUsed, estimateMessageTokens(newestRound))
  assert.equal(prepared.report.trimmedMessages, 2)
  assert.deepEqual(original, untouched)
  assert.notEqual(prepared.messages, original)
  assert.notEqual(prepared.messages[0], original[0])
})

test('input capacity can trim additional old rounds even when the history allowance is large', () => {
  const oldRound = [message('user', '旧问题'), message('assistant', '旧回答')]
  const newestRound = [message('user', '最近问题'), message('assistant', '最近回答')]
  const required = [message('system', '协议'), message('user', '最新需求')]
  const contextTokens = 1024
  const safetyTokens = Math.ceil(contextTokens * 0.05)
  const inputBudget = estimateMessageTokens([...required, ...newestRound])
  const prepared = prepareContextBudget([required[0], ...oldRound, ...newestRound, required[1]], {
    contextTokens,
    maxTokens: contextTokens - safetyTokens - inputBudget,
    historyTokens: 10000,
  })

  assert.deepEqual(prepared.messages, [required[0], ...newestRound, required[1]])
  assert.equal(prepared.report.remainingTokens, 0)
  assert.equal(prepared.report.trimmedMessages, 2)
})

test('history budget zero excludes old turns while keeping every system and the latest request', () => {
  const original = [
    message('system', '固定契约一'),
    message('user', '过去请求'),
    message('system', '固定契约二'),
    message('assistant', '过去回复'),
    message('user', '当前请求'),
    message('system', '输出协议'),
  ]
  const prepared = prepareContextBudget(original, { ...settings, historyTokens: 0 })
  assert.deepEqual(prepared.messages, [original[0], original[2], original[4], original[5]])
  assert.equal(prepared.report.historyTokensUsed, 0)
  assert.equal(prepared.report.trimmedMessages, 2)
})

test('never injects orphan assistant replies or unfinished older user requests', () => {
  const current = message('user', '最新的明确请求')
  const prefilling = message('assistant', '{"message":')
  const prepared = prepareContextBudget([
    message('assistant', '欢迎提示，缺少历史问题'),
    message('user', '旧的未答问题'),
    message('system', '协议仍需保留'),
    message('user', '完整旧问题'),
    message('assistant', '完整旧回答'),
    current,
    prefilling,
  ], settings)
  assert.deepEqual(prepared.messages, [
    message('system', '协议仍需保留'),
    message('user', '完整旧问题'),
    message('assistant', '完整旧回答'),
    current,
    prefilling,
  ])
  assert.equal(prepared.report.trimmedMessages, 2)
})

test('does not skip an oversized newest round in order to inject unrelated earlier history', () => {
  const messages = [
    message('user', '小问题'),
    message('assistant', '小回复'),
    message('user', '很长的最近问题'.repeat(100)),
    message('assistant', '很长的最近回答'.repeat(100)),
    message('user', '当前需求'),
  ]
  const prepared = prepareContextBudget(messages, { ...settings, historyTokens: 100 })
  assert.deepEqual(prepared.messages, [messages.at(-1)])
  assert.equal(prepared.report.historyTokensUsed, 0)
  assert.equal(prepared.report.trimmedMessages, 4)
})

test('rejects mandatory oversize context instead of silently slicing protocol or author requirements', () => {
  const messages = [
    message('system', '{"protocol":"' + '绝不能裁断字段'.repeat(200) + '"}'),
    message('user', '创建完整角色卡'),
  ]
  const before = structuredClone(messages)
  assert.throws(() => prepareContextBudget(messages, { contextTokens: 1024, maxTokens: 128, historyTokens: 0 }), /协议和当前需求不会被截断/)
  assert.deepEqual(messages, before)
})

test('rejects invalid or fully reserved budgets with an actionable error', () => {
  assert.throws(() => prepareContextBudget([], { ...settings, historyTokens: -1 }), /非负整数/)
  assert.throws(() => prepareContextBudget([], { ...settings, contextTokens: NaN }), /整数/)
  assert.throws(() => prepareContextBudget([], { ...settings, maxTokens: 1.5 }), /整数/)
  assert.throws(() => prepareContextBudget([], { contextTokens: 1024, maxTokens: 1023, historyTokens: 0 }), /降低最大回复长度/)
})
