import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyModelLimits } from '../src/api/applyModelLimits.ts'
import { defaultModelSettings, readModelSettings } from '../src/api/modelSettings.ts'

test('a larger server capacity preserves the current reply budget and unrelated settings', () => {
  const fields = Object.freeze({
    '上下文长度': '128000',
    '最大回复长度': '8192',
    '对话记忆预算': '32768',
    '温度': '0',
    'Top P': '0.9',
    '流式用量统计': 'false',
    '状态': '未配置',
    'API Key': 'unchanged-test-key',
  })
  const result = applyModelLimits(fields, { contextTokens: 1000000, maxOutputTokens: 65536 })
  assert.deepEqual(result.patch, { '上下文长度': '1000000' })
  assert.equal(result.maxTokens, 8192)
  assert.equal(result.replyReduced, false)
  assert.deepEqual(result.notices, [])
  const next = { ...fields, ...result.patch }
  for (const key of ['最大回复长度', '对话记忆预算', '温度', 'Top P', '流式用量统计', '状态', 'API Key']) {
    assert.equal(next[key], fields[key])
  }
})

test('missing or blank reply values use the existing default without persisting a new reply value', () => {
  for (const fields of [{}, { '最大回复长度': '' }, { '最大回复长度': '  ' }]) {
    const result = applyModelLimits(fields, { contextTokens: 128000, maxOutputTokens: 100000 })
    assert.equal(result.maxTokens, defaultModelSettings.maxTokens)
    assert.deepEqual(result.patch, { '上下文长度': '128000' })
    assert.equal(result.replyReduced, false)
  }
})

test('a smaller server output cap reduces replies without changing the memory budget', () => {
  const fields = { '最大回复长度': '8192', '对话记忆预算': '0', '状态': '已保存 · 可用' }
  const result = applyModelLimits(fields, { contextTokens: 128000, maxOutputTokens: 2048 })
  assert.deepEqual(result.patch, { '上下文长度': '128000', '最大回复长度': '2048' })
  assert.equal(result.replyReduced, true)
  assert.equal(result.maxTokens, 2048)
  assert.match(result.notices.join(' '), /服务器/)
  assert.equal(readModelSettings({ fields: { ...fields, ...result.patch } }).historyTokens, 0)
  assert.equal(fields['最大回复长度'], '8192')
})

test('a smaller context with enough input space keeps the existing reply budget', () => {
  const result = applyModelLimits({ '上下文长度': '128000', '最大回复长度': '8192' }, { contextTokens: 10000 })
  assert.deepEqual(result.patch, { '上下文长度': '10000' })
  assert.equal(result.replyReduced, false)
})

test('a context smaller than the reply reservation reduces it to a quarter window', () => {
  const fields = { '上下文长度': '128000', '最大回复长度': '8192', '对话记忆预算': '32768' }
  const original = structuredClone(fields)
  const result = applyModelLimits(fields, { contextTokens: 4096 })
  assert.deepEqual(result.patch, { '上下文长度': '4096', '最大回复长度': '1024' })
  assert.equal(result.maxTokens, 1024)
  assert.equal(result.replyReduced, true)
  assert.match(result.notices.join(' '), /输入资料/)
  const settings = readModelSettings({ fields: { ...fields, ...result.patch } })
  assert.equal(settings.historyTokens, 32768)
  assert.ok(settings.contextTokens - settings.maxTokens - Math.ceil(settings.contextTokens * 0.05) >= 1024)
  assert.deepEqual(fields, original)
})

test('positive but too-small input space also causes a conservative reply reduction', () => {
  const result = applyModelLimits({ '最大回复长度': '8192' }, { contextTokens: 9000 })
  assert.equal(result.maxTokens, 2250)
  assert.equal(result.replyReduced, true)
})

test('the minimum supported context retains input space and does not increase a small author reply budget', () => {
  const fallback = applyModelLimits({}, { contextTokens: 1024 })
  assert.equal(fallback.maxTokens, 256)
  assert.ok(1024 - fallback.maxTokens - Math.ceil(1024 * 0.05) >= 512)
  const small = applyModelLimits({ '最大回复长度': '128' }, { contextTokens: 1024, maxOutputTokens: 8192 })
  assert.equal(small.maxTokens, 128)
  assert.deepEqual(small.patch, { '上下文长度': '1024' })
})

test('a server output cap and small context enforce the stricter reply reservation', () => {
  const capped = applyModelLimits({ '最大回复长度': '8192' }, { contextTokens: 4096, maxOutputTokens: 512 })
  assert.equal(capped.maxTokens, 512)
  const smallWindow = applyModelLimits({ '最大回复长度': '8192' }, { contextTokens: 4096, maxOutputTokens: 3000 })
  assert.equal(smallWindow.maxTokens, 1024)
  assert.equal(smallWindow.notices.length, 2)
})

test('input-only capacity is used conservatively without adding output or changing memory', () => {
  const result = applyModelLimits(
    { '最大回复长度': '8192', '对话记忆预算': '32768' },
    { contextTokens: 32768, maxOutputTokens: 8192, maxInputTokens: 32768, contextKind: 'input_limit' },
  )
  assert.equal(result.patch['上下文长度'], '32768')
  assert.equal(result.patch['对话记忆预算'], undefined)
  assert.equal(readModelSettings({ fields: { ...result.patch } }).contextTokens, 32768)
})

