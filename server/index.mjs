import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import fs from 'node:fs/promises'
import path from 'node:path'
import { URL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { fetchModelLimits } from './model-limits.mjs'

const HOST = process.env.NOVEL_PROXY_HOST || '127.0.0.1'
const PORT = Number(process.env.NOVEL_PROXY_PORT || 3100)
const STORAGE_PATH = process.env.NOVEL_STORAGE_PATH || path.resolve(process.cwd(), 'data', 'novel-generator-state.json')
const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const CHAT_IDLE_TIMEOUT_MS = 180000

/** Remove only this request's credential, including URL-encoded echoes. */
function redactApiKey(message, apiKey) {
  const key = String(apiKey || '').trim()
  if (!key) return String(message)
  const variants = new Set([key])
  try {
    const encoded = encodeURIComponent(key)
    variants.add(encoded)
    variants.add(encodeURIComponent(encoded))
    variants.add(new URLSearchParams({ key }).toString().slice(4))
  } catch { /* malformed Unicode still has its literal representation */ }
  for (const variant of [...variants]) variants.add(variant.replace(/%[0-9a-f]{2}/gi, (value) => value.toLowerCase()))
  let safe = String(message)
  for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
    if (!variant) continue
    safe = safe.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (match, offset, original) => {
      // Tiny test/local credentials must not erase substrings of ordinary
      // model names or words (for example "abc" inside "abc-model").
      if (key.length < 8 && (/[\w%-]/.test(original[offset - 1] || '') || /[\w%-]/.test(original[offset + match.length] || ''))) return match
      return '[已隐藏密钥]'
    })
  }
  return safe
}

function safeUpstreamError(error, input) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '上游请求失败'
  return redactApiKey(message, input?.apiKey)
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
  })
  res.end(payload)
}

async function readStorage(storagePath) {
  try {
    const raw = await fs.readFile(storagePath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeStorage(storagePath, value) {
  await fs.mkdir(path.dirname(storagePath), { recursive: true })
  const tempPath = `${storagePath}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(value), 'utf8')
  await fs.rename(tempPath, storagePath)
}

async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_REQUEST_BYTES) throw new Error('请求内容超过 8 MB 限制')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求内容不是有效的 JSON')
  }
}

function modelEndpoints(rawBaseUrl) {
  const base = String(rawBaseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return []
  const bases = [base]
  if (!/\/v1$/i.test(base)) bases.push(`${base}/v1`)
  return [...new Set(bases.map((item) => `${item}/models`))]
}

function proxyConfig(input) {
  if (!input?.useProxy) return null
  const host = String(input.proxyHost || '').trim()
  const port = Number(input.proxyPort)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('已启用代理，请填写有效的代理地址和端口')
  }
  return {
    protocol: String(input.proxyProtocol || 'http').replace(/:$/, ''),
    host,
    port,
    username: String(input.proxyUsername || ''),
    password: String(input.proxyPassword || ''),
  }
}

function proxyHeaders(proxy) {
  if (!proxy?.username) return {}
  return { 'proxy-authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` }
}

function collectResponse(response) {
  return new Promise((resolve, reject) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve({
      status: response.statusCode || 0,
      statusText: response.statusMessage || '',
      headers: response.headers,
      text: Buffer.concat(chunks).toString('utf8'),
    }))
    response.on('error', reject)
  })
}

function requestViaProxy(target, options, proxy) {
  const targetUrl = new URL(target)
  const isHttps = targetUrl.protocol === 'https:'
  const targetHeaders = { ...options.headers }
  const connectHeaders = proxyHeaders(proxy)

  if (!isHttps) {
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: proxy.host,
        port: proxy.port,
        method: options.method || 'GET',
        path: targetUrl.href,
        headers: { ...targetHeaders, ...connectHeaders },
      }, (response) => collectResponse(response).then(resolve, reject))
      request.on('error', reject)
      request.end(options.body)
    })
  }

  return new Promise((resolve, reject) => {
    const connect = http.request({
      hostname: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: connectHeaders,
    })
    connect.once('error', reject)
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理 CONNECT 失败：${response.statusCode} ${response.statusMessage || ''}`.trim()))
        return
      }
      const secureSocket = tls.connect({ socket, servername: targetUrl.hostname })
      secureSocket.once('error', reject)
      if (head?.length) secureSocket.unshift(head)
      const request = https.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        method: options.method || 'GET',
        path: `${targetUrl.pathname || '/'}${targetUrl.search}`,
        headers: targetHeaders,
        createConnection: () => secureSocket,
      }, (result) => collectResponse(result).then(resolve, reject))
      request.on('error', reject)
      request.end(options.body)
    })
    connect.end()
  })
}

/**
 * Send a request through the configured HTTP proxy without buffering the
 * upstream response. The normal request helper above intentionally buffers
 * JSON responses; chat streaming needs to expose each upstream chunk as soon
 * as it arrives.
 */
function requestViaProxyStream(target, options, proxy, onResponse) {
  const targetUrl = new URL(target)
  const isHttps = targetUrl.protocol === 'https:'
  const targetHeaders = { ...options.headers }
  const connectHeaders = proxyHeaders(proxy)

  if (!isHttps) {
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: proxy.host,
        port: proxy.port,
        method: options.method || 'GET',
        path: targetUrl.href,
        headers: { ...targetHeaders, ...connectHeaders },
        signal: options.signal,
      }, (response) => {
        Promise.resolve(onResponse(response)).then(resolve, reject)
      })
      request.on('error', reject)
      request.end(options.body)
    })
  }

  return new Promise((resolve, reject) => {
    const connect = http.request({
      hostname: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: connectHeaders,
      signal: options.signal,
    })
    connect.once('error', reject)
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理 CONNECT 失败：${response.statusCode} ${response.statusMessage || ''}`.trim()))
        return
      }
      const secureSocket = tls.connect({ socket, servername: targetUrl.hostname })
      secureSocket.once('error', reject)
      const destroySecureSocket = () => secureSocket.destroy()
      options.signal?.addEventListener('abort', destroySecureSocket, { once: true })
      secureSocket.once('close', () => options.signal?.removeEventListener('abort', destroySecureSocket))
      if (head?.length) secureSocket.unshift(head)
      const request = https.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        method: options.method || 'GET',
        path: `${targetUrl.pathname || '/'}${targetUrl.search}`,
        headers: targetHeaders,
        createConnection: () => secureSocket,
        signal: options.signal,
      }, (result) => {
        Promise.resolve(onResponse(result)).then(resolve, reject)
      })
      request.on('error', reject)
      request.end(options.body)
    })
    connect.end()
  })
}

