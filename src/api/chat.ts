/**
 * Shared client for the local model proxy.
 *
 * The proxy keeps the provider-specific request format on the Node side and
 * exposes one stable response shape to writing, Agent and other callers. When
 * `stream` is enabled the response is Server-Sent Events (SSE):
 *
 *   data: {"type":"delta","text":"..."}
 *   data: {"type":"done"}
 *
 * Non-streaming requests return `{ ok: true, text, usage? }`.
 */

import { normalizeChatUsage, type ChatUsage } from './chatUsage.ts'
import { prepareContextBudget } from './contextBudget.ts'
import { defaultModelSettings } from './modelSettings.ts'
import { nextChatMetricsId, publishChatMetrics, type ChatMetrics } from './chatMetrics.ts'
export type { ChatUsage } from './chatUsage.ts'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatRequest = {
  baseUrl: string
  apiKey: string
  protocol?: string
  model: string
  messages: ChatMessage[]
  responseFormat?: 'text' | 'json_object'
  useProxy?: boolean
  proxyHost?: string
  proxyPort?: string
  stream?: boolean
  maxTokens?: number
  temperature?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  /** Request the OpenAI-compatible final stream usage chunk when supported. */
  includeUsage?: boolean
  /** Explicitly select the output-limit field; never infer it from a model name. */
  outputTokenParameter?: 'max_tokens' | 'max_completion_tokens'
  /** Client-only budget and request metadata; never provider generation fields. */
  contextTokens?: number
  historyTokens?: number
  providerId?: string
  purpose?: string
  signal?: AbortSignal
}

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string }
  | { type: 'usage'; usage: ChatUsage }

export type ChatRequestOptions = {
  onDelta?: (text: string) => void | Promise<void>
  onEvent?: (event: ChatStreamEvent) => void | Promise<void>
  onUsage?: (usage: ChatUsage) => void | Promise<void>
  /** Limits time without response bytes, never total time spent writing. */
  idleTimeoutMs?: number
}

function parseErrorBody(body: unknown, fallback: string) {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error
  return fallback
}

