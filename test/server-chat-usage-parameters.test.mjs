import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { startLocalApiServer } from '../server/index.mjs'

async function createApi(t, handler) {
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') })
    handler(req, res, requests.at(-1).body)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const local = await startLocalApiServer({ host: '127.0.0.1', port: 0 })
  t.after(async () => {
    upstream.closeAllConnections?.()
    local.closeAllConnections?.()
    await Promise.all([new Promise((resolve) => upstream.close(resolve)), new Promise((resolve) => local.close(resolve))])
  })
  return {
    requests,
    async chat(extra = {}) {
      const response = await fetch(`http://127.0.0.1:${local.address().port}/api/proxy/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          apiKey: 'mock-key',
          protocol: 'OpenAI Compatible',
          model: 'mock-model-with-no-inferred-capabilities',
          messages: [{ role: 'user', content: '写一句。' }],
          stream: false,
          ...extra,
        }),
      })
      const text = await response.text()
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        return { status: response.status, events: text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))) }
      }
      return { status: response.status, body: JSON.parse(text) }
    },
  }
}

function modelJson(protocol, usage) {
  if (protocol === 'Anthropic') return { content: [{ type: 'text', text: '正文。' }], stop_reason: 'end_turn', usage }
  if (protocol === 'Google Gemini') return { candidates: [{ content: { parts: [{ text: '正文。' }] }, finishReason: 'STOP' }], usageMetadata: usage }
  return { choices: [{ message: { content: '正文。' }, finish_reason: 'stop' }], usage }
}

const writeJson = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const sse = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const openaiText = { choices: [{ index: 0, delta: { content: '正文。' }, finish_reason: null }] }
const openaiFinish = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }

test('OpenAI parameters map explicitly, preserve zero and keep client metadata out of upstream JSON', async (t) => {
  const api = await createApi(t, (_req, res) => writeJson(res, modelJson('OpenAI Compatible')))
  const result = await api.chat({
    maxTokens: 4096, temperature: 0, topP: 0, frequencyPenalty: 0, presencePenalty: -2,
    outputTokenParameter: 'max_completion_tokens',
    contextTokens: 32000, historyTokens: 4000, providerId: 'private-preset', purpose: 'writer',
  })
  assert.equal(result.status, 200)
  const body = api.requests[0].body
  assert.equal(body.max_completion_tokens, 4096)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.temperature, 0)
  assert.equal(body.top_p, 0)
  assert.equal(body.frequency_penalty, 0)
  assert.equal(body.presence_penalty, -2)
  for (const key of ['contextTokens', 'historyTokens', 'providerId', 'purpose']) assert.equal(key in body, false)
})

test('unset parameters remain omitted and default OpenAI output field is max_tokens', async (t) => {
  const api = await createApi(t, (_req, res) => writeJson(res, modelJson('OpenAI Compatible')))
  await api.chat({ maxTokens: 8000, temperature: '', topP: null, frequencyPenalty: ' ', presencePenalty: undefined })
  const body = api.requests[0].body
  assert.equal(body.max_tokens, 8000)
  assert.equal(body.max_completion_tokens, undefined)
  for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) assert.equal(key in body, false)
})

test('native Anthropic maps supported values and retains required max_tokens for older callers', async (t) => {
  const api = await createApi(t, (_req, res) => writeJson(res, modelJson('Anthropic')))
  await api.chat({ protocol: 'Anthropic', maxTokens: 8192, temperature: 1, topP: 0.9, outputTokenParameter: 'max_completion_tokens' })
  assert.equal(api.requests[0].body.max_tokens, 8192)
  assert.equal(api.requests[0].body.max_completion_tokens, undefined)
  assert.equal(api.requests[0].body.temperature, 1)
  assert.equal(api.requests[0].body.top_p, 0.9)
  await api.chat({ protocol: 'Anthropic' })
  assert.equal(api.requests[1].body.max_tokens, 1600)
  assert.equal(api.requests[1].body.temperature, undefined)
})

test('native Gemini maps generationConfig including officially supported penalties', async (t) => {
  const api = await createApi(t, (_req, res) => writeJson(res, modelJson('Google Gemini')))
  await api.chat({ protocol: 'Google Gemini', maxTokens: 8192, temperature: 1.5, topP: 0.8, frequencyPenalty: -0.2, presencePenalty: 0.3, responseFormat: 'json_object' })
  assert.deepEqual(api.requests[0].body.generationConfig, {
    maxOutputTokens: 8192, temperature: 1.5, topP: 0.8, frequencyPenalty: -0.2, presencePenalty: 0.3, responseMimeType: 'application/json',
  })
  assert.equal(api.requests[0].body.max_tokens, undefined)
  assert.equal(api.requests[0].body.temperature, undefined)
})

test('invalid explicit parameter values are rejected before making an upstream request', async (t) => {
  const api = await createApi(t, (_req, res) => writeJson(res, modelJson('OpenAI Compatible')))
  for (const [settings, expected] of [
    [{ maxTokens: 0 }, /最大输出/], [{ maxTokens: 1.2 }, /整数/],
    [{ temperature: -1 }, /温度/], [{ temperature: 2.1 }, /温度/],
    [{ protocol: 'Anthropic', temperature: 1.1 }, /温度/],
    [{ topP: 1.2 }, /Top P/], [{ frequencyPenalty: -2.1 }, /频率惩罚/],
    [{ presencePenalty: true }, /存在惩罚/],
    [{ outputTokenParameter: 'guess-by-model' }, /输出 Tokens 字段/],
    [{ includeUsage: 'true' }, /用量统计/],
    [{ protocol: 'Anthropic', frequencyPenalty: 0 }, /Anthropic.*不支持/],
  ]) {
    const result = await api.chat(settings)
    assert.equal(result.status, 502)
    assert.match(result.body.error, expected)
  }
  assert.deepEqual(api.requests, [])
})

test('stream includeUsage only requests OpenAI stream_options when enabled', async (t) => {
  const api = await createApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(openaiText) + sse('[DONE]'))
  })
  await api.chat({ stream: true, includeUsage: true })
  assert.deepEqual(api.requests[0].body.stream_options, { include_usage: true })
  await api.chat({ stream: true, includeUsage: false })
  assert.equal(api.requests[1].body.stream_options, undefined)
})

test('OpenAI final usage-only chunk arrives after finish_reason and before local done', async (t) => {
  const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 6 } }
  const api = await createApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse(openaiText) + sse(openaiFinish))
    setImmediate(() => res.end(sse({ choices: [], usage }) + sse('[DONE]')))
  })
  const result = await api.chat({ stream: true, includeUsage: true })
  assert.deepEqual(result.events, [
    { type: 'delta', text: '正文。' },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 80, reasoningTokens: 6 } },
    { type: 'done' },
  ])
})

test('a compatible stream cleanly ending after finish still keeps its final usage', async (t) => {
  const api = await createApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(openaiText) + sse(openaiFinish) + sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }))
  })
  const result = await api.chat({ stream: true })
  assert.equal(result.events.at(-1).type, 'done')
  assert.deepEqual(result.events.find((event) => event.type === 'usage').usage, { inputTokens: 8, outputTokens: 2, totalTokens: 10 })
})

test('non-stream usage distinguishes unknown cache data from explicit zeros and supports relay aliases', async (t) => {
  for (const [name, usage, expected] of [
    ['unknown cache', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, { inputTokens: 10, outputTokens: 2, totalTokens: 12 }],
    ['explicit zero', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }],
    ['new details', { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 } }, { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4, cacheWriteTokens: 3 }],
    ['prompt details cache write', { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 5 } }, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 5 }],
    ['relay root cache write', { prompt_tokens: 10, completion_tokens: 2, cache_write_tokens: 0 }, { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 0 }],
    ['DeepSeek cache', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 }, { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4, uncachedInputTokens: 6 }],
    ['malformed counts', { prompt_tokens: '10', completion_tokens: -1, total_tokens: null, prompt_tokens_details: { cached_tokens: false } }, undefined],
  ]) {
    await t.test(name, async (sub) => {
      const api = await createApi(sub, (_req, res) => writeJson(res, modelJson('OpenAI Compatible', usage)))
      const result = await api.chat()
      assert.equal(result.body.text, '正文。')
      assert.deepEqual(result.body.usage, expected)
    })
  }
})

test('Anthropic reports total input only when uncached, cache read and cache write are all known', async (t) => {
  for (const [name, usage, expected] of [
    ['complete', { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 }, { inputTokens: 120, outputTokens: 10, totalTokens: 130, cachedInputTokens: 60, cacheWriteTokens: 20, uncachedInputTokens: 40 }],
    ['missing caches', { input_tokens: 40, output_tokens: 10 }, { outputTokens: 10, uncachedInputTokens: 40 }],
    ['explicit zero caches', { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { inputTokens: 40, outputTokens: 10, totalTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 40 }],
  ]) {
    await t.test(name, async (sub) => {
      const api = await createApi(sub, (_req, res) => writeJson(res, modelJson('Anthropic', usage)))
      const result = await api.chat({ protocol: 'Anthropic' })
      assert.deepEqual(result.body.usage, expected)
    })
  }
})

test('Anthropic streaming usage merges cumulative start/delta values without double-counting caches', async (t) => {
  const api = await createApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse({ type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 } } })
      + sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '正文。' } })
      + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: null, output_tokens: 10, cache_read_input_tokens: null } })
      + sse({ type: 'message_stop' }))
  })
  const result = await api.chat({ protocol: 'Anthropic', stream: true })
  assert.equal(result.events.at(-1).type, 'done')
  const usage = result.events.filter((event) => event.type === 'usage').at(-1).usage
  assert.deepEqual(usage, { inputTokens: 120, outputTokens: 10, totalTokens: 130, cachedInputTokens: 60, cacheWriteTokens: 20, uncachedInputTokens: 40 })
})

test('Gemini maps usageMetadata in plain and streaming responses, including a metadata-only tail', async (t) => {
  const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 125, cachedContentTokenCount: 80, thoughtsTokenCount: 5 }
  const expected = { inputTokens: 100, outputTokens: 20, totalTokens: 125, cachedInputTokens: 80, reasoningTokens: 5 }
  const plain = await createApi(t, (_req, res) => writeJson(res, modelJson('Google Gemini', usageMetadata)))
  assert.deepEqual((await plain.chat({ protocol: 'Google Gemini' })).body.usage, expected)
  const streaming = await createApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse({ candidates: [{ content: { parts: [{ text: '正文。' }] }, finishReason: 'STOP' }] }) + sse({ usageMetadata }))
  })
  const result = await streaming.chat({ protocol: 'Google Gemini', stream: true })
  assert.equal(result.events.at(-1).type, 'done')
  assert.deepEqual(result.events.find((event) => event.type === 'usage').usage, expected)
})

test('missing usage never prevents a complete response from succeeding', async (t) => {
  const api = await createApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(openaiText) + sse(openaiFinish) + sse('[DONE]'))
  })
  const result = await api.chat({ stream: true, includeUsage: true })
  assert.deepEqual(result.events, [{ type: 'delta', text: '正文。' }, { type: 'done' }])
})

test('malformed trailing usage does not overwrite valid stream statistics', async (t) => {
  const api = await createApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(openaiText)
      + sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 } } })
      + sse(openaiFinish)
      + sse({ choices: [], usage: { prompt_tokens: '12', total_tokens: -1, prompt_tokens_details: { cached_tokens: false, cache_write_tokens: null } } })
      + sse('[DONE]'))
  })
  const result = await api.chat({ stream: true })
  assert.deepEqual(result.events, [
    { type: 'delta', text: '正文。' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4, cacheWriteTokens: 3 } },
    { type: 'done' },
  ])
})