async function requestUpstream(target, input, signal) {
  const apiKey = String(input.apiKey || '').trim()
  const protocol = String(input.protocol || 'OpenAI Compatible')
  const headers = { accept: 'application/json', authorization: `Bearer ${apiKey}` }
  if (input.protocol === 'Anthropic') {
    delete headers.authorization
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (protocol === 'Google Gemini') {
    delete headers.authorization
  }
  let requestTarget = target
  if (protocol === 'Google Gemini') {
    const url = new URL(target)
    url.searchParams.set('key', apiKey)
    requestTarget = url.href
  }
  const proxy = proxyConfig(input)

  if (!proxy) {
    const response = await fetch(requestTarget, { method: 'GET', headers, signal })
    return {
      status: response.status,
      statusText: response.statusText,
      text: await response.text(),
    }
  }

  if (signal) return requestViaProxyStream(requestTarget, { method: 'GET', headers, signal }, proxy, collectResponse)
  return requestViaProxy(requestTarget, { method: 'GET', headers }, proxy)
}

/**
 * POST to an upstream model while forwarding response chunks to `onChunk`.
 * `text` is retained for non-SSE fallbacks and useful error messages.
 */
async function requestUpstreamStream(target, input, body, extraHeaders = {}, onChunk = () => false, lifetime) {
  const apiKey = String(input.apiKey || '').trim()
  const headers = {
    accept: input.stream === true || input.stream === 'true' ? 'text/event-stream, application/json' : 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  }
  if (input.protocol === 'Anthropic') {
    delete headers.authorization
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (input.protocol === 'Google Gemini') {
    delete headers.authorization
  }
  const proxy = proxyConfig(input)
  const payload = JSON.stringify(body)
  const chunks = []
  const forwardChunk = (chunk, canStream) => {
    lifetime.touch()
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    chunks.push(buffer)
    return canStream ? onChunk(buffer) : false
  }

  if (!proxy) {
    const response = await fetch(target, { method: 'POST', headers, body: payload, signal: lifetime.signal })
    lifetime.touch()
    const canStream = response.ok && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (forwardChunk(value, canStream)) {
            await reader.cancel()
            break
          }
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      } finally {
        reader.releaseLock()
      }
    } else {
      const text = await response.text()
      if (text) forwardChunk(Buffer.from(text), canStream)
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      text: Buffer.concat(chunks).toString('utf8'),
    }
  }

  const response = await requestViaProxyStream(
    target,
    { method: 'POST', headers, body: payload, signal: lifetime.signal },
    proxy,
    (upstreamResponse) => new Promise((resolve, reject) => {
      lifetime.touch()
      const status = upstreamResponse.statusCode || 0
      const canStream = status >= 200 && status < 300
        && String(upstreamResponse.headers['content-type'] || '').toLowerCase().includes('text/event-stream')
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        lifetime.signal.removeEventListener('abort', onAbort)
        resolve(upstreamResponse)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        lifetime.signal.removeEventListener('abort', onAbort)
        upstreamResponse.destroy()
        reject(error)
      }
      const onAbort = () => fail(lifetime.signal.reason || new Error('请求已取消'))
      lifetime.signal.addEventListener('abort', onAbort, { once: true })
      upstreamResponse.on('data', (chunk) => {
        try {
          if (forwardChunk(chunk, canStream)) {
            finish()
            upstreamResponse.destroy()
          }
        } catch (error) {
          fail(error)
        }
      })
      upstreamResponse.on('end', finish)
      upstreamResponse.on('error', fail)
      upstreamResponse.on('aborted', () => fail(new Error('模型连接中断，响应尚未完成')))
      if (lifetime.signal.aborted) onAbort()
    }),
  )
  return {
    status: response.statusCode || 0,
    statusText: response.statusMessage || '',
    headers: response.headers,
    text: Buffer.concat(chunks).toString('utf8'),
  }
}