function optionalParameterNumber(value: unknown, label: string, minimum: number, maximum: number, integer = false) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isSafeInteger(number))) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的${integer ? '整数' : '数值'}`)
  }
  return number
}

function isUnsetParameter(value: unknown) {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim())
}

/** Validate explicit settings and omit unset fields before contacting the proxy. */
function prepareChatPayload(request: ChatRequest) {
  const { signal: _signal, ...payload } = request
  const protocol = request.protocol || 'OpenAI Compatible'
  const ranges: Array<[keyof Pick<ChatRequest, 'maxTokens' | 'temperature' | 'topP' | 'frequencyPenalty' | 'presencePenalty'>, string, number, number, boolean?]> = [
    ['maxTokens', '最大输出 Tokens', 1, 2147483647, true],
    ['temperature', '温度', 0, protocol === 'Anthropic' ? 1 : 2],
    ['topP', 'Top P', 0, 1],
    ['frequencyPenalty', '频率惩罚', -2, 2],
    ['presencePenalty', '存在惩罚', -2, 2],
  ]
  for (const [key, label, minimum, maximum, integer] of ranges) {
    const value = optionalParameterNumber(payload[key], label, minimum, maximum, integer)
    if (value === undefined) delete payload[key]
    else payload[key] = value
  }
  if (isUnsetParameter(payload.outputTokenParameter)) {
    delete payload.outputTokenParameter
  } else if (!['max_tokens', 'max_completion_tokens'].includes(String(payload.outputTokenParameter))) {
    throw new Error('输出 Tokens 字段只支持 max_tokens 或 max_completion_tokens')
  }
  if (isUnsetParameter(payload.includeUsage)) {
    delete payload.includeUsage
  } else if (typeof payload.includeUsage !== 'boolean') {
    throw new Error('流式用量统计必须是开启或关闭')
  }
  if (protocol === 'Anthropic') {
    if (payload.frequencyPenalty !== undefined || payload.presencePenalty !== undefined) throw new Error('Anthropic 协议不支持频率惩罚和存在惩罚，请清空这两个参数')
  }
  return payload
}

/** Mask only the configured credential rather than broad "key" patterns. */
function redactApiKey(message: string, apiKey: string) {
  const key = String(apiKey || '').trim()
  if (!key) return message
  const variants = new Set([key])
  try {
    const encoded = encodeURIComponent(key)
    variants.add(encoded)
    variants.add(encodeURIComponent(encoded))
    variants.add(new URLSearchParams({ key }).toString().slice(4))
  } catch { /* retain literal matching for malformed Unicode */ }
  for (const variant of [...variants]) variants.add(variant.replace(/%[0-9a-f]{2}/gi, (value) => value.toLowerCase()))
  let safe = message
  for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
    if (!variant) continue
    safe = safe.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (match, offset, original) => {
      if (key.length < 8 && (/[\w%-]/.test(original[offset - 1] || '') || /[\w%-]/.test(original[offset + match.length] || ''))) return match
      return '[已隐藏密钥]'
    })
  }
  return safe
}

function safeChatError(value: unknown, apiKey: string) {
  if (value instanceof Error) {
    const message = redactApiKey(value.message, apiKey)
    if (message === value.message) return value
    const error = new Error(message)
    error.name = value.name
    return error
  }
  return typeof value === 'string' ? redactApiKey(value, apiKey) : value
}

function createSseLineParser(onData: (data: string) => Promise<void> | void) {
  let buffer = ''
  let firstChunk = true
  let eventData: string[] = []
  const flush = async () => {
    if (!eventData.length) return
    const data = eventData.join('\n')
    eventData = []
    await onData(data)
  }
  return {
    async push(value: string, done = false) {
      if (firstChunk && value) {
        value = value.replace(/^\uFEFF/, '')
        firstChunk = false
      }
      buffer += value
      while (true) {
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex < 0) break
        let line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line) {
          await flush()
        } else if (line.startsWith('data:')) {
          eventData.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (done) {
        if (buffer.startsWith('data:')) eventData.push(buffer.slice(5).replace(/^ /, ''))
        buffer = ''
        await flush()
      }
    },
  }
}

function isStreamResponse(response: Response) {
  return response.headers.get('content-type')?.toLocaleLowerCase().includes('text/event-stream') === true
}

function createRequestLifetime(externalSignal: AbortSignal | undefined, timeout: number | undefined) {
  const controller = new AbortController()
  const timeoutMs = Math.max(10, Number(timeout) || 180000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => controller.abort(externalSignal?.reason || new DOMException('请求已取消', 'AbortError'))
  const touch = () => {
    clearTimeout(timer)
    if (controller.signal.aborted) return
    timer = setTimeout(() => controller.abort(new Error('模型响应等待超时，已取消请求')), timeoutMs)
  }
  if (externalSignal?.aborted) onAbort()
  else externalSignal?.addEventListener('abort', onAbort, { once: true })
  touch()
  return {
    signal: controller.signal,
    touch,
    close() {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onAbort)
    },
  }
}

function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
  if (!value || typeof value !== 'object' || !('type' in value)) return false
  if (value.type === 'done') return true
  if (value.type === 'delta') return 'text' in value && typeof value.text === 'string'
  if (value.type === 'error') return 'error' in value && typeof value.error === 'string'
  // Statistics are optional provider metadata. Bad/missing counts must not
  // discard an otherwise complete response; normalize them at delivery.
  if (value.type === 'usage') return true
  return false
}

/**
 * Request a model response through the local proxy. `onDelta` is called in
 * arrival order for stream fragments; the returned value always contains the
 * complete text once the request finishes.
 */
export async function requestChat(
  localApiUrl: (path: string) => string,
  request: ChatRequest,
  options: ChatRequestOptions = {},
) {
  const { signal } = request
  const metrics: ChatMetrics = {
    requestId: nextChatMetricsId(),
    startedAt: Date.now(),
    providerId: request.providerId ?? '',
    purpose: request.purpose ?? 'chat',
    model: request.model,
    status: 'running',
    budget: null,
  }
  let payload: ReturnType<typeof prepareChatPayload>
  try {
    const preparedPayload = prepareChatPayload(request)
    const prepared = prepareContextBudget(request.messages, {
      contextTokens: request.contextTokens ?? defaultModelSettings.contextTokens,
      maxTokens: preparedPayload.maxTokens ?? defaultModelSettings.maxTokens,
      historyTokens: request.historyTokens ?? defaultModelSettings.historyTokens,
    })
    const {
      contextTokens: _contextTokens, historyTokens: _historyTokens,
      providerId: _providerId, purpose: _purpose, ...providerPayload
    } = preparedPayload
    payload = { ...providerPayload, messages: prepared.messages }
    metrics.budget = prepared.report
    publishChatMetrics(metrics)
  } catch (error) {
    metrics.status = 'error'
    publishChatMetrics(metrics)
    throw safeChatError(error, request.apiKey)
  }
  const recordUsage = async (usage: ChatUsage) => {
    metrics.usage = { ...metrics.usage, ...usage }
    publishChatMetrics(metrics)
    await options.onEvent?.({ type: 'usage', usage: { ...metrics.usage } })
    await options.onUsage?.({ ...metrics.usage })
  }
  const complete = (text: string) => {
    metrics.status = 'done'
    publishChatMetrics(metrics)
    return text.trim()
  }
  const lifetime = createRequestLifetime(signal, options.idleTimeoutMs)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let response: Response
    try {
      response = await fetch(localApiUrl('/api/proxy/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: lifetime.signal,
      })
    } catch (error) {
      if (lifetime.signal.aborted) throw lifetime.signal.reason
      throw new Error('本地模型代理服务未启动，请重新启动桌面应用')
    }
    lifetime.touch()

    // Never consume HTTP error bytes as text deltas, even if an upstream or
    // reverse proxy happens to mark its error page as an SSE response.
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(parseErrorBody(body, `模型代理返回 ${response.status}`))
    }
    if (!request.stream || !isStreamResponse(response)) {
      const body = await response.json().catch(() => null) as { text?: unknown; error?: unknown; usage?: unknown } | null
      if (typeof body?.text !== 'string' || !body.text.trim()) {
        throw new Error(parseErrorBody(body, '模型没有返回有效内容'))
      }
      const usage = normalizeChatUsage(body.usage)
      if (usage) await recordUsage(usage)
      return complete(body.text)
    }

    reader = response.body?.getReader()
    if (!reader) throw new Error('模型代理没有返回可读取的流')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    let sawDone = false
    const emitData = async (data: string) => {
      if (!data || sawDone) return
      let value: unknown
      try {
        value = JSON.parse(data)
      } catch {
        throw new Error('模型代理返回了无效的流式数据')
      }
      if (!isChatStreamEvent(value)) throw new Error('模型代理返回了未知的流式事件')
      if (value.type === 'usage') {
        const usage = normalizeChatUsage(value.usage)
        if (!usage) return
        await recordUsage(usage)
        return
      }
      const event: ChatStreamEvent = value.type === 'error'
        ? { type: 'error', error: redactApiKey(value.error, request.apiKey) }
        : value
      await options.onEvent?.(event)
      if (event.type === 'delta') {
        text += event.text
        await options.onDelta?.(event.text)
      } else if (event.type === 'error') {
        throw new Error(event.error || '模型请求失败')
      } else if (event.type === 'done') {
        sawDone = true
      }
    }
    const parser = createSseLineParser(emitData)
    while (true) {
      const result = await reader.read()
      lifetime.touch()
      await parser.push(decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done }), result.done)
      if (sawDone) {
        await reader.cancel()
        if (!text.trim()) throw new Error('模型没有返回有效内容')
        return complete(text)
      }
      if (result.done) throw new Error('模型连接中断，响应尚未完成，请重试')
    }
  } catch (error) {
    await reader?.cancel().catch(() => {})
    metrics.status = 'error'
    publishChatMetrics(metrics)
    throw safeChatError(lifetime.signal.aborted ? lifetime.signal.reason : error, request.apiKey)
  } finally {
    reader?.releaseLock()
    lifetime.close()
  }
}

