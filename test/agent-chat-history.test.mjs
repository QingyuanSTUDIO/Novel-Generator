import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentConversationMessageLimit,
  agentPersistedMessageLimit,
  buildAgentConversation,
  collectAgentConversation,
  normalizeAgentMessages,
  normalizeAgentActivities,
} from '../src/agent/chatHistory.ts'
import { estimateMessageTokens, prepareContextBudget } from '../src/api/contextBudget.ts'

test('normalizes persisted Agent messages and removes malformed entries', () => {
  const messages = normalizeAgentMessages([
    { id: 'ok', role: 'user', content: '你好', createdAt: 1 },
    { id: 'bad-role', role: 'tool', content: '不应保存', createdAt: 2 },
    { id: 'bad-content', role: 'assistant', content: 42, createdAt: 3 },
  ])
  assert.deepEqual(messages, [{ id: 'ok', role: 'user', content: '你好', createdAt: 1 }])
})

test('persists activity summaries with the reply and keeps them out of model messages', () => {
  const activities = [{ id: 'a-1', title: '创建角色', detail: '创建“林舟”', state: 'done', kind: 'tool', createdAt: 3 }]
  const messages = [
    { id: 'user', role: 'user', content: '创建林舟', createdAt: 1 },
    { id: 'reply', role: 'assistant', content: '已创建林舟。', activities, createdAt: 4 },
  ]
  const restored = normalizeAgentMessages(JSON.parse(JSON.stringify(messages)))
  assert.deepEqual(restored[1].activities, activities)
  const sent = buildAgentConversation(restored, '继续完善')
  assert.deepEqual(sent[1], { role: 'assistant', content: '已创建林舟。' })
  assert.equal(JSON.stringify(sent).includes('a-1'), false)
})

test('bounds saved activity records and discards malformed or unrecognized metadata', () => {
  const valid = { id: 'a-1', title: '检索上下文', detail: '读取世界书', state: 'done', createdAt: 1 }
  const normalized = normalizeAgentActivities([
    { ...valid, state: 'queued' },
    { ...valid, createdAt: Infinity },
    { ...valid, kind: 'secret', payload: { apiKey: 'should not be saved' } },
    { ...valid, id: 'a-2' },
  ], 1)
  assert.deepEqual(normalized, [valid])
  assert.equal(normalizeAgentActivities([valid], 0).length, 0)
})

test('sends prior user and Agent turns but excludes UI system messages', () => {
  const conversation = buildAgentConversation([
    { id: 'welcome', role: 'assistant', content: '我可以帮忙。', createdAt: 1 },
    { id: 'user-1', role: 'user', content: '先创建角色', createdAt: 2 },
    { id: 'assistant-1', role: 'assistant', content: '已生成计划。', createdAt: 3 },
    { id: 'error', role: 'system', content: '执行状态提示，不应发给模型', createdAt: 4 },
    { id: 'user-2', role: 'user', content: '继续完善', createdAt: 5 },
  ], '继续完善')
  assert.deepEqual(conversation, [
    { role: 'user', content: '先创建角色' },
    { role: 'assistant', content: '已生成计划。' },
    { role: 'user', content: '继续完善' },
  ])
})

test('preserves an explicitly requested legacy message-count limit without duplicating the current prompt', () => {
  const messages = Array.from({ length: agentConversationMessageLimit + 5 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `消息 ${index}`,
    createdAt: index,
  }))
  const conversation = buildAgentConversation(messages, `消息 ${agentConversationMessageLimit + 4}`, agentConversationMessageLimit)
  assert.equal(conversation.length, agentConversationMessageLimit)
  assert.equal(conversation.at(-1)?.content, `消息 ${agentConversationMessageLimit + 4}`)
})

test('model-budget conversations retain more than 24 messages when they fit', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `历史消息 ${index}`,
    createdAt: index,
  }))
  const before = structuredClone(messages)
  const conversation = buildAgentConversation(messages, '最新需求', {
    contextTokens: 128000, maxTokens: 8192, historyTokens: 32768,
  })
  assert.equal(conversation.length, 41)
  assert.equal(conversation.at(-1).content, '最新需求')
  assert.deepEqual(messages, before)
})

test('never clips long history content or the latest author request at 4000 characters', () => {
  const longHistory = '完整历史设定。'.repeat(700)
  const currentPrompt = `  ${'保留这项作者需求。'.repeat(700)}\n`
  const conversation = buildAgentConversation([
    { id: 'user-1', role: 'user', content: longHistory, createdAt: 1 },
    { id: 'reply-1', role: 'assistant', content: '收到完整设定。', createdAt: 2 },
    { id: 'current', role: 'user', content: currentPrompt, createdAt: 3 },
  ], currentPrompt, { contextTokens: 128000, maxTokens: 8192, historyTokens: 32768 })
  assert.equal(conversation.length, 3)
  assert.equal(conversation[0].content, longHistory)
  assert.equal(conversation.at(-1).content, currentPrompt)
  assert.equal(conversation.filter((entry) => entry.content === currentPrompt).length, 1)
  assert.doesNotMatch(JSON.stringify(conversation), /聊天记录已截断/)
})