async function fetchModels(input) {
  const baseUrl = String(input.baseUrl || '').trim()
  if (!baseUrl) throw new Error('请先填写接口地址')
  if (!String(input.apiKey || '').trim()) throw new Error('请先填写 API Key')
  let lastError = '模型接口没有返回可识别的模型列表'
  const protocol = String(input.protocol || 'OpenAI Compatible')
  const endpoints = protocol === 'Google Gemini'
    ? [geminiModelsEndpoint(baseUrl)]
    : modelEndpoints(baseUrl)
  for (const endpoint of endpoints) {
    try {
      const response = await withTimeout(requestUpstream(endpoint, input), 30000, '模型列表请求超时')
      let body = null
      try { body = JSON.parse(response.text) } catch { /* preserve upstream text below */ }
      if (response.status < 200 || response.status >= 300) {
        lastError = body?.error?.message || body?.message || `${response.status} ${response.statusText}`.trim()
        if (response.status === 404) continue
        throw new Error(lastError)
      }
      const records = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
      const ids = records
        .map((item) => typeof item === 'string' ? item : item?.id || item?.name)
        .map((id) => protocol === 'Google Gemini' ? String(id).replace(/^models\//i, '') : id)
        .filter((id) => typeof id === 'string' && id.length > 0)
      if (ids.length) return [...new Set(ids)]
      throw new Error(lastError)
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError
    }
  }
  throw new Error(lastError)
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/<[^>]+>/g, '').trim()
}
function withTimeout(promise, timeoutMs = 12000, message = '网络搜索请求超时') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
async function requestWebSearch(target, input) {
  const headers = { accept: 'text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 NovelGenerator/1.0' }; const proxy = proxyConfig(input)
  if (proxy) return withTimeout(requestViaProxy(target, { method: 'GET', headers }, proxy))
  return withTimeout((async () => { const response = await fetch(target, { method: 'GET', headers }); return { status: response.status, statusText: response.statusText, headers: response.headers, text: await response.text() } })())
}
function xmlTag(item, tag) { const match = item.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i')); return match ? decodeHtmlEntities(match[1]) : '' }
function parseBingRss(text, limit) { const items = [...String(text || '').matchAll(/<item(?:\\s[^>]*)?>([\\s\\S]*?)<\/item>/gi)]; return items.slice(0, limit).map((match) => { const item = match[1]; return { title: xmlTag(item, 'title'), url: xmlTag(item, 'link'), snippet: xmlTag(item, 'description'), publishedAt: xmlTag(item, 'pubDate'), source: 'Bing' } }).filter((item) => item.title && item.url) }
function parseDuckDuckGoHtml(text, limit) {
  const html = String(text || ''), results = [], resultRe = /<a[^>]*class="[^"]*result__a[^\"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi; let match
  while ((match = resultRe.exec(html)) && results.length < limit) { let url = decodeHtmlEntities(match[1]); try { const parsed = new URL(url, 'https://html.duckduckgo.com'); url = parsed.searchParams.get('uddg') || parsed.href } catch {}
    const tail = html.slice(match.index, match.index + 5000), snippetMatch = tail.match(/class="[^"]*result__snippet[^\"]*"[^>]*>([\s\S]*?)<\/a>/i) || tail.match(/class="[^"]*result__snippet[^\"]*"[^>]*>([\s\S]*?)<\/div>/i)
    results.push({ title: decodeHtmlEntities(match[2]), url, snippet: snippetMatch ? decodeHtmlEntities(snippetMatch[1]) : '', publishedAt: '', source: 'DuckDuckGo' }) }
  return results
}
function parseGoogleHtml(text, limit) { const html=String(text||''), out=[]; const re=/<a href=\"(https?:\/\/[^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi; let m; while((m=re.exec(html))&&out.length<limit){ const title=decodeHtmlEntities(m[2]); if(title.length<4||/google/i.test(title)) continue; out.push({title,url:m[1],snippet:'',publishedAt:'',source:'Google'}) } return out }
async function searchWebMemes(input) {
  const query = String(input.query || '网络热梗 最近 热点').trim() || '网络热梗 最近 热点'; const requestedLimit = Number(input.limit); const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 30)) : 10; const encodedQuery = encodeURIComponent(query); const engine = ['bing','google','duckduckgo'].includes(input.engine) ? input.engine : 'bing'; const errors = []
  const sourceCatalog = {
    bing: ['Bing', 'https://www.bing.com/search?q=' + encodedQuery + '&format=rss&setlang=zh-CN', parseBingRss],
    google: ['Google', 'https://www.google.com/search?q=' + encodedQuery, parseGoogleHtml],
    duckduckgo: ['DuckDuckGo', 'https://html.duckduckgo.com/html/?q=' + encodedQuery, parseDuckDuckGoHtml],
  }
  const sources = [engine, 'duckduckgo', 'bing', 'google']
    .filter((name, index, list) => list.indexOf(name) === index)
    .map((name) => sourceCatalog[name])
  for (const [name, url, parser] of sources) { try { const response = await requestWebSearch(url, input); if (response.status >= 200 && response.status < 300) { const results = parser(response.text, limit); if (results.length) return results } else errors.push((name + ' ' + response.status + ' ' + response.statusText).trim()) } catch (error) { errors.push(error instanceof Error ? error.message : name + ' 搜索失败') } }
  throw new Error(errors.join('；') || '未找到网络热梗搜索结果')
}
function normalizedBaseUrl(rawBaseUrl) {
  return String(rawBaseUrl || '').trim().replace(/\/+$/, '')
}

function openAiChatEndpoint(baseUrl) {
  const base = normalizedBaseUrl(baseUrl)
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

function anthropicChatEndpoint(baseUrl) {
  const base = normalizedBaseUrl(baseUrl)
  return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`
}

function geminiChatEndpoint(baseUrl, model, apiKey) {
  const base = normalizedBaseUrl(baseUrl) || 'https://generativelanguage.googleapis.com/v1beta'
  const root = /\/v1beta$/i.test(base) || /\/v1$/i.test(base) ? base : `${base}/v1beta`
  return `${root}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
}

function geminiModelsEndpoint(baseUrl) {
  const base = (normalizedBaseUrl(baseUrl) || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/models$/i, '')
  const root = /\/v1beta$/i.test(base) || /\/v1$/i.test(base) ? base : `${base}/v1beta`
  return `${root}/models`
}

function geminiStreamChatEndpoint(baseUrl, model, apiKey) {
  const base = normalizedBaseUrl(baseUrl) || 'https://generativelanguage.googleapis.com/v1beta'
  const root = /\/v1beta$/i.test(base) || /\/v1$/i.test(base) ? base : `${base}/v1beta`
  return `${root}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
}

function optionalParameterNumber(value, label, minimum, maximum, integer = false) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isSafeInteger(number))) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的${integer ? '整数' : '数值'}`)
  }
  return number
}

