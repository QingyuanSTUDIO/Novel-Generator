/**
 * Capabilities exposed by each transport protocol.
 *
 * Keeping this table next to the model settings reader gives the UI and
 * request client one source of truth for fields that are provider-specific.
 * A field marked `automatic` is supplied by the protocol response itself and
 * should not be sent as a request option.
 */

export type ProviderProtocol =
  | 'OpenAI Compatible'
  | '自定义 HTTP'
  | 'Google Gemini'
  | 'Anthropic'

export type ProviderParameterKey =
  | 'maxTokens'
  | 'temperature'
  | 'topP'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'outputTokenParameter'
  | 'includeUsage'
  | 'responseFormat'

export type ProviderParameterStatus = 'supported' | 'automatic' | 'unsupported'

export type ProviderParameterCapability = {
  status: ProviderParameterStatus
  label: string
  description: string
}

export type ProviderCapabilities = {
  protocol: ProviderProtocol
  parameters: Record<ProviderParameterKey, ProviderParameterCapability>
  summary: string
}

const parameterLabels: Record<ProviderParameterKey, string> = {
  maxTokens: '最大回复长度',
  temperature: '温度',
  topP: 'Top P',
  frequencyPenalty: '频率惩罚',
  presencePenalty: '存在惩罚',
  outputTokenParameter: '输出长度字段',
  includeUsage: '流式用量统计',
  responseFormat: 'JSON 输出',
}

const supported = (key: ProviderParameterKey, description = '由当前协议发送。'): ProviderParameterCapability => ({
  status: 'supported',
  label: parameterLabels[key],
  description,
})

const automatic = (key: ProviderParameterKey, description: string): ProviderParameterCapability => ({
  status: 'automatic',
  label: parameterLabels[key],
  description,
})

const unsupported = (key: ProviderParameterKey, description: string): ProviderParameterCapability => ({
  status: 'unsupported',
  label: parameterLabels[key],
  description,
})

const openAiParameters: Record<ProviderParameterKey, ProviderParameterCapability> = {
  maxTokens: supported('maxTokens'),
  temperature: supported('temperature'),
  topP: supported('topP'),
  frequencyPenalty: supported('frequencyPenalty'),
  presencePenalty: supported('presencePenalty'),
  outputTokenParameter: supported('outputTokenParameter', '可在 max_tokens 与 max_completion_tokens 之间选择。'),
  includeUsage: supported('includeUsage', '仅在流式请求中向兼容接口请求最终用量块。'),
  responseFormat: supported('responseFormat', '通过 response_format 请求 JSON 对象。'),
}

const geminiParameters: Record<ProviderParameterKey, ProviderParameterCapability> = {
  maxTokens: supported('maxTokens', '映射为 generationConfig.maxOutputTokens。'),
  temperature: supported('temperature'),
  topP: supported('topP'),
  frequencyPenalty: supported('frequencyPenalty', '映射为 generationConfig.frequencyPenalty。'),
  presencePenalty: supported('presencePenalty', '映射为 generationConfig.presencePenalty。'),
  outputTokenParameter: unsupported('outputTokenParameter', 'Gemini 使用固定的 maxOutputTokens 字段。'),
  includeUsage: automatic('includeUsage', 'Gemini 会在响应的 usageMetadata 中返回用量，无需额外请求开关。'),
  responseFormat: supported('responseFormat', '映射为 generationConfig.responseMimeType。'),
}

const anthropicParameters: Record<ProviderParameterKey, ProviderParameterCapability> = {
  maxTokens: supported('maxTokens', '映射为 Messages API 的 max_tokens。'),
  temperature: supported('temperature', 'Anthropic 温度范围为 0～1。'),
  topP: supported('topP'),
  frequencyPenalty: unsupported('frequencyPenalty', 'Anthropic Messages API 没有频率惩罚字段。'),
  presencePenalty: unsupported('presencePenalty', 'Anthropic Messages API 没有存在惩罚字段。'),
  outputTokenParameter: unsupported('outputTokenParameter', 'Anthropic 使用固定的 max_tokens 字段。'),
  includeUsage: automatic('includeUsage', 'Anthropic 会在响应的 usage 中返回用量，无需额外请求开关。'),
  responseFormat: unsupported('responseFormat', 'Anthropic 原生 Messages API 不提供通用 JSON 模式。'),
}

const capabilityTables: Record<ProviderProtocol, Record<ProviderParameterKey, ProviderParameterCapability>> = {
  'OpenAI Compatible': openAiParameters,
  '自定义 HTTP': openAiParameters,
  'Google Gemini': geminiParameters,
  Anthropic: anthropicParameters,
}

/** Keep unknown legacy values on the OpenAI-compatible transport. */
export function normalizeProviderProtocol(value?: string): ProviderProtocol {
  const protocol = String(value || '').trim()
  return protocol in capabilityTables ? protocol as ProviderProtocol : 'OpenAI Compatible'
}

export function getProviderCapabilities(value?: string): ProviderCapabilities {
  const protocol = normalizeProviderProtocol(value)
  const parameters = Object.fromEntries(
    Object.entries(capabilityTables[protocol]).map(([key, capability]) => [key, { ...capability }]),
  ) as Record<ProviderParameterKey, ProviderParameterCapability>
  const unsupportedLabels = Object.values(parameters)
    .filter((capability) => capability.status === 'unsupported')
    .map((capability) => capability.label)
  const automaticLabels = Object.values(parameters)
    .filter((capability) => capability.status === 'automatic')
    .map((capability) => capability.label)
  const summary = [
    unsupportedLabels.length ? `不支持：${unsupportedLabels.join('、')}` : '',
    automaticLabels.length ? `协议自动处理：${automaticLabels.join('、')}` : '',
  ].filter(Boolean).join('；') || '支持通用生成参数。'
  return { protocol, parameters, summary }
}

export function providerParameterStatus(protocol: string | undefined, key: ProviderParameterKey) {
  return getProviderCapabilities(protocol).parameters[key].status
}

export function providerSupportsParameter(protocol: string | undefined, key: ProviderParameterKey) {
  return providerParameterStatus(protocol, key) === 'supported'
}
