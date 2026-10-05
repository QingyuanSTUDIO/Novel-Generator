const positiveInteger = (value) => {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function findCount(record, names) {
  const sources = [record, record?.top_provider, record?.limits, record?.capabilities, record?.model_info]
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    for (const name of names) {
      const count = positiveInteger(source[name])
      if (count !== undefined) return count
    }
  }
  return undefined
}

/** Counts come only from the selected model's returned metadata. */
export function extractModelLimits(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {}
  const window = findCount(record, [
    'context_length', 'context_window', 'contextLength', 'contextWindow',
    'max_context_length', 'max_context_tokens', 'context_tokens', 'max_total_tokens', 'max_model_len',
  ])
  const maxInputTokens = findCount(record, [
    'inputTokenLimit', 'input_token_limit', 'max_input_tokens', 'maxInputTokens', 'max_input_length',
  ])
  const maxOutputTokens = findCount(record, [
    'outputTokenLimit', 'output_token_limit', 'max_output_tokens', 'maxOutputTokens',
    'max_completion_tokens', 'max_tokens', 'max_output_length',
  ])
  return {
    ...(window !== undefined ? { contextTokens: window, contextKind: 'context_window' }
      : maxInputTokens !== undefined ? { contextTokens: maxInputTokens, contextKind: 'input_limit' } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}

function endpoints(baseUrl, protocol) {
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('接口地址必须使用 HTTP 或 HTTPS。')
  base.hash = ''
  base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/models$/i, '')
  const roots = [base]
  if (protocol === 'Google Gemini') {
    if (!/\/v1(?:beta)?$/i.test(base.pathname)) base.pathname += '/v1beta'
  } else if (!/\/v1$/i.test(base.pathname)) {
    const versioned = new URL(base)
    versioned.pathname += '/v1'
    roots.push(versioned)
  }
  return roots.map((root) => {
    const result = new URL(root)
    result.pathname = `${root.pathname}/models`
    return result
  })
}

function safeSource(url) {
  const source = new URL(url)
  // Native Gemini puts its key in the query. Never expose query/user-info.
  return source.origin + source.pathname
}

function modelId(value, protocol) {
  const id = typeof value === 'string' ? value
    : [value?.id, value?.model, value?.name].find((candidate) => typeof candidate === 'string')
  if (typeof id !== 'string') return undefined
  return protocol === 'Google Gemini' ? id.replace(/^models\//, '') : id
}

function identifiesSelectedModel(record, selectedId, protocol, allowMissing = false) {
  // Some relays use `model` instead of `id`. If both exist, they must agree.
  // `name` can be a display label on compatible APIs; Gemini uses it as an ID.
  const identifiers = typeof record === 'string' ? [record]
    : (protocol === 'Google Gemini' ? [record?.id, record?.model, record?.name] : [record?.id, record?.model])
      .filter((candidate) => typeof candidate === 'string')
  if (identifiers.length) return identifiers.every((id) => modelId(id, protocol) === selectedId)
  const id = modelId(record, protocol)
  return id === selectedId || (allowMissing && id === undefined)
}

function modelRecords(body) {
  return Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : []
}

function detailRecord(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data
  if (body.model && typeof body.model === 'object') return body.model
  return body
}

function responseError(response, body) {
  const detail = typeof body?.error === 'string' ? body.error
    : typeof body?.error?.message === 'string' ? body.error.message
      : typeof body?.message === 'string' ? body.message : response.statusText || ''
  return new Error(`模型信息接口返回 ${response.status}${detail ? `：${detail}` : ''}`)
}

/**
 * Metadata-only GETs to the configured origin, with exact model matching.
 * Unsupported detail endpoints may fall back to a bounded, paginated list.
 * Authentication/rate/server errors stop immediately instead of probing more.
 */
export async function fetchModelLimits(input, request, externalSignal, timeoutMs = 30000) {
  const baseUrl = String(input?.baseUrl || '').trim()
  const model = String(input?.model || '').trim()
  const protocol = String(input?.protocol || 'OpenAI Compatible')
  if (!baseUrl) throw new Error('请先填写接口地址。')
  if (!model) throw new Error('请先选择模型。')
  if (!String(input?.apiKey || '').trim()) throw new Error('请先填写 API Key。')
  if (!['OpenAI Compatible', 'Google Gemini', 'Anthropic', '自定义 HTTP'].includes(protocol)) throw new Error('请选择受支持的接口协议。')
  const selectedId = modelId(model, protocol)
  if (selectedId.split('/').some((part) => part === '.' || part === '..')) throw new Error('模型名称包含无效的路径。')
  const lists = endpoints(baseUrl, protocol)
  const controller = new AbortController()
  const onAbort = () => controller.abort(externalSignal.reason || new Error('已取消模型上限查询。'))
  if (externalSignal?.aborted) onAbort()
  else externalSignal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('模型上限查询超时，请检查网络与代理。')), timeoutMs)
  timer.unref?.()
  let found = {}
  let source
  const unsupported = new Set([404, 405, 501])
  const read = async (url) => {
    controller.signal.throwIfAborted()
    const response = await request(url.href, input, controller.signal)
    controller.signal.throwIfAborted()
    let body
    try { body = JSON.parse(response.text) } catch { /* optional endpoint can be an HTML 404 */ }
    if (response.status < 200 || response.status >= 300) {
      if (unsupported.has(response.status)) return null
      throw responseError(response, body)
    }
    if (!body || typeof body !== 'object') throw new Error('模型信息接口没有返回有效的 JSON 元数据。')
    return body
  }
  const remember = (record, url) => {
    const limits = extractModelLimits(record)
    if (Object.keys(limits).length) {
      found = { ...found, ...limits }
      source = safeSource(url)
    }
    return found.contextTokens !== undefined
  }
  const finish = () => ({
    model,
    ...found,
    ...(source ? { source } : {}),
    message: found.contextTokens !== undefined
      ? found.contextKind === 'input_limit' ? '服务器已返回所选模型的输入上限。' : '服务器已返回所选模型的上下文上限。'
      : '服务器未提供所选模型的上下文上限，请按模型文档手动填写；原配置已保留。',
  })
  try {
    for (const list of lists) {
      const detail = new URL(list)
      detail.pathname += `/${encodeURIComponent(selectedId)}`
      const body = await read(detail)
      const record = detailRecord(body)
      if (record && identifiesSelectedModel(record, selectedId, protocol, true) && !modelRecords(record).length) {
        if (remember(record, detail)) return finish()
      }
      let page = new URL(list)
      const seenPages = new Set()
      for (let count = 0; count < 8; count += 1) {
        if (seenPages.has(page.href)) break
        seenPages.add(page.href)
        const pageBody = await read(page)
        if (!pageBody) break
        const match = modelRecords(pageBody).find((item) => identifiesSelectedModel(item, selectedId, protocol))
        if (match && remember(match, page)) return finish()
        const nextToken = typeof pageBody.nextPageToken === 'string' ? pageBody.nextPageToken : ''
        const lastId = pageBody.has_more === true && typeof pageBody.last_id === 'string' ? pageBody.last_id : ''
        if (!nextToken && !lastId) break
        const next = new URL(list)
        if (nextToken) next.searchParams.set('pageToken', nextToken)
        else next.searchParams.set('after_id', lastId)
        page = next
      }
    }
    return finish()
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onAbort)
  }
}
