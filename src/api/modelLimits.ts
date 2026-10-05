import type { Resource } from '../types.ts'

export type ModelLimits = {
  model: string
  contextTokens?: number
  maxOutputTokens?: number
  maxInputTokens?: number
  contextKind?: 'context_window' | 'input_limit'
  source?: string
  message: string
}

function positiveCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Queries metadata only. No generation request or guessed model capacity. */
export async function requestModelLimits(
  localApiUrl: (path: string) => string,
  provider: Pick<Resource, 'fields'>,
  signal?: AbortSignal,
): Promise<ModelLimits> {
  const fields = provider.fields
  const baseUrl = fields['接口地址']?.trim()
  const model = fields['模型']?.trim()
  if (!baseUrl || !model) throw new Error('请先填写接口地址并选择模型，再获取模型上限。')
  let response: Response
  try {
    response = await fetch(localApiUrl('/api/proxy/model-limits'), {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        model,
        apiKey: fields['API Key'] ?? '',
        protocol: fields['协议'] || 'OpenAI Compatible',
        useProxy: fields['使用代理'] === 'true',
        proxyHost: fields['代理地址'] ?? '',
        proxyPort: fields['代理端口'] ?? '',
      }),
    })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new Error('本地代理服务不可用，请重新启动桌面应用。')
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || body?.ok !== true) {
    throw new Error(typeof body?.error === 'string' ? body.error : `获取模型上限失败（${response.status}）。`)
  }
  if (body.model !== model) throw new Error('服务器返回的模型与当前选择不同，已保留原设置。')
  return {
    model,
    contextTokens: positiveCount(body.contextTokens),
    maxOutputTokens: positiveCount(body.maxOutputTokens),
    maxInputTokens: positiveCount(body.maxInputTokens),
    contextKind: body.contextKind === 'input_limit' ? 'input_limit' : body.contextKind === 'context_window' ? 'context_window' : undefined,
    source: typeof body.source === 'string' ? body.source : undefined,
    message: typeof body.message === 'string' ? body.message : '服务器未提供模型容量信息，请手动填写。',
  }
}
