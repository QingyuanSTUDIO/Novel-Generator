import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultModelSettings, readModelSettings } from '../src/api/modelSettings.ts'

const preset = (fields = {}) => ({ fields })

test('default context budget is 272k tokens', () => {
  assert.equal(defaultModelSettings.contextTokens, 272000)
  assert.equal(readModelSettings(preset()).contextTokens, 272000)
})

test('unset sampling values stay omitted and token budgets have explicit defaults', () => {
  assert.deepEqual(readModelSettings(preset()), defaultModelSettings)
  assert.deepEqual(readModelSettings(preset({ '温度': '', 'Top P': ' ' })), defaultModelSettings)
})

test('custom settings preserve numeric zero and negative penalties', () => {
  const settings = readModelSettings(preset({
    '上下文长度': '16000', '最大回复长度': '1000', '对话记忆预算': '0',
    '温度': '0', 'Top P': '0.88', '频率惩罚': '-0.5', '存在惩罚': '0',
    '输出长度参数': 'max_completion_tokens', '流式用量统计': 'false',
  }))
  assert.equal(settings.historyTokens, 0)
  assert.equal(settings.temperature, 0)
  assert.equal(settings.frequencyPenalty, -0.5)
  assert.equal(settings.presencePenalty, 0)
  assert.equal(settings.outputTokenParameter, 'max_completion_tokens')
  assert.equal(settings.includeUsage, false)
})

test('Anthropic ignores saved penalties without deleting them and validates its own temperature range', () => {
  const provider = preset({ '协议': 'Anthropic', '温度': '1', '频率惩罚': '0.7', '存在惩罚': '1' })
  const settings = readModelSettings(provider)
  assert.equal(settings.temperature, 1)
  assert.equal(settings.frequencyPenalty, undefined)
  assert.equal(settings.presencePenalty, undefined)
  assert.equal(provider.fields['频率惩罚'], '0.7')
  provider.fields['协议'] = 'OpenAI Compatible'
  assert.equal(readModelSettings(provider).frequencyPenalty, 0.7)
  assert.throws(() => readModelSettings(preset({ '协议': 'Anthropic', '温度': '1.5' })), /温度/)
})

test('invalid ranges and exhausted input windows fail before any request is sent', () => {
  for (const fields of [
    { '上下文长度': '500' }, { '最大回复长度': '1.5' }, { '对话记忆预算': '-1' },
    { '温度': 'NaN' }, { '温度': '3' }, { 'Top P': '1.1' },
    { '频率惩罚': '-2.1' }, { '存在惩罚': '3' }, { '输出长度参数': 'other' },
    { '上下文长度': '1024', '最大回复长度': '1000' },
  ]) assert.throws(() => readModelSettings(preset(fields)))
})