function normalizedGenerationParameters(input, protocol) {
  const maxTokens = optionalParameterNumber(input.maxTokens, '最大输出 Tokens', 1, 2147483647, true)
  const temperature = optionalParameterNumber(input.temperature, '温度', 0, protocol === 'Anthropic' ? 1 : 2)
  const topP = optionalParameterNumber(input.topP, 'Top P', 0, 1)
  const frequencyPenalty = optionalParameterNumber(input.frequencyPenalty, '频率惩罚', -2, 2)
  const presencePenalty = optionalParameterNumber(input.presencePenalty, '存在惩罚', -2, 2)
  const outputTokenParameter = input.outputTokenParameter === undefined || input.outputTokenParameter === null || input.outputTokenParameter === ''
    ? 'max_tokens' : input.outputTokenParameter
  if (!['max_tokens', 'max_completion_tokens'].includes(outputTokenParameter)) throw new Error('输出 Tokens 字段只支持 max_tokens 或 max_completion_tokens')
  let includeUsage = false
  if (input.includeUsage !== undefined && input.includeUsage !== null && input.includeUsage !== '') {
    if (typeof input.includeUsage !== 'boolean') throw new Error('流式用量统计必须是开启或关闭')
    includeUsage = input.includeUsage
  }
  if (protocol === 'Anthropic' && (frequencyPenalty !== undefined || presencePenalty !== undefined)) {
    throw new Error('Anthropic 协议不支持频率惩罚和存在惩罚，请清空这两个参数')
  }
  return { maxTokens, temperature, topP, frequencyPenalty, presencePenalty, outputTokenParameter, includeUsage }
}

