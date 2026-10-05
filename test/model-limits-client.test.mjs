import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectScope, ref } from 'vue'
import { useModelLimits } from '../src/composables/useModelLimits.ts'

const baseFields = {
  '接口地址': 'https://relay.test/v1', 'API Key': 'test-only-key', '模型': 'chosen-model',
  '协议': 'OpenAI Compatible', '使用代理': 'true', '代理地址': '127.0.0.1', '代理端口': '7890',
  '上下文长度': '128000', '最大回复长度': '8192', '对话记忆预算': '16000',
  '温度': '0.3', '状态': '已保存 · 可用',
}

function harness(t) {
  const scope = effectScope()
  const provider = ref({ id: 'preset-1', title: '测试预设', tag: '', summary: '', fields: { ...baseFields } })
  let saves = 0
  const controller = scope.run(() => useModelLimits({
    provider, localApiUrl: (path) => `http://local.test${path}`, persist: () => { saves += 1 },
  }))
  t.after(() => scope.stop())
  return { provider, controller, saves: () => saves, scope }
}

function mockPending(t) {
  const pending = []
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve) => {
    pending.push({ url, options, resolve, input: JSON.parse(options.body) })
  }))
  return pending
}

const limitsResponse = (extra = {}) => Response.json({
  ok: true, model: 'chosen-model', contextTokens: 64000, maxOutputTokens: 32000,
  contextKind: 'context_window', message: '读取到所选模型容量。', ...extra,
})

test('requests the selected relay/model/proxy and persists only capacity with a conservative reply budget', async (t) => {
  const h = harness(t)
  const pending = mockPending(t)
  const run = h.controller.fetchLimits()
  assert.equal(h.controller.busy.value, true)
  assert.equal(pending[0].url, 'http://local.test/api/proxy/model-limits')
  assert.deepEqual(pending[0].input, {
    baseUrl: baseFields['接口地址'], model: 'chosen-model', apiKey: 'test-only-key',
    protocol: 'OpenAI Compatible', useProxy: true, proxyHost: '127.0.0.1', proxyPort: '7890',
  })
  pending[0].resolve(limitsResponse())
  await run
  assert.equal(h.provider.value.fields['上下文长度'], '64000')
  for (const key of ['最大回复长度', '对话记忆预算', '温度', '状态', '模型', 'API Key']) {
    assert.equal(h.provider.value.fields[key], baseFields[key])
  }
  assert.equal(h.saves(), 1)
  assert.equal(h.controller.busy.value, false)
})

test('missing context metadata keeps every configured value instead of guessing a window', async (t) => {
  const h = harness(t)
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    ok: true, model: 'chosen-model', maxOutputTokens: 8192, message: '接口未提供上下文上限。',
  }))
  await h.controller.fetchLimits()
  assert.deepEqual(h.provider.value.fields, baseFields)
  assert.equal(h.saves(), 0)
  assert.match(h.controller.message.value, /未提供/)
})

test('an input-only limit is clearly identified and never added to the output cap', async (t) => {
  const h = harness(t)
  t.mock.method(globalThis, 'fetch', async () => limitsResponse({
    contextTokens: 4096, maxInputTokens: 4096, maxOutputTokens: 2048, contextKind: 'input_limit',
  }))
  await h.controller.fetchLimits()
  assert.equal(h.provider.value.fields['上下文长度'], '4096')
  assert.equal(h.provider.value.fields['最大回复长度'], '2048')
  assert.match(h.controller.message.value, /输入上限/)
  assert.match(h.controller.message.value, /保守/)
  assert.equal(h.provider.value.fields['状态'], baseFields['状态'])
})

test('separate input metadata uses the stricter local budget and reports the actual applied number', async (t) => {
  const h = harness(t)
  const metadata = {
    contextTokens: 64000, maxInputTokens: 16384, maxOutputTokens: 8192, contextKind: 'context_window',
  }
  t.mock.method(globalThis, 'fetch', async () => limitsResponse(metadata))
  await h.controller.fetchLimits()
  assert.equal(h.provider.value.fields['上下文长度'], '16384')
  assert.equal(h.provider.value.fields['最大回复长度'], '8192')
  assert.match(h.controller.message.value, /已填入 16,384 Token/)
  assert.match(h.controller.message.value, /上下文总量为 64,000 Token/)
  assert.match(h.controller.message.value, /独立输入上限/)
  assert.match(h.controller.message.value, /保守.*预留/)
  assert.doesNotMatch(h.controller.message.value, /已填入 64,000 Token/)
  assert.equal(h.controller.error.value, '')
  assert.equal(h.saves(), 1)
  assert.equal(metadata.contextTokens, 64000)
  for (const key of ['对话记忆预算', '温度', '状态', '模型', 'API Key']) {
    assert.equal(h.provider.value.fields[key], baseFields[key])
  }
})

