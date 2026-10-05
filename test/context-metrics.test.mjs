import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectScope, ref } from 'vue'
import { useContextMetrics } from '../src/composables/useContextMetrics.ts'
import { nextChatMetricsId, publishChatMetrics } from '../src/api/chatMetrics.ts'
import { estimateMessageTokens, prepareContextBudget } from '../src/api/contextBudget.ts'
import { collectAgentConversation } from '../src/agent/chatHistory.ts'

function createMetricsView(t, overrides = {}) {
  const provider = ref({
    id: 'metrics-provider',
    title: '测试 API',
    fields: {
      '模型': 'metrics-model',
      '协议': 'OpenAI Compatible',
      '接口地址': 'http://unused.invalid/v1',
      '上下文长度': '4096',
      '最大回复长度': '512',
      '对话记忆预算': '2048',
    },
  })
  const scopeKey = ref('project-1:conversation-1')
  const messages = ref([
    { role: 'system', content: '完整协议' },
    { role: 'user', content: '当前需求' },
  ])
  const scope = effectScope()
  const view = scope.run(() => useContextMetrics({
    provider,
    scopeKey,
    purposes: ['agent', 'writer'],
    messages: overrides.messages ?? (() => messages.value),
  }))
  t.after(() => scope.stop())
  return { view, scope, provider, scopeKey, messages }
}

function requestEvent(provider, changes = {}) {
  return {
    requestId: nextChatMetricsId(),
    startedAt: Date.now(),
    providerId: provider.value.id,
    purpose: 'agent',
    model: provider.value.fields['模型'],
    status: 'running',
    budget: prepareContextBudget(
      [{ role: 'system', content: '请求协议' }, { role: 'user', content: '请求快照' }],
      { contextTokens: 4096, maxTokens: 512, historyTokens: 2048 },
    ).report,
    ...changes,
  }
}

test('scope switches clear statistics and ignore a previously started request even after returning to its scope', (t) => {
  const { view, provider, scopeKey } = createMetricsView(t)
  const old = requestEvent(provider)
  publishChatMetrics(old)
  assert.equal(view.latest.value.requestId, old.requestId)
  assert.equal(view.status.value, 'running')

  scopeKey.value = 'project-2:conversation-2'
  assert.equal(view.latest.value, null)
  assert.equal(view.usage.value, null)
  assert.equal(view.status.value, 'preview')
  scopeKey.value = 'project-1:conversation-1'
  publishChatMetrics({ ...old, status: 'running', usage: { inputTokens: 88, outputTokens: 12 } })
  assert.equal(view.latest.value, null)
  assert.equal(view.usage.value, null)
  publishChatMetrics({ ...old, status: 'done', usage: { inputTokens: 88, outputTokens: 12 } })
  assert.equal(view.latest.value, null)
  assert.equal(view.usage.value, null)

  const current = requestEvent(provider)
  publishChatMetrics(current)
  publishChatMetrics({ ...current, status: 'done', usage: { inputTokens: 4, outputTokens: 5 } })
  assert.equal(view.latest.value.requestId, current.requestId)
  assert.deepEqual(view.usage.value, { inputTokens: 4, outputTokens: 5 })
})

test('switching providers and returning cannot revive the old provider response', (t) => {
  const { view, provider } = createMetricsView(t)
  const originalProvider = provider.value
  const old = requestEvent(provider)
  publishChatMetrics(old)
  provider.value = { ...originalProvider, id: 'other-provider' }
  assert.equal(view.latest.value, null)
  publishChatMetrics({ ...old, status: 'done', usage: { inputTokens: 999 } })
  assert.equal(view.latest.value, null)

  provider.value = originalProvider
  publishChatMetrics({ ...old, status: 'running', usage: { inputTokens: 999 } })
  assert.equal(view.latest.value, null)
  publishChatMetrics({ ...old, status: 'done', usage: { inputTokens: 999 } })
  assert.equal(view.latest.value, null)
  assert.equal(view.usage.value, null)
})