function buildChatRequest(input, stream = false) {
  const protocol = String(input.protocol || 'OpenAI Compatible')
  const model = String(input.model || '').trim()
  const messages = Array.isArray(input.messages) ? input.messages : []
  if (!model) throw new Error('请先选择 Agent 使用的模型')
  if (!String(input.apiKey || '').trim()) throw new Error('请先填写 API Key')
  const settings = normalizedGenerationParameters(input, protocol)

  let endpoint = ''
  let payload = {}
  let headers = {}
  if (protocol === 'Anthropic') {
    endpoint = anthropicChatEndpoint(input.baseUrl)
    const system = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n')
    // max_tokens is required by the native Messages API. Keep the existing
    // fallback only for older callers that have not supplied a limit.
    payload = { model, max_tokens: settings.maxTokens ?? 1600, system, messages: messages.filter((item) => item.role !== 'system') }
    if (settings.temperature !== undefined) payload.temperature = settings.temperature
    if (settings.topP !== undefined) payload.top_p = settings.topP
    if (stream) payload.stream = true
    headers = { 'anthropic-version': '2023-06-01' }
  } else if (protocol === 'Google Gemini') {
    endpoint = stream
      ? geminiStreamChatEndpoint(input.baseUrl, model, String(input.apiKey).trim())
      : geminiChatEndpoint(input.baseUrl, model, String(input.apiKey).trim())
    const system = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n')
    payload = { systemInstruction: { parts: [{ text: system }] }, contents: messages.filter((item) => item.role !== 'system').map((item) => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] })) }
    const generationConfig = {}
    if (settings.maxTokens !== undefined) generationConfig.maxOutputTokens = settings.maxTokens
    if (settings.temperature !== undefined) generationConfig.temperature = settings.temperature
    if (settings.topP !== undefined) generationConfig.topP = settings.topP
    if (settings.frequencyPenalty !== undefined) generationConfig.frequencyPenalty = settings.frequencyPenalty
    if (settings.presencePenalty !== undefined) generationConfig.presencePenalty = settings.presencePenalty
    if (input.responseFormat === 'json_object') generationConfig.responseMimeType = 'application/json'
    if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig
  } else {
    endpoint = openAiChatEndpoint(input.baseUrl)
    payload = { model, messages }
    if (settings.maxTokens !== undefined) payload[settings.outputTokenParameter] = settings.maxTokens
    if (settings.temperature !== undefined) payload.temperature = settings.temperature
    if (settings.topP !== undefined) payload.top_p = settings.topP
    if (settings.frequencyPenalty !== undefined) payload.frequency_penalty = settings.frequencyPenalty
    if (settings.presencePenalty !== undefined) payload.presence_penalty = settings.presencePenalty
    if (input.responseFormat === 'json_object') payload.response_format = { type: 'json_object' }
    if (stream) {
      payload.stream = true
      if (settings.includeUsage) payload.stream_options = { include_usage: true }
    }
  }
  return { protocol, endpoint, payload, headers }
}

function extractChatText(protocol, body) {
  return protocol === 'Anthropic'
    ? body?.content?.map((item) => item?.text || '').join('')
    : protocol === 'Google Gemini'
      ? body?.candidates?.[0]?.content?.parts?.map((item) => item?.text || '').join('')
      : body?.choices?.[0]?.message?.content
}

