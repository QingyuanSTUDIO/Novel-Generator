import type { Resource } from '../types.ts'
import { normalizeProviderProtocol, providerSupportsParameter } from './providerCapabilities.ts'

export const defaultModelSettings = {
  contextTokens: 272000,
  maxTokens: 8192,
  historyTokens: 32768,
  includeUsage: true,
  outputTokenParameter: 'max_tokens' as const,
}

export type ModelSettings = {
  contextTokens: number
  maxTokens: number
  historyTokens: number
  includeUsage: boolean
  outputTokenParameter: 'max_tokens' | 'max_completion_tokens'
  temperature?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
}

const settingsFields = {
  contextTokens: '上下文长度',
  maxTokens: '最大回复长度',
  historyTokens: '对话记忆预算',
  temperature: '温度',
  topP: 'Top P',
  frequencyPenalty: '频率惩罚',
  presencePenalty: '存在惩罚',
} as const

function readNumber(fields: Record<string, string>, key: keyof typeof settingsFields, min: number, max: number, fallback?: number, integer = false) {
  const raw = fields[settingsFields[key]]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${settingsFields[key]}必须是 ${min}～${max} 范围内的${integer ? '整数' : '数值'}。`)
  }
  return value
}

/** Empty sampling fields deliberately use the provider's own defaults. */
export function readModelSettings(provider: Pick<Resource, 'fields'>): ModelSettings {
  const fields = provider.fields ?? {}
  const protocol = normalizeProviderProtocol(fields['协议'])
  const isAnthropic = protocol === 'Anthropic'
  const outputTokenParameter = fields['输出长度参数']?.trim()
  if (outputTokenParameter && !['max_tokens', 'max_completion_tokens'].includes(outputTokenParameter)) {
    throw new Error('输出长度参数必须为 max_tokens 或 max_completion_tokens。')
  }
  const settings: ModelSettings = {
    contextTokens: readNumber(fields, 'contextTokens', 1024, 10000000, defaultModelSettings.contextTokens, true)!,
    maxTokens: readNumber(fields, 'maxTokens', 1, 1000000, defaultModelSettings.maxTokens, true)!,
    historyTokens: readNumber(fields, 'historyTokens', 0, 10000000, defaultModelSettings.historyTokens, true)!,
    includeUsage: providerSupportsParameter(protocol, 'includeUsage') && fields['流式用量统计'] !== 'false',
    // Native providers choose their own output field. Keep the stable
    // ModelSettings shape for callers, while the request client omits this
    // client-only selector for those protocols.
    outputTokenParameter: providerSupportsParameter(protocol, 'outputTokenParameter') && outputTokenParameter === 'max_completion_tokens'
      ? 'max_completion_tokens'
      : 'max_tokens',
  }
  const optional = {
    temperature: readNumber(fields, 'temperature', 0, isAnthropic ? 1 : 2),
    topP: readNumber(fields, 'topP', 0, 1),
    // Keep saved values when switching protocols, but never send unsupported
    // penalties to Anthropic. Switching back restores the author's settings.
    frequencyPenalty: providerSupportsParameter(protocol, 'frequencyPenalty') ? readNumber(fields, 'frequencyPenalty', -2, 2) : undefined,
    presencePenalty: providerSupportsParameter(protocol, 'presencePenalty') ? readNumber(fields, 'presencePenalty', -2, 2) : undefined,
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) Object.assign(settings, { [key]: value })
  }
  if (settings.maxTokens >= settings.contextTokens) {
    throw new Error('最大回复长度必须小于上下文长度，还需要为输入资料保留空间。')
  }
  if (settings.contextTokens - settings.maxTokens - Math.max(32, Math.ceil(settings.contextTokens * 0.05)) <= 0) {
    throw new Error('上下文长度不足以容纳最大回复和 5% 安全余量，请降低最大回复长度。')
  }
  return settings
}
