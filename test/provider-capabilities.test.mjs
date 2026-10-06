import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getProviderCapabilities,
  normalizeProviderProtocol,
  providerParameterStatus,
  providerSupportsParameter,
} from '../src/api/providerCapabilities.ts'
import { readModelSettings } from '../src/api/modelSettings.ts'

const preset = (fields = {}) => ({ fields })

test('provider capability matrix exposes native and unsupported generation fields', () => {
  assert.equal(providerParameterStatus('Anthropic', 'frequencyPenalty'), 'unsupported')
  assert.equal(providerParameterStatus('Anthropic', 'includeUsage'), 'automatic')
  assert.equal(providerParameterStatus('Google Gemini', 'includeUsage'), 'automatic')
  assert.equal(providerSupportsParameter('Google Gemini', 'frequencyPenalty'), true)
  assert.equal(providerSupportsParameter('OpenAI Compatible', 'outputTokenParameter'), true)
  assert.equal(providerSupportsParameter('Anthropic', 'outputTokenParameter'), false)
  assert.equal(normalizeProviderProtocol('legacy-unknown'), 'OpenAI Compatible')
})

test('native provider settings omit unsupported request toggles without deleting saved values', () => {
  const provider = preset({
    协议: 'Anthropic',
    流式用量统计: 'true',
    输出长度参数: 'max_completion_tokens',
    频率惩罚: '0.7',
    存在惩罚: '0.2',
  })
  const settings = readModelSettings(provider)
  assert.equal(settings.includeUsage, false)
  assert.equal(settings.outputTokenParameter, 'max_tokens')
  assert.equal(settings.frequencyPenalty, undefined)
  assert.equal(settings.presencePenalty, undefined)
  assert.equal(provider.fields.频率惩罚, '0.7')
  assert.equal(provider.fields.存在惩罚, '0.2')
})

test('capability summary explains automatic usage and unsupported fields', () => {
  const capabilities = getProviderCapabilities('Google Gemini')
  assert.match(capabilities.summary, /协议自动处理/)
  assert.equal(capabilities.parameters.includeUsage.status, 'automatic')
  assert.equal(capabilities.parameters.outputTokenParameter.status, 'unsupported')
  assert.match(capabilities.parameters.outputTokenParameter.description, /maxOutputTokens/)
})