function tokenCount(...values) {
  return values.find((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function countSum(...values) {
  if (values.some((value) => value === undefined)) return undefined
  return tokenCount(values.reduce((sum, value) => sum + value, 0))
}

const usageSourceFields = [
  'prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
  'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_write_tokens',
  'prompt_tokens_details', 'input_tokens_details', 'completion_tokens_details', 'output_tokens_details',
  'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount',
]

/** Streaming usage fields are cumulative snapshots, not increments to add. */
function mergeUsageSource(previous, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return previous
  const merged = { ...previous }
  for (const key of usageSourceFields) {
    const value = next[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const details = { ...merged[key] }
      for (const name of ['cached_tokens', 'cache_write_tokens', 'reasoning_tokens', 'internal_reasoning_tokens']) {
        const count = tokenCount(value[name])
        if (count !== undefined) details[name] = count
      }
      merged[key] = details
    } else {
      const count = tokenCount(value)
      if (count !== undefined) merged[key] = count
    }
  }
  return merged
}

/** Only map counts that the upstream actually reported. Unknown is not zero. */
function normalizedChatUsage(protocol, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
  let usage
  if (protocol === 'Anthropic') {
    const uncachedInputTokens = tokenCount(source.input_tokens)
    const cachedInputTokens = tokenCount(source.cache_read_input_tokens)
    const cacheWriteTokens = tokenCount(source.cache_creation_input_tokens)
    const inputTokens = countSum(uncachedInputTokens, cachedInputTokens, cacheWriteTokens)
    const outputTokens = tokenCount(source.output_tokens)
    usage = {
      inputTokens, outputTokens,
      totalTokens: tokenCount(source.total_tokens, countSum(inputTokens, outputTokens)),
      cachedInputTokens, cacheWriteTokens, uncachedInputTokens,
      reasoningTokens: tokenCount(source.output_tokens_details?.reasoning_tokens, source.output_tokens_details?.internal_reasoning_tokens),
    }
  } else if (protocol === 'Google Gemini') {
    usage = {
      inputTokens: tokenCount(source.promptTokenCount),
      outputTokens: tokenCount(source.candidatesTokenCount),
      totalTokens: tokenCount(source.totalTokenCount),
      cachedInputTokens: tokenCount(source.cachedContentTokenCount),
      reasoningTokens: tokenCount(source.thoughtsTokenCount),
    }
  } else {
    usage = {
      inputTokens: tokenCount(source.prompt_tokens, source.input_tokens),
      outputTokens: tokenCount(source.completion_tokens, source.output_tokens),
      totalTokens: tokenCount(source.total_tokens),
      cachedInputTokens: tokenCount(source.prompt_tokens_details?.cached_tokens, source.input_tokens_details?.cached_tokens, source.prompt_cache_hit_tokens),
      cacheWriteTokens: tokenCount(source.prompt_tokens_details?.cache_write_tokens, source.input_tokens_details?.cache_write_tokens, source.cache_write_tokens),
      reasoningTokens: tokenCount(source.completion_tokens_details?.reasoning_tokens, source.output_tokens_details?.reasoning_tokens),
      uncachedInputTokens: tokenCount(source.prompt_cache_miss_tokens),
    }
  }
  const counts = Object.fromEntries(Object.entries(usage).filter(([, count]) => count !== undefined))
  return Object.keys(counts).length ? counts : undefined
}

function chatResponseError(body) {
  if (!body || typeof body !== 'object') return ''
  const error = body.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') return String(error.message || error.type || '上游模型返回错误')
  return ''
}

function ensureFinishReason(protocol, reason) {
  if (reason === undefined || reason === null || reason === '') return
  const value = String(reason)
  if (protocol === 'Anthropic') {
    if (['end_turn', 'stop_sequence'].includes(value)) return
    if (value === 'max_tokens') throw new Error('模型输出达到长度限制，内容未完成，请增大输出限制或分段生成')
    if (value === 'refusal') throw new Error('模型拒绝了本次请求，请调整要求后重试')
  } else if (protocol === 'Google Gemini') {
    if (value === 'STOP') return
    if (value === 'MAX_TOKENS') throw new Error('模型输出达到长度限制，内容未完成，请增大输出限制或分段生成')
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(value)) {
      throw new Error(`模型拦截了本次输出（${value}），请调整要求后重试`)
    }
  } else {
    if (value === 'stop') return
    if (value === 'length') throw new Error('模型输出达到长度限制，内容未完成，请增大输出限制或分段生成')
    if (value === 'content_filter') throw new Error('模型拦截了本次输出，请调整要求后重试')
  }
  throw new Error(`模型未正常完成输出（${value}），请重试`)
}

function ensureChatBody(protocol, body) {
  const error = chatResponseError(body)
  if (error) throw new Error(error)
  if (protocol === 'Anthropic') {
    ensureFinishReason(protocol, body?.stop_reason)
  } else if (protocol === 'Google Gemini') {
    if (body?.promptFeedback?.blockReason) {
      throw new Error(`模型拦截了本次请求（${body.promptFeedback.blockReason}），请调整要求后重试`)
    }
    ensureFinishReason(protocol, body?.candidates?.[0]?.finishReason)
  } else {
    const choice = body?.choices?.find((item) => item?.index === 0) ?? body?.choices?.[0]
    if (choice?.message?.refusal || choice?.delta?.refusal) throw new Error('模型拒绝了本次请求，请调整要求后重试')
    ensureFinishReason(protocol, choice?.finish_reason)
  }
}

/** A quiet connection may time out; an actively producing long novel does not. */
function createChatLifetime(externalSignal, idleTimeoutMs = CHAT_IDLE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutMs = Math.max(10, Number(idleTimeoutMs) || CHAT_IDLE_TIMEOUT_MS)
  let timer
  const onAbort = () => controller.abort(externalSignal.reason || new Error('请求已取消'))
  const touch = () => {
    clearTimeout(timer)
    if (controller.signal.aborted) return
    timer = setTimeout(() => {
      controller.abort(new Error(`模型响应等待超时，已取消请求，请检查网络、代理和上游服务状态`))
    }, timeoutMs)
    timer.unref?.()
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

async function chatWithUpstream(input, externalSignal, idleTimeoutMs) {
  const { protocol, endpoint, payload, headers } = buildChatRequest(input, false)
  const lifetime = createChatLifetime(externalSignal, idleTimeoutMs)
  let response
  try {
    response = await requestUpstreamStream(endpoint, input, payload, headers, () => false, lifetime)
  } catch (error) {
    throw lifetime.signal.aborted ? lifetime.signal.reason : error
  } finally {
    lifetime.close()
  }
  let body = null
  try { body = JSON.parse(response.text) } catch { /* preserve upstream text below */ }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(body?.error?.message || body?.message || `${response.status} ${response.statusText}`.trim())
  }
  ensureChatBody(protocol, body)
  const text = extractChatText(protocol, body)
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回有效内容')
  const source = protocol === 'Google Gemini' ? body?.usageMetadata : body?.usage
  return { text: text.trim(), usage: normalizedChatUsage(protocol, source) }
}

function createSseParser(onMessage) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let firstChunk = true
  let eventName = ''
  let dataLines = []
  const flush = () => {
    if (!dataLines.length) {
      eventName = ''
      return
    }
    const data = dataLines.join('\n')
    onMessage({ event: eventName, data })
    eventName = ''
    dataLines = []
  }
  return {
    push(chunk) {
      let text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)
      if (firstChunk && text) {
        text = text.replace(/^\uFEFF/, '')
        firstChunk = false
      }
      buffer += text
      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line) {
          flush()
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    },
    end() {
      buffer += decoder.end()
      if (buffer.trim()) {
        const trailing = buffer
        buffer = ''
        if (trailing.startsWith('data:')) dataLines.push(trailing.slice(5).replace(/^ /, ''))
      }
      flush()
    },
  }
}

function streamDeltaFromMessage(protocol, message) {
  const { event = '', data = '' } = message
  if (data === '[DONE]' && protocol !== 'Anthropic' && protocol !== 'Google Gemini') return { done: true }
  let body
  try { body = JSON.parse(data) } catch { throw new Error('上游模型返回了无效的流式数据') }
  ensureChatBody(protocol, body)
  if (protocol === 'Anthropic') {
    const usageSource = body?.usage ?? body?.message?.usage
    if (event === 'message_stop' || body?.type === 'message_stop') return { done: true, usageSource }
    if (event === 'message_delta' || body?.type === 'message_delta') ensureFinishReason(protocol, body?.delta?.stop_reason)
    const text = body?.delta?.text
    return { text: typeof text === 'string' ? text : '', usageSource }
  }
  if (protocol === 'Google Gemini') {
    const text = body?.candidates?.[0]?.content?.parts?.map((item) => item?.text || '').join('')
    return { text: typeof text === 'string' ? text : '', finished: body?.candidates?.[0]?.finishReason === 'STOP', usageSource: body?.usageMetadata }
  }
  const choice = body?.choices?.find((item) => item?.index === 0) ?? body?.choices?.[0]
  const delta = choice?.delta?.content
  const finished = choice?.finish_reason === 'stop'
  if (typeof delta === 'string') return { text: delta, finished, usageSource: body?.usage }
  if (Array.isArray(delta)) {
    const text = delta.map((item) => typeof item === 'string' ? item : item?.text || '').join('')
    return { text, finished, usageSource: body?.usage }
  }
  return { finished, usageSource: body?.usage }
}

/**
 * Stream a chat completion and invoke `onDelta` for each text fragment.
 * Providers that ignore `stream:true` are accepted as a single final chunk.
 */
async function chatWithUpstreamStream(input, onDelta, onUsage, externalSignal, idleTimeoutMs) {
  const { protocol, endpoint, payload, headers } = buildChatRequest(input, true)
  let sawSseMessage = false
  let completed = false
  let sawFinishReason = false
  let emittedText = ''
  let usageSource
  let usage
  let previousUsageJson = ''
  const parser = createSseParser((message) => {
    if (completed) return
    sawSseMessage = true
    const delta = streamDeltaFromMessage(protocol, message)
    if (delta.text) {
      emittedText += delta.text
      onDelta(delta.text)
    }
    if (delta.usageSource) {
      usageSource = mergeUsageSource(usageSource, delta.usageSource)
      usage = normalizedChatUsage(protocol, usageSource)
      const serialized = usage ? JSON.stringify(usage) : ''
      if (usage && serialized !== previousUsageJson) {
        previousUsageJson = serialized
        onUsage(usage)
      }
    }
    if (delta.finished) sawFinishReason = true
    if (delta.done) completed = true
  })
  const lifetime = createChatLifetime(externalSignal, idleTimeoutMs)
  let response
  try {
    response = await requestUpstreamStream(endpoint, input, payload, headers, (chunk) => {
      parser.push(chunk)
      return completed
    }, lifetime)
  } catch (error) {
    throw lifetime.signal.aborted ? lifetime.signal.reason : error
  } finally {
    lifetime.close()
  }
  parser.end()
  let body = null
  try { body = JSON.parse(response.text) } catch { /* SSE or non-JSON error */ }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(body?.error?.message || body?.message || `${response.status} ${response.statusText}`.trim())
  }
  const contentType = typeof response.headers?.get === 'function'
    ? response.headers.get('content-type') || ''
    : response.headers?.['content-type'] || ''
  if (String(contentType).toLowerCase().includes('text/event-stream')) {
    if (!sawSseMessage || !emittedText.trim()) throw new Error('模型没有返回有效内容')
    // OpenAI's final usage-only chunk follows finish_reason, then [DONE].
    // A clean EOF after an observed valid finish reason is also accepted for
    // compatible relays; EOF without either signal is still an interrupted run.
    if (!completed && !sawFinishReason) throw new Error('模型连接中断，响应尚未完成，请重试')
    return { text: emittedText.trim(), usage }
  }
  if (!emittedText.trim() && body) {
    ensureChatBody(protocol, body)
    const fallback = extractChatText(protocol, body)
    if (typeof fallback === 'string' && fallback.trim()) {
      emittedText = fallback
      onDelta(fallback)
    }
    const source = protocol === 'Google Gemini' ? body?.usageMetadata : body?.usage
    usage = normalizedChatUsage(protocol, source)
    if (usage) onUsage(usage)
  }
  if (!emittedText.trim()) throw new Error('模型没有返回有效内容')
  return { text: emittedText.trim(), usage }
}

