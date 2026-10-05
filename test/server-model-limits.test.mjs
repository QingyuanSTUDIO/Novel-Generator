import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { startLocalApiServer } from '../server/index.mjs'

const testKey = 'limits-test-secret-37+/='
const writeJson = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function createLimitsApi(t, handler) {
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }
    requests.push(record)
    handler(req, res, record)
  })
  const baseUrl = await listen(t, upstream)
  const local = await startLocalApiServer({ host: '127.0.0.1', port: 0 })
  t.after(async () => {
    local.closeAllConnections?.()
    await new Promise((resolve) => local.close(resolve))
  })
  return {
    baseUrl,
    requests,
    async query(extra = {}) {
      const response = await fetch(`http://127.0.0.1:${local.address().port}/api/proxy/model-limits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: `${baseUrl}/v1`,
          protocol: 'OpenAI Compatible',
          model: 'selected-model',
          apiKey: testKey,
          ...extra,
        }),
      })
      const text = await response.text()
      return { status: response.status, body: JSON.parse(text), text }
    },
  }
}

function assertNoGeneration(requests) {
  assert.ok(requests.length > 0)
  for (const request of requests) {
    assert.equal(request.method, 'GET')
    assert.equal(request.body, '')
    assert.doesNotMatch(request.url, /chat\/completions|messages|generateContent|streamGenerateContent/)
  }
}

function assertUnknown(result) {
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.contextTokens, undefined)
  assert.match(result.body.message, /未提供|未返回|无法|未知|不支持/)
}

test('rich model detail returns explicit context and output limits through metadata-only GET', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url === '/v1/models/selected-model') {
      writeJson(res, { id: 'selected-model', context_length: 65536, max_output_tokens: 4096 })
    } else writeJson(res, { error: { message: 'unexpected metadata path' } }, 404)
  })
  const result = await api.query()
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.model, 'selected-model')
  assert.equal(result.body.contextTokens, 65536)
  assert.equal(result.body.maxOutputTokens, 4096)
  assert.equal(result.body.contextKind, 'context_window')
  assert.equal(api.requests.length, 1)
  assert.equal(api.requests[0].headers.authorization, `Bearer ${testKey}`)
  assert.ok(result.body.source)
  assert.equal(result.text.includes(testKey), false)
  assertNoGeneration(api.requests)
})

test('a 404 detail endpoint falls back to the list and picks the exact selected model', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url === '/v1/models/selected-model') writeJson(res, { error: { message: 'no detail API' } }, 404)
    else if (req.url === '/v1/models') {
      writeJson(res, {
        data: [
          { id: 'other-model', context_length: 999999 },
          { id: 'selected-model-pro', context_length: 888888 },
          { id: 'selected-model', context_length: 32768, max_output_tokens: 2048 },
        ],
      })
    } else writeJson(res, { error: { message: 'not found' } }, 404)
  })
  const result = await api.query()
  assert.equal(result.status, 200)
  assert.equal(result.body.contextTokens, 32768)
  assert.equal(result.body.maxOutputTokens, 2048)
  assert.equal(result.body.model, 'selected-model')
  assert.ok(api.requests.some((request) => request.url === '/v1/models'))
  assertNoGeneration(api.requests)
})

test('first-row and substring capacities cannot fill a selected model with no capacity metadata', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url === '/v1/models') {
      writeJson(res, {
        data: [
          { id: 'first-model', context_length: 65536 },
          { id: 'selected-model-extra', context_length: 32768 },
          { id: 'selected-model', owned_by: 'relay', created: 12345 },
        ],
      })
    } else writeJson(res, { error: { message: 'no detail endpoint' } }, 404)
  })
  const result = await api.query()
  assertUnknown(result)
  assert.equal(result.body.model, 'selected-model')
  assert.equal(result.body.maxInputTokens, undefined)
  assert.equal(result.body.maxOutputTokens, undefined)
  assertNoGeneration(api.requests)
})

test('a detail response for a different model is discarded before reading the exact list record', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url === '/v1/models/selected-model') {
      writeJson(res, { id: 'different-model', context_length: 777777 })
    } else if (req.url === '/v1/models') {
      writeJson(res, { data: [{ id: 'selected-model', context_length: 48000 }] })
    } else writeJson(res, { error: { message: 'not found' } }, 404)
  })
  const result = await api.query()
  assert.equal(result.status, 200)
  assert.equal(result.body.model, 'selected-model')
  assert.equal(result.body.contextTokens, 48000)
  assert.equal(api.requests.length, 2)
  assertNoGeneration(api.requests)
})

test('a relay model string identifies the selected detail model without treating display names as IDs', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url === '/v1/models/selected-model') {
      writeJson(res, { model: 'selected-model', name: 'Friendly display name', context_length: 36000 })
    } else writeJson(res, { error: { message: 'not found' } }, 404)
  })
  const result = await api.query()
  assert.equal(result.status, 200)
  assert.equal(result.body.contextTokens, 36000)
  assert.equal(api.requests.length, 1)
  assertNoGeneration(api.requests)
})

test('wrong or conflicting relay model identifiers cannot supply capacity in detail or list responses', async (t) => {
  for (const detail of [
    { model: 'other-model', context_length: 999999 },
    { id: 'selected-model', model: 'other-model', context_length: 999999 },
  ]) {
    const api = await createLimitsApi(t, (req, res) => {
      if (req.url === '/v1/models/selected-model') {
        writeJson(res, detail)
      } else if (req.url === '/v1/models') {
        writeJson(res, { data: [
          { id: 'selected-model', model: 'other-model', context_length: 888888 },
          { model: 'selected-model-extra', context_length: 777777 },
          { model: 'selected-model', context_length: 42000 },
        ] })
      } else writeJson(res, { error: { message: 'not found' } }, 404)
    })
    const result = await api.query()
    assert.equal(result.status, 200)
    assert.equal(result.body.model, 'selected-model')
    assert.equal(result.body.contextTokens, 42000)
    assert.equal(api.requests.length, 2)
    assertNoGeneration(api.requests)
  }
})

test('ordinary metadata without capacity returns unknown without guessing from model names', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url.endsWith('/models/gpt-famous-looking-model')) {
      writeJson(res, { id: 'gpt-famous-looking-model', object: 'model', owned_by: 'openai', created: 1760000000 })
    } else if (req.url.endsWith('/models')) {
      writeJson(res, { data: [{ id: 'gpt-famous-looking-model' }] })
    } else writeJson(res, { error: { message: 'not found' } }, 404)
  })
  const result = await api.query({ model: 'gpt-famous-looking-model' })
  assertUnknown(result)
  assert.equal(result.body.maxInputTokens, undefined)
  assert.equal(result.body.maxOutputTokens, undefined)
  assertNoGeneration(api.requests)
})

test('output-only metadata remains unknown context while preserving the known output limit', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url === '/v1/models/selected-model') {
      writeJson(res, { id: 'selected-model', max_output_tokens: 8192 })
    } else if (req.url === '/v1/models') {
      writeJson(res, { data: [{ id: 'selected-model', max_output_tokens: 8192 }] })
    } else writeJson(res, { error: { message: 'not found' } }, 404)
  })
  const result = await api.query()
  assertUnknown(result)
  assert.equal(result.body.maxOutputTokens, 8192)
  assertNoGeneration(api.requests)
})

test('native Gemini keeps input/output limits distinct, normalizes models namespace, and hides query credentials', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    const url = new URL(req.url, 'http://upstream.invalid')
    if (url.pathname === '/v1beta/models/gemini-mock') {
      writeJson(res, { name: 'models/gemini-mock', inputTokenLimit: 1048576, outputTokenLimit: 8192 })
    } else writeJson(res, { error: { message: 'not found' } }, 404)
  })
  const result = await api.query({
    protocol: 'Google Gemini',
    baseUrl: `${api.baseUrl}/v1beta`,
    model: 'models/gemini-mock',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.model.replace(/^models\//, ''), 'gemini-mock')
  assert.equal(result.body.contextTokens, 1048576)
  assert.equal(result.body.maxInputTokens, 1048576)
  assert.equal(result.body.maxOutputTokens, 8192)
  assert.equal(result.body.contextKind, 'input_limit')
  assert.equal(api.requests.length, 1)
  const requestUrl = new URL(api.requests[0].url, api.baseUrl)
  assert.equal(requestUrl.pathname, '/v1beta/models/gemini-mock')
  assert.equal(requestUrl.searchParams.get('key'), testKey)
  assert.equal(api.requests[0].headers.authorization, undefined)
  assert.equal(api.requests[0].headers['x-api-key'], undefined)
  assert.equal(result.body.source, `${api.baseUrl}/v1beta/models/gemini-mock`)
  assert.equal(result.text.includes(testKey), false)
  assert.equal(result.text.includes(encodeURIComponent(testKey)), false)
  assert.doesNotMatch(result.body.source, /\?/)
  assertNoGeneration(api.requests)
})

test('native Anthropic treats max_input_tokens as input-only and max_tokens as output capacity', async (t) => {
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url === '/v1/models/claude-mock') {
      writeJson(res, { id: 'claude-mock', max_input_tokens: 200000, max_tokens: 16384 })
    } else writeJson(res, { error: { message: 'not found' } }, 404)
  })
  const result = await api.query({ protocol: 'Anthropic', model: 'claude-mock' })
  assert.equal(result.status, 200)
  assert.equal(result.body.contextTokens, 200000)
  assert.equal(result.body.maxInputTokens, 200000)
  assert.equal(result.body.maxOutputTokens, 16384)
  assert.equal(result.body.contextKind, 'input_limit')
  assert.equal(api.requests.length, 1)
  assert.equal(api.requests[0].headers['x-api-key'], testKey)
  assert.equal(api.requests[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(api.requests[0].headers.authorization, undefined)
  assertNoGeneration(api.requests)
})

test('native Gemini list pagination locates the selected model on a later page without exposing page queries', async (t) => {
  const pageToken = 'next-page+/='
  const api = await createLimitsApi(t, (req, res) => {
    const url = new URL(req.url, 'http://upstream.invalid')
    if (url.pathname !== '/v1beta/models') {
      writeJson(res, { error: { message: 'no detail endpoint' } }, 404)
    } else if (url.searchParams.get('pageToken') === pageToken) {
      writeJson(res, { models: [{ name: 'models/gemini-paged', inputTokenLimit: 131072, outputTokenLimit: 4096 }] })
    } else {
      writeJson(res, {
        models: [{ name: 'models/unrelated-model', inputTokenLimit: 999999 }],
        nextPageToken: pageToken,
      })
    }
  })
  const result = await api.query({
    protocol: 'Google Gemini',
    baseUrl: `${api.baseUrl}/v1beta`,
    model: 'gemini-paged',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.contextTokens, 131072)
  assert.equal(result.body.maxOutputTokens, 4096)
  assert.equal(result.body.contextKind, 'input_limit')
  assert.equal(result.body.source, `${api.baseUrl}/v1beta/models`)
  assert.equal(result.text.includes(testKey), false)
  assert.equal(result.text.includes(pageToken), false)
  assert.equal(api.requests.length, 3)
  const pageRequest = api.requests.at(-1)
  const url = new URL(pageRequest.url, api.baseUrl)
  assert.equal(url.searchParams.get('pageToken'), pageToken)
  assert.equal(url.searchParams.get('key'), testKey)
  assertNoGeneration(api.requests)
})

test('a 401 metadata error stops path probing immediately and masks raw and URL-encoded credentials', async (t) => {
  const api = await createLimitsApi(t, (_req, res) => {
    writeJson(res, {
      error: { message: `401 invalid key ${testKey} and encoded ${encodeURIComponent(testKey)}` },
    }, 401)
  })
  const result = await api.query({ baseUrl: api.baseUrl })
  assert.equal(result.status, 502)
  assert.equal(result.body.ok, false)
  assert.match(result.body.error, /401/)
  assert.equal(result.text.includes(testKey), false)
  assert.equal(result.text.includes(encodeURIComponent(testKey)), false)
  assert.equal(api.requests.length, 1)
  assertNoGeneration(api.requests)
})

test('namespaced selected model IDs are encoded as one detail path component', async (t) => {
  const model = 'vendor/model.with space/版本'
  const expectedPath = `/v1/models/${encodeURIComponent(model)}`
  const api = await createLimitsApi(t, (req, res) => {
    if (req.url === expectedPath) writeJson(res, { id: model, context_length: 64000 })
    else writeJson(res, { error: { message: 'unexpected path' } }, 404)
  })
  const result = await api.query({ model })
  assert.equal(result.status, 200)
  assert.equal(result.body.model, model)
  assert.equal(result.body.contextTokens, 64000)
  assert.deepEqual(api.requests.map((request) => request.url), [expectedPath])
  assertNoGeneration(api.requests)
})

test('an explicitly configured HTTP proxy carries metadata GET and is the only outbound destination', async (t) => {
  const api = await createLimitsApi(t, (_req, res) => {
    writeJson(res, { error: { message: 'must not bypass configured proxy' } }, 500)
  })
  const proxyRequests = []
  const proxy = http.createServer((req, res) => {
    proxyRequests.push({ url: req.url, method: req.method, headers: req.headers })
    writeJson(res, { id: 'selected-model', context_length: 96000, max_output_tokens: 8192 })
  })
  const proxyUrl = await listen(t, proxy)
  const result = await api.query({
    useProxy: true,
    proxyHost: '127.0.0.1',
    proxyPort: new URL(proxyUrl).port,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.contextTokens, 96000)
  assert.deepEqual(api.requests, [])
  assert.equal(proxyRequests.length, 1)
  assert.equal(proxyRequests[0].method, 'GET')
  assert.equal(proxyRequests[0].url, `${api.baseUrl}/v1/models/selected-model`)
  assert.equal(proxyRequests[0].headers.authorization, `Bearer ${testKey}`)
})

test('missing model, key or base URL fails locally before probing or generating', async (t) => {
  const api = await createLimitsApi(t, (_req, res) => {
    writeJson(res, { id: 'selected-model', context_length: 128000 })
  })
  for (const extra of [{ model: '' }, { apiKey: '' }, { baseUrl: '' }]) {
    const result = await api.query(extra)
    assert.equal(result.status, 502)
    assert.equal(result.body.ok, false)
    assert.ok(result.body.error)
    assert.equal(result.body.contextTokens, undefined)
  }
  assert.deepEqual(api.requests, [])
})