for (const field of ['模型', '协议', '接口地址']) {
  test(`changing ${field} on the same preset invalidates pending statistics`, (t) => {
    const { view, provider } = createMetricsView(t)
    const old = requestEvent(provider)
    publishChatMetrics(old)
    provider.value.fields[field] = `${provider.value.fields[field]}-changed`
    assert.equal(view.latest.value, null)
    publishChatMetrics({ ...old, status: 'running', usage: { inputTokens: 123 } })
    assert.equal(view.latest.value, null)
    publishChatMetrics({ ...old, status: 'done', usage: { inputTokens: 123 } })
    assert.equal(view.latest.value, null)
    assert.equal(view.usage.value, null)
  })
}

test('mounting during an existing request ignores its later running usage and completion events', (t) => {
  const old = requestEvent({ value: { id: 'metrics-provider', fields: { '模型': 'metrics-model' } } })
  publishChatMetrics(old)
  const { view, provider } = createMetricsView(t)
  publishChatMetrics({ ...old, status: 'running', usage: { inputTokens: 456 } })
  publishChatMetrics({ ...old, status: 'done', usage: { inputTokens: 456 } })
  assert.equal(view.latest.value, null)
  assert.equal(view.usage.value, null)

  const current = requestEvent(provider)
  publishChatMetrics(current)
  assert.equal(view.latest.value.requestId, current.requestId)
})

test('switching to a provider ignores requests it started before the switch', (t) => {
  const { view, provider } = createMetricsView(t)
  const otherProvider = { ...provider.value, id: 'other-provider' }
  const old = requestEvent({ value: otherProvider })
  publishChatMetrics(old)
  assert.equal(view.latest.value, null)
  provider.value = otherProvider
  publishChatMetrics({ ...old, status: 'running', usage: { inputTokens: 789 } })
  publishChatMetrics({ ...old, status: 'done', usage: { inputTokens: 789 } })
  assert.equal(view.latest.value, null)
  assert.equal(view.usage.value, null)

  const current = requestEvent(provider)
  publishChatMetrics(current)
  publishChatMetrics({ ...current, status: 'done', usage: { inputTokens: 6 } })
  assert.deepEqual(view.usage.value, { inputTokens: 6 })
})

test('a new request without usage clears the previous statistics instead of borrowing them', (t) => {
  const { view, provider } = createMetricsView(t)
  const previous = requestEvent(provider)
  publishChatMetrics(previous)
  publishChatMetrics({ ...previous, status: 'done', usage: { inputTokens: 40, outputTokens: 10, cachedInputTokens: 0 } })
  assert.equal(view.usage.value.inputTokens, 40)
  assert.equal(view.usage.value.cachedInputTokens, 0)

  const next = requestEvent(provider)
  publishChatMetrics(next)
  assert.equal(view.usage.value, null)
  publishChatMetrics({ ...next, status: 'done' })
  assert.equal(view.status.value, 'done')
  assert.equal(view.usage.value, null)
  assert.equal(view.latest.value.requestId, next.requestId)

  const failed = requestEvent(provider)
  publishChatMetrics(failed)
  publishChatMetrics({ ...failed, status: 'error' })
  assert.equal(view.status.value, 'error')
  assert.equal(view.usage.value, null)
})

for (const completionOrder of ['older-first', 'newer-first']) {
  test(`concurrent completions (${completionOrder}) only retain the newest started request`, (t) => {
    const { view, provider } = createMetricsView(t)
    const older = requestEvent(provider)
    const newer = requestEvent(provider)
    publishChatMetrics(older)
    publishChatMetrics(newer)
    assert.equal(view.latest.value.requestId, newer.requestId)
    const oldDone = { ...older, status: 'done', usage: { inputTokens: 10 } }
    const newDone = { ...newer, status: 'done', usage: { inputTokens: 20 } }

    publishChatMetrics(completionOrder === 'older-first' ? oldDone : newDone)
    assert.equal(view.latest.value.requestId, newer.requestId)
    assert.equal(view.status.value, completionOrder === 'older-first' ? 'running' : 'done')
    assert.deepEqual(view.usage.value, completionOrder === 'older-first' ? null : { inputTokens: 20 })
    publishChatMetrics(completionOrder === 'older-first' ? newDone : oldDone)
    assert.equal(view.latest.value.requestId, newer.requestId)
    assert.deepEqual(view.usage.value, { inputTokens: 20 })
  })
}