function writeSse(res, event) {
  if (res.writableEnded || res.destroyed) return
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

async function handleStreamingChat(res, input, externalSignal, idleTimeoutMs) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
  })
  res.flushHeaders?.()
  try {
    await chatWithUpstreamStream(
      input,
      (text) => writeSse(res, { type: 'delta', text }),
      (usage) => writeSse(res, { type: 'usage', usage }),
      externalSignal,
      idleTimeoutMs,
    )
    writeSse(res, { type: 'done' })
  } catch (error) {
    writeSse(res, { type: 'error', error: safeUpstreamError(error, input) })
  } finally {
    res.end()
  }
}

export function createLocalApiServer({ host = HOST, port = PORT, storagePath = STORAGE_PATH, chatIdleTimeoutMs = CHAT_IDLE_TIMEOUT_MS } = {}) {
  let writeQueue = Promise.resolve()
  const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, PUT, POST, OPTIONS' })
    res.end()
    return
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    json(res, 200, { ok: true })
    return
  }
  if (req.method === 'GET' && req.url === '/api/storage') {
    try {
      json(res, 200, { ok: true, state: await readStorage(storagePath) })
    } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : '读取本地存储失败' })
    }
    return
  }
  if (req.method === 'PUT' && req.url === '/api/storage') {
    try {
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || !body.state || typeof body.state !== 'object') {
        throw new Error('存储内容格式无效')
      }
      if (!Number.isFinite(body.expectedUpdatedAt)) {
        json(res, 428, { ok: false, error: '缺少存储版本，拒绝覆盖本地数据' })
        return
      }
      const write = writeQueue.then(async () => {
        const current = await readStorage(storagePath)
        const currentUpdatedAt = Number(current?.updatedAt || 0)
        if (currentUpdatedAt !== body.expectedUpdatedAt) {
          return { conflict: true, updatedAt: currentUpdatedAt }
        }
        const existingIds = new Set((current?.projects ?? []).map((project) => project?.id).filter((id) => typeof id === 'string'))
        const incomingIds = new Set((body.state.projects ?? []).map((project) => project?.id).filter((id) => typeof id === 'string'))
        const removedProjectIds = [...existingIds].filter((id) => !incomingIds.has(id))
        if (removedProjectIds.length && body.allowProjectDeletion !== true) {
          return { conflict: true, updatedAt: currentUpdatedAt, error: '作品列表发生非预期变化，已阻止覆盖' }
        }
        await writeStorage(storagePath, body.state)
        return { conflict: false, updatedAt: Number(body.state.updatedAt || 0) }
      })
      writeQueue = write.then(() => undefined, () => undefined)
      const result = await write
      if (result.conflict) {
        json(res, 409, { ok: false, conflict: true, updatedAt: result.updatedAt, error: result.error || '本地数据已在其他窗口更新，已阻止旧数据覆盖' })
        return
      }
      json(res, 200, { ok: true, updatedAt: result.updatedAt })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : '写入本地存储失败' })
    }
    return
  }
  if (req.method !== 'POST' || !['/api/proxy/models', '/api/proxy/model-limits', '/api/proxy/test', '/api/proxy/chat', '/api/web/search'].includes(req.url)) {
    json(res, 404, { error: 'Not found' })
    return
  }
  let requestInput
  try {
    const input = await readJson(req)
    requestInput = input
    if (req.url === '/api/proxy/model-limits') {
      const controller = new AbortController()
      const onDisconnect = () => {
        if (!res.writableEnded) controller.abort(new Error('客户端已取消模型上限查询。'))
      }
      res.once('close', onDisconnect)
      try {
        const result = await fetchModelLimits(input, requestUpstream, controller.signal)
        if (!res.destroyed) json(res, 200, { ok: true, ...result })
      } finally {
        res.off('close', onDisconnect)
      }
      return
    }
    if (req.url === '/api/proxy/chat') {
      const controller = new AbortController()
      const onDisconnect = () => {
        if (!res.writableEnded) controller.abort(new Error('客户端已取消模型请求'))
      }
      res.once('close', onDisconnect)
      if (input?.stream === true || input?.stream === 'true') {
        try {
          await handleStreamingChat(res, input, controller.signal, chatIdleTimeoutMs)
        } finally {
          res.off('close', onDisconnect)
        }
        return
      }
      let result
      try {
        result = await chatWithUpstream(input, controller.signal, chatIdleTimeoutMs)
      } finally {
        res.off('close', onDisconnect)
      }
      json(res, 200, { ok: true, ...result })
      return
    }
    if (req.url === '/api/web/search') {
      const results = await searchWebMemes(input)
      json(res, 200, { ok: true, results, count: results.length, query: String(input.query || '').trim() })
      return
    }
    const models = await fetchModels(input)
    json(res, 200, { ok: true, models, count: models.length })
  } catch (error) {
    if (!res.destroyed) json(res, 502, { ok: false, error: safeUpstreamError(error, requestInput) })
  }
  })
  return server
}

export async function startLocalApiServer(options = {}) {
  const server = createLocalApiServer(options)
  const host = options.host ?? HOST
  const port = options.port ?? PORT
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
  return server
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  startLocalApiServer().then((server) => {
    const address = server.address()
    if (address && typeof address === 'object') console.log(`Novel Generator API proxy listening at http://${HOST}:${address.port}`)
  }).catch((error) => {
    console.error('Unable to start Novel Generator API proxy:', error)
    process.exitCode = 1
  })
}