test('zero model history budget sends only the full current prompt and preserves saved transcript activities', () => {
  const activities = [{ id: 'saved-tool-log', title: '编辑资料', state: 'done', createdAt: 3 }]
  const messages = [
    { id: 'old-user', role: 'user', content: '旧需求', createdAt: 1 },
    { id: 'old-agent', role: 'assistant', content: '旧回复', activities, createdAt: 2 },
    { id: 'status', role: 'system', content: '执行状态', createdAt: 3 },
  ]
  const before = structuredClone(messages)
  const prompt = '  当前需求必须原样保留。\n'
  const conversation = buildAgentConversation(messages, prompt, {
    contextTokens: 1024, maxTokens: 128, historyTokens: 0,
  })
  assert.deepEqual(conversation, [{ role: 'user', content: prompt }])
  assert.deepEqual(messages, before)
  assert.deepEqual(normalizeAgentMessages(messages)[1].activities, activities)
  assert.equal(JSON.stringify(conversation).includes('saved-tool-log'), false)
})

test('model history trimming keeps a complete newest question/reply round instead of isolated messages', () => {
  const newestRound = [{ role: 'user', content: '最近问题' }, { role: 'assistant', content: '最近回复' }]
  const messages = [
    { id: 'orphan', role: 'assistant', content: '无对应问题的 UI 开场', createdAt: 0 },
    { id: 'user-1', role: 'user', content: '早期问题', createdAt: 1 },
    { id: 'reply-1', role: 'assistant', content: '早期回复', createdAt: 2 },
    { id: 'user-2', ...newestRound[0], createdAt: 3 },
    { id: 'reply-2', ...newestRound[1], createdAt: 4 },
  ]
  const conversation = buildAgentConversation(messages, '最新问题', {
    contextTokens: 1024, maxTokens: 128, historyTokens: estimateMessageTokens(newestRound),
  })
  assert.deepEqual(conversation, [...newestRound, { role: 'user', content: '最新问题' }])
  assert.equal(messages.length, 5)
})

test('an oversized current request is rejected explicitly rather than shortened', () => {
  const prompt = '完整作者要求'.repeat(500)
  assert.throws(() => buildAgentConversation([], prompt, {
    contextTokens: 1024, maxTokens: 128, historyTokens: 0,
  }), /当前需求不会被截断/)
})

test('saving and restoring a conversation keeps more than 100 messages independently of model memory', () => {
  const messages = Array.from({ length: 180 }, (_, index) => ({
    id: `persistent-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `持久化消息 ${index}`,
    createdAt: index,
  }))
  const saved = normalizeAgentMessages(messages, agentPersistedMessageLimit)
  const restored = normalizeAgentMessages(JSON.parse(JSON.stringify(saved)), agentPersistedMessageLimit)
  assert.equal(saved.length, 180)
  assert.deepEqual(restored, messages)
  assert.equal(restored[0].id, 'persistent-0')

  const request = buildAgentConversation(restored, '只发送本次需求', {
    contextTokens: 1024, maxTokens: 128, historyTokens: 0,
  })
  assert.deepEqual(request, [{ role: 'user', content: '只发送本次需求' }])
  assert.deepEqual(normalizeAgentMessages(restored), messages)
  // An explicitly requested limit remains possible for defensive callers; it
  // is no longer the default behavior used for transcript persistence.
  assert.equal(normalizeAgentMessages(restored, 5).length, 5)
})

test('collects raw conversation so one combined budget reports all history trimming accurately', () => {
  const latestRound = [{ role: 'user', content: '最近问题' }, { role: 'assistant', content: '最近回答' }]
  const messages = [
    { id: 'welcome', role: 'assistant', content: '界面欢迎提示', createdAt: 0 },
    { id: 'u-1', role: 'user', content: '早期问题一', createdAt: 1 },
    { id: 'a-1', role: 'assistant', content: '早期回答一', createdAt: 2 },
    { id: 'ui-status', role: 'system', content: '界面错误提示', createdAt: 3 },
    { id: 'u-2', role: 'user', content: '早期问题二', createdAt: 4 },
    { id: 'a-2', role: 'assistant', content: '早期回答二', createdAt: 5 },
    { id: 'u-3', ...latestRound[0], createdAt: 6 },
    { id: 'a-3', ...latestRound[1], createdAt: 7 },
  ]
  const raw = collectAgentConversation(messages, '当前需求')
  assert.equal(raw.length, 7)
  assert.equal(raw[0].content, '早期问题一')
  assert.equal(raw.at(-1).content, '当前需求')

  const protocol = { role: 'system', content: '完整Agent契约与世界书资料' }
  const prepared = prepareContextBudget([protocol, ...raw], {
    contextTokens: 1024, maxTokens: 128, historyTokens: estimateMessageTokens(latestRound),
  })
  assert.deepEqual(prepared.messages, [protocol, ...latestRound, { role: 'user', content: '当前需求' }])
  assert.equal(prepared.report.trimmedMessages, 4)
  assert.equal(prepared.report.historyTokensUsed, estimateMessageTokens(latestRound))
  assert.equal(messages.length, 8)
})

test('raw collection preserves an oversized current request until the complete-request budget checks it', () => {
  const prompt = '  ' + '作者完整需求'.repeat(900) + '\n'
  const raw = collectAgentConversation([
    { id: 'current', role: 'user', content: prompt, createdAt: 1 },
  ], prompt)
  assert.deepEqual(raw, [{ role: 'user', content: prompt }])
  assert.throws(() => prepareContextBudget(raw, {
    contextTokens: 1024, maxTokens: 128, historyTokens: 0,
  }), /当前需求不会被截断/)
})
