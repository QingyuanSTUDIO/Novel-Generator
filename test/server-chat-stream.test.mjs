import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { startLocalApiServer } from '../server/index.mjs'

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function createChatApi(t, handler, options = {}) {
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    requests.push({ url: req.url, body, headers: req.headers })
    handler(req, res, body)
  })
  const baseUrl = await listen(t, upstream)
  const local = await startLocalApiServer({ host: '127.0.0.1', port: 0, ...options })
  t.after(async () => {
    local.closeAllConnections?.()
    await new Promise((resolve) => local.close(resolve))
  })
  const apiUrl = `http://127.0.0.1:${local.address().port}/api/proxy/chat`
  return { baseUrl, apiUrl, requests }
}

function input(baseUrl, extra = {}) {
  return {
    baseUrl: `${baseUrl}/v1`,
    apiKey: 'test-key',
    model: 'test-model',
    messages: [{ role: 'user', content: '请写几句。' }],
    stream: true,
    ...extra,
  }
}

async function chat(api, extra = {}) {
  const response = await fetch(api.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input(api.baseUrl, extra)),
  })
  const text = await response.text()
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return { response, events: text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))), text }
  }
  return { response, body: JSON.parse(text), text }
}

const sse = (data, event) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const openaiDelta = (text) => ({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
const openaiStop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }

test('OpenAI stream preserves UTF-8 byte fragments and requests stream/json output upstream', async (t) => {
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const bytes = Buffer.from(`${sse(openaiDelta('风过竹林。'))}${sse(openaiStop)}${sse('[DONE]')}`.replace(/\n/g, '\r\n'))
    const firstCharacter = bytes.indexOf(Buffer.from('风'))
    res.write(bytes.subarray(0, firstCharacter + 1))
    setImmediate(() => res.end(bytes.subarray(firstCharacter + 1)))
  })
  const result = await chat(api, { responseFormat: 'json_object' })
  assert.deepEqual(result.events, [{ type: 'delta', text: '风过竹林。' }, { type: 'done' }])
  assert.equal(api.requests[0].url, '/v1/chat/completions')
  assert.equal(api.requests[0].body.stream, true)
  assert.deepEqual(api.requests[0].body.response_format, { type: 'json_object' })
})

test('Anthropic native stream waits for message_stop and reads text_delta blocks', async (t) => {
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      sse({ type: 'message_start', message: { role: 'assistant', content: [], stop_reason: null } }, 'message_start'),
      sse({ type: 'ping' }, 'ping'),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '月落。' } }, 'content_block_delta'),
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 'message_delta'),
      sse({ type: 'message_stop' }, 'message_stop'),
    ].join(''))
  })
  const result = await chat(api, { protocol: 'Anthropic' })
  assert.deepEqual(result.events, [{ type: 'delta', text: '月落。' }, { type: 'done' }])
  assert.equal(api.requests[0].url, '/v1/messages')
  assert.equal(api.requests[0].body.stream, true)
  assert.equal(api.requests[0].headers['x-api-key'], 'test-key')
})

test('Gemini native stream uses streamGenerateContent and STOP as its completion marker', async (t) => {
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse({ candidates: [{ content: { parts: [{ text: '山河远。' }] } }] })
      + sse({ candidates: [{ content: { parts: [{ text: '故人近。' }] }, finishReason: 'STOP' }] }))
  })
  const result = await chat(api, { protocol: 'Google Gemini', baseUrl: `${api.baseUrl}/v1beta` })
  assert.deepEqual(result.events, [{ type: 'delta', text: '山河远。' }, { type: 'delta', text: '故人近。' }, { type: 'done' }])
  assert.match(api.requests[0].url, /^\/v1beta\/models\/test-model:streamGenerateContent\?alt=sse&key=test-key$/)
})

test('streaming rejects empty, malformed, interrupted, refused, filtered and length-limited outputs', async (t) => {
  const scenarios = [
    { name: 'empty', stream: '', expected: /有效内容/ },
    { name: 'EOF without completion', stream: sse(openaiDelta('半段正文')), expected: /尚未完成/ },
    { name: 'malformed', stream: 'data: {oops}\n\n', expected: /无效/ },
    { name: 'refusal', stream: sse({ choices: [{ index: 0, delta: { refusal: '不能执行' } }] }), expected: /拒绝/ },
    { name: 'content filter', stream: sse({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }), expected: /拦截/ },
    { name: 'length', stream: sse(openaiDelta('半截')) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }), expected: /长度限制/ },
    { name: 'Anthropic error', protocol: 'Anthropic', stream: sse({ type: 'error', error: { type: 'overloaded_error', message: '服务过载' } }, 'error'), expected: /服务过载/ },
    { name: 'Anthropic truncated', protocol: 'Anthropic', stream: sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '未完' } }) + sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }), expected: /长度限制/ },
    { name: 'Gemini safety', protocol: 'Google Gemini', stream: sse({ candidates: [{ finishReason: 'SAFETY' }] }), expected: /拦截/ },
    { name: 'Gemini truncated', protocol: 'Google Gemini', stream: sse({ candidates: [{ content: { parts: [{ text: '未完' }] }, finishReason: 'MAX_TOKENS' }] }), expected: /长度限制/ },
  ]
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (sub) => {
      const api = await createChatApi(sub, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(scenario.stream)
      })
      const result = await chat(api, { protocol: scenario.protocol || 'OpenAI Compatible' })
      assert.equal(result.events.some((event) => event.type === 'done'), false)
      assert.match(result.events.at(-1).error, scenario.expected)
    })
  }
})