test('a separate smaller input limit constrains local capacity while preserving author settings', () => {
  const fields = Object.freeze({
    '上下文长度': '128000', '最大回复长度': '8192', '对话记忆预算': '16000',
    '温度': '0.3', 'Top P': '0.9', '状态': '已保存 · 可用',
  })
  const metadata = Object.freeze({ contextTokens: 64000, maxInputTokens: 16384, maxOutputTokens: 8192 })
  const result = applyModelLimits(fields, metadata)
  assert.equal(result.contextTokens, 16384)
  assert.deepEqual(result.patch, { '上下文长度': '16384' })
  assert.equal(result.maxTokens, 8192)
  assert.equal(result.replyReduced, false)
  assert.match(result.notices.join(' '), /64,000.*16,384.*保守.*预留/)
  const next = { ...fields, ...result.patch }
  const settings = readModelSettings({ fields: next })
  const inputSpace = settings.contextTokens - settings.maxTokens - Math.max(32, Math.ceil(settings.contextTokens * 0.05))
  assert.ok(inputSpace > 0 && inputSpace <= metadata.maxInputTokens)
  assert.equal(metadata.contextTokens, 64000)
  for (const key of ['最大回复长度', '对话记忆预算', '温度', 'Top P', '状态']) {
    assert.equal(next[key], fields[key])
  }
})

test('a separate input cap cannot increase a smaller advertised total window', () => {
  const result = applyModelLimits({ '最大回复长度': '8192' }, {
    contextTokens: 32768, maxInputTokens: 64000, maxOutputTokens: 8192,
  })
  assert.equal(result.contextTokens, 32768)
  assert.deepEqual(result.patch, { '上下文长度': '32768' })
  assert.equal(result.replyReduced, false)
})

test('a small separate input limit retains reply and safety space without touching memory', () => {
  const fields = { '最大回复长度': '8192', '对话记忆预算': '16000', '状态': '未配置' }
  const result = applyModelLimits(fields, { contextTokens: 64000, maxInputTokens: 4096, maxOutputTokens: 8192 })
  assert.deepEqual(result.patch, { '上下文长度': '4096', '最大回复长度': '1024' })
  const settings = readModelSettings({ fields: { ...fields, ...result.patch } })
  assert.ok(settings.contextTokens - settings.maxTokens - Math.ceil(settings.contextTokens * 0.05) >= 1024)
  assert.equal(settings.historyTokens, 16000)
  assert.equal(fields['最大回复长度'], '8192')
  assert.equal(fields['状态'], '未配置')
})

test('invalid separate input limits reject the query without mutating the preset', () => {
  const fields = { '上下文长度': '128000', '最大回复长度': '8192', '对话记忆预算': '16000' }
  const original = structuredClone(fields)
  for (const maxInputTokens of [1023, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '16384', null, false]) {
    assert.throws(() => applyModelLimits(fields, { contextTokens: 64000, maxInputTokens }), /服务器返回的输入上限/)
    assert.deepEqual(fields, original)
  }
})

test('invalid server context values throw without changing the fields', () => {
  const fields = { '上下文长度': '128000', '最大回复长度': '8192' }
  const original = structuredClone(fields)
  for (const contextTokens of [1023, 0, -1, 1024.5, 10000001, Infinity, NaN, '4096', null, false]) {
    assert.throws(() => applyModelLimits(fields, { contextTokens }), /服务器返回的上下文长度/)
    assert.deepEqual(fields, original)
  }
})

test('invalid server output values are not silently accepted as missing data', () => {
  for (const maxOutputTokens of [0, -1, 1.5, 1000001, Infinity, NaN, '8192', null, false]) {
    assert.throws(() => applyModelLimits({}, { contextTokens: 128000, maxOutputTokens }), /服务器返回的最大回复长度/)
  }
})

test('invalid author reply values throw instead of silently replacing their settings', () => {
  for (const raw of ['0', '-1', '1.5', '1000001', 'NaN', 'bad']) {
    const fields = { '最大回复长度': raw }
    assert.throws(() => applyModelLimits(fields, { contextTokens: 4096 }), /当前最大回复长度/)
    assert.equal(fields['最大回复长度'], raw)
  }
})

test('an invalid old context can be repaired but invalid memory or sampling still fails full validation', () => {
  const fixed = applyModelLimits({ '上下文长度': 'bad', '最大回复长度': '256' }, { contextTokens: 4096 })
  assert.equal(fixed.patch['上下文长度'], '4096')
  for (const fields of [
    { '对话记忆预算': '-1' },
    { '温度': '3' },
    { '输出长度参数': 'unsupported' },
  ]) {
    const original = structuredClone(fields)
    assert.throws(() => applyModelLimits(fields, { contextTokens: 4096 }))
    assert.deepEqual(fields, original)
  }
})

test('the patch contains only the two token fields at all supported capacity boundaries', () => {
  for (const contextTokens of [1024, 1025, 2048, 8192, 9000, 10000, 128000, 10000000]) {
    for (const currentMaxTokens of [1, 128, 256, 8192, 1000000]) {
      for (const maxOutputTokens of [undefined, 1, 512, 1000000]) {
        const fields = { '最大回复长度': String(currentMaxTokens) }
        const result = applyModelLimits(fields, { contextTokens, maxOutputTokens })
        const settings = readModelSettings({ fields: { ...fields, ...result.patch } })
        const inputSpace = contextTokens - settings.maxTokens - Math.max(32, Math.ceil(contextTokens * 0.05))
        assert.ok(inputSpace >= Math.min(1024, Math.floor(contextTokens / 2)))
        assert.ok(settings.maxTokens <= currentMaxTokens)
        if (maxOutputTokens !== undefined) assert.ok(settings.maxTokens <= maxOutputTokens)
        assert.ok(Object.keys(result.patch).every((key) => ['上下文长度', '最大回复长度'].includes(key)))
      }
    }
  }
})