test('preview includes protocol and current request, trims full old rounds, and keeps the saved conversation', (t) => {
  const transcript = [
    { id: 'u-1', role: 'user', content: '早期问题', createdAt: 1 },
    { id: 'a-1', role: 'assistant', content: '早期回答', createdAt: 2 },
    { id: 'u-2', role: 'user', content: '近期问题', createdAt: 3 },
    { id: 'a-2', role: 'assistant', content: '近期回答', createdAt: 4 },
  ]
  const original = structuredClone(transcript)
  const protocol = { role: 'system', content: '{"operations":[{"type":"角色卡","fields":{"姓名":"不能截断"}}]}' }
  const current = { role: 'user', content: '  新建角色，完整保留这些作者要求。\n' }
  const recentRound = [{ role: 'user', content: '近期问题' }, { role: 'assistant', content: '近期回答' }]
  const { view, provider } = createMetricsView(t, {
    messages: () => [protocol, ...collectAgentConversation(transcript, current.content)],
  })
  provider.value.fields['对话记忆预算'] = String(estimateMessageTokens(recentRound))

  assert.equal(view.error.value, '')
  assert.equal(view.status.value, 'preview')
  assert.equal(view.budgetLabel.value, '当前输入上下文预算')
  assert.equal(view.budget.value.estimatedInputTokens, estimateMessageTokens([protocol, ...recentRound, current]))
  assert.equal(view.budget.value.historyTokensUsed, estimateMessageTokens(recentRound))
  assert.equal(view.budget.value.trimmedMessages, 2)
  assert.deepEqual(transcript, original)
})

test('the running budget is a request snapshot and returns to a fresh preview after completion', (t) => {
  const { view, provider, messages } = createMetricsView(t)
  const running = requestEvent(provider)
  publishChatMetrics(running)
  messages.value = [{ role: 'system', content: '新协议资料'.repeat(50) }, { role: 'user', content: '当前编辑需求' }]
  assert.equal(view.budget.value.estimatedInputTokens, running.budget.estimatedInputTokens)
  assert.equal(view.budgetLabel.value, '本次请求上下文预算')

  publishChatMetrics({ ...running, status: 'done', usage: { inputTokens: 11, outputTokens: 22 } })
  assert.equal(view.budgetLabel.value, '当前输入上下文预算')
  assert.equal(view.budget.value.estimatedInputTokens, estimateMessageTokens(messages.value))
  assert.deepEqual(view.usage.value, { inputTokens: 11, outputTokens: 22 })
})

test('preview errors become a display message without throwing through Vue and recover when inputs become valid', (t) => {
  const fail = ref(true)
  const { view, provider } = createMetricsView(t, {
    messages: () => {
      if (fail.value) throw new Error('资料暂未就绪')
      return [{ role: 'system', content: '协议' }, { role: 'user', content: '请求' }]
    },
  })
  assert.doesNotThrow(() => view.budget.value)
  assert.equal(view.budget.value, null)
  assert.equal(view.error.value, '资料暂未就绪')

  fail.value = false
  assert.ok(view.budget.value)
  assert.equal(view.error.value, '')
  provider.value.fields['上下文长度'] = '1024'
  provider.value.fields['最大回复长度'] = '1024'
  assert.doesNotThrow(() => view.budget.value)
  assert.equal(view.budget.value, null)
  assert.match(view.error.value, /最大回复长度/)
})

test('unrelated purposes, providers and completion-only events never populate this panel', (t) => {
  const { view, provider } = createMetricsView(t)
  const wrongPurpose = requestEvent(provider, { purpose: 'meme-search' })
  const wrongProvider = requestEvent(provider, { providerId: 'different-provider' })
  const neverStartedHere = requestEvent(provider, { status: 'done', usage: { inputTokens: 333 } })
  publishChatMetrics(wrongPurpose)
  publishChatMetrics(wrongProvider)
  publishChatMetrics(neverStartedHere)
  assert.equal(view.latest.value, null)
  assert.equal(view.usage.value, null)
})

test('disposing the metrics scope unsubscribes from later response events', (t) => {
  const { view, scope, provider } = createMetricsView(t)
  const active = requestEvent(provider)
  publishChatMetrics(active)
  const snapshot = view.latest.value
  scope.stop()
  publishChatMetrics({ ...active, status: 'done', usage: { inputTokens: 500 } })
  publishChatMetrics(requestEvent(provider))
  assert.equal(view.latest.value, snapshot)
  assert.equal(view.status.value, 'running')
  assert.equal(view.usage.value, null)
})