test('a strict independent input cap still preserves budgets edited while lookup is pending', async (t) => {
  const h = harness(t)
  const pending = mockPending(t)
  const run = h.controller.fetchLimits()
  h.provider.value.fields['上下文长度'] = '12000'
  h.provider.value.fields['最大回复长度'] = '1024'
  pending[0].resolve(limitsResponse({ contextTokens: 64000, maxInputTokens: 16384 }))
  await run
  assert.equal(h.provider.value.fields['上下文长度'], '12000')
  assert.equal(h.provider.value.fields['最大回复长度'], '1024')
  assert.match(h.controller.message.value, /保留修改/)
  assert.match(h.controller.message.value, /独立输入上限.*16,384/)
  assert.equal(h.saves(), 0)
})

test('switching presets rejects a stale result even after switching back', async (t) => {
  const h = harness(t)
  const pending = mockPending(t)
  const original = h.provider.value
  const oldRun = h.controller.fetchLimits()
  h.provider.value = { ...original, id: 'preset-2', fields: { ...baseFields } }
  h.provider.value = original
  assert.equal(pending[0].options.signal.aborted, true)
  const newRun = h.controller.fetchLimits()
  pending[1].resolve(limitsResponse({ contextTokens: 48000 }))
  await newRun
  pending[0].resolve(limitsResponse({ contextTokens: 32000 }))
  await oldRun
  assert.equal(h.provider.value.fields['上下文长度'], '48000')
  assert.equal(h.saves(), 1)
})

test('restoring cloned global presets while switching works cannot patch the detached previous object', async (t) => {
  const h = harness(t)
  const pending = mockPending(t)
  const previous = h.provider.value
  const run = h.controller.fetchLimits()
  h.provider.value = JSON.parse(JSON.stringify(previous))
  assert.equal(pending[0].options.signal.aborted, true)
  pending[0].resolve(limitsResponse())
  await run
  assert.equal(previous.fields['上下文长度'], '128000')
  assert.equal(h.provider.value.fields['上下文长度'], '128000')
  assert.equal(h.saves(), 0)
})

test('editing query configuration cancels old requests without changing validation status', async (t) => {
  const h = harness(t)
  const pending = mockPending(t)
  for (const [key, value] of [
    ['模型', 'other-model'], ['接口地址', 'https://other-relay.test/v1'], ['协议', 'Google Gemini'],
    ['API Key', 'another-test-key'], ['使用代理', 'false'], ['代理端口', '7891'],
  ]) {
    const run = h.controller.fetchLimits()
    const current = pending.at(-1)
    h.provider.value.fields[key] = value
    assert.equal(current.options.signal.aborted, true)
    current.resolve(limitsResponse())
    await run
    assert.equal(h.provider.value.fields['上下文长度'], '128000')
    assert.equal(h.provider.value.fields['状态'], baseFields['状态'])
  }
  assert.equal(h.saves(), 0)
})

test('manual budget edits during lookup stay intact', async (t) => {
  const h = harness(t)
  const pending = mockPending(t)
  const run = h.controller.fetchLimits()
  h.provider.value.fields['上下文长度'] = '96000'
  h.provider.value.fields['最大回复长度'] = '4096'
  pending[0].resolve(limitsResponse())
  await run
  assert.equal(h.provider.value.fields['上下文长度'], '96000')
  assert.equal(h.provider.value.fields['最大回复长度'], '4096')
  assert.match(h.controller.message.value, /保留修改/)
  assert.equal(h.saves(), 0)
})

test('duplicate clicks, errors and mismatched models never partially overwrite settings', async (t) => {
  const h = harness(t)
  const pending = mockPending(t)
  const run = h.controller.fetchLimits()
  await h.controller.fetchLimits()
  assert.equal(pending.length, 1)
  pending[0].resolve(limitsResponse({ model: 'wrong-model' }))
  await run
  assert.equal(h.controller.busy.value, false)
  assert.match(h.controller.error.value, /模型.*不同/)
  assert.deepEqual(h.provider.value.fields, baseFields)
  const retry = h.controller.fetchLimits()
  pending[1].resolve(Response.json({ ok: false, error: '认证失败' }, { status: 401 }))
  await retry
  assert.match(h.controller.error.value, /认证失败/)
  assert.equal(h.controller.busy.value, false)
  assert.deepEqual(h.provider.value.fields, baseFields)
})

test('invalid capacity or local validation failure preserves the complete preset', async (t) => {
  const h = harness(t)
  t.mock.method(globalThis, 'fetch', async () => limitsResponse({ contextTokens: 64 }))
  await h.controller.fetchLimits()
  assert.ok(h.controller.error.value)
  assert.deepEqual(h.provider.value.fields, baseFields)
  assert.equal(h.saves(), 0)
})

test('disposing aborts a query and ignores transport implementations that deliver a late result', async (t) => {
  const h = harness(t)
  const pending = mockPending(t)
  const run = h.controller.fetchLimits()
  h.scope.stop()
  assert.equal(pending[0].options.signal.aborted, true)
  pending[0].resolve(limitsResponse())
  await run
  assert.deepEqual(h.provider.value.fields, baseFields)
  assert.equal(h.saves(), 0)
})