test('HTTP failures never leak SSE-looking error text as model output', async (t) => {
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(401, { 'content-type': 'text/event-stream' })
    res.end(sse(openaiDelta('不该显示的错误页面')))
  })
  const result = await chat(api)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].type, 'error')
  assert.match(result.events[0].error, /401/)
})

test('a provider ignoring streaming may return a complete JSON response', async (t) => {
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '完整正文' }, finish_reason: 'stop' }] }))
  })
  assert.deepEqual((await chat(api)).events, [{ type: 'delta', text: '完整正文' }, { type: 'done' }])
})

test('stream:false preserves the JSON response and sends no stream flag upstream', async (t) => {
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '普通正文' }, finish_reason: 'stop' }] }))
  })
  const result = await chat(api, { stream: false })
  assert.deepEqual(result.body, { ok: true, text: '普通正文' })
  assert.equal(api.requests[0].body.stream, undefined)
})

test('quiet upstream connections time out and are actually closed', async (t) => {
  let resolveClosed
  const closed = new Promise((resolve) => { resolveClosed = resolve })
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    res.on('close', resolveClosed)
  }, { chatIdleTimeoutMs: 35 })
  const result = await chat(api)
  assert.equal(result.events.at(-1).type, 'error')
  assert.match(result.events.at(-1).error, /超时/)
  let timer
  try {
    await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('超时后上游连接没有关闭')), 1000) })])
  } finally {
    clearTimeout(timer)
  }
})

test('active streaming can exceed the idle timeout in total duration', async (t) => {
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let count = 0
    res.write(sse(openaiDelta('开始。')))
    const timer = setInterval(() => {
      count += 1
      res.write(sse(openaiDelta('继续。')))
      if (count === 5) {
        clearInterval(timer)
        res.end(sse('[DONE]'))
      }
    }, 20)
    res.on('close', () => clearInterval(timer))
  }, { chatIdleTimeoutMs: 60 })
  const result = await chat(api)
  assert.equal(result.events.at(-1).type, 'done')
  assert.equal(result.events.filter((event) => event.type === 'delta').length, 6)
})

test('HTTP proxy streaming uses the selected proxy rather than buffering to completion', async (t) => {
  const proxyRequests = []
  const proxy = http.createServer(async (req, res) => {
    proxyRequests.push(req.url)
    for await (const _chunk of req) { /* consume upload */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(openaiDelta('代理正文')) + sse('[DONE]'))
  })
  const proxyUrl = await listen(t, proxy)
  const api = await createChatApi(t, () => { throw new Error('不应直接访问上游') })
  const result = await chat(api, { baseUrl: 'http://example.invalid/v1', useProxy: true, proxyHost: '127.0.0.1', proxyPort: new URL(proxyUrl).port })
  assert.deepEqual(result.events, [{ type: 'delta', text: '代理正文' }, { type: 'done' }])
  assert.deepEqual(proxyRequests, ['http://example.invalid/v1/chat/completions'])
})

test('canceling the desktop response immediately cancels the upstream generation', async (t) => {
  let resolveClosed
  const upstreamClosed = new Promise((resolve) => { resolveClosed = resolve })
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.on('close', resolveClosed)
    res.write(sse(openaiDelta('开头。')))
  })
  const response = await fetch(api.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input(api.baseUrl)),
  })
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  reader.releaseLock()
  let timer
  try {
    await Promise.race([upstreamClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('客户端取消后上游仍在生成')), 1000) })])
  } finally {
    clearTimeout(timer)
  }
})

test('proxy redacts only the request API key from HTTP and SSE errors, including encoded echoes', async (t) => {
  const apiKey = 'sk-private/A+B==?'
  const encoded = encodeURIComponent(apiKey)
  const lowerEncoded = encoded.replace(/%[0-9a-f]{2}/gi, (value) => value.toLowerCase())
  const doubleEncoded = encodeURIComponent(encoded)
  const message = `401 authorization failed for ${apiKey}; URL key=${encoded}; lower=${lowerEncoded}; nested=${doubleEncoded}; model test-model is unavailable`
  for (const [name, stream, nativeSse] of [
    ['stream HTTP error', true, false],
    ['plain HTTP error', false, false],
    ['native SSE error', true, true],
  ]) {
    await t.test(name, async (sub) => {
      const api = await createChatApi(sub, (_req, res) => {
        if (nativeSse) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(sse({ error: { message } }))
        } else {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message } }))
        }
      })
      const result = await chat(api, { stream, apiKey })
      const error = stream ? result.events.at(-1).error : result.body.error
      assert.match(error, /401 authorization failed/)
      assert.match(error, /model test-model is unavailable/)
      assert.match(error, /\[已隐藏密钥\]/)
      for (const value of [apiKey, encoded, lowerEncoded, doubleEncoded]) {
        assert.equal(result.text.includes(value), false)
      }
    })
  }
})

test('short local credentials do not erase unrelated model names or ordinary words', async (t) => {
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: "Model abc-model is unavailable; token 'abc' is invalid" } }))
  })
  const result = await chat(api, { stream: false, apiKey: 'abc' })
  assert.equal(result.body.error, "Model abc-model is unavailable; token '[已隐藏密钥]' is invalid")
})

test('model-list errors also redact the submitted credential before reaching settings', async (t) => {
  const apiKey = 'sk-model-list-secret'
  const api = await createChatApi(t, (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `API key '${apiKey}' rejected; permission denied` } }))
  })
  const response = await fetch(api.apiUrl.replace(/\/chat$/, '/models'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input(api.baseUrl, { apiKey })),
  })
  const body = await response.json()
  assert.match(body.error, /permission denied/)
  assert.equal(JSON.stringify(body).includes(apiKey), false)
})

