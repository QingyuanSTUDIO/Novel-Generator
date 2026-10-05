import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { requestChat } from '../src/api/chat.ts'

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`
const request = { baseUrl: 'http://example.invalid/v1', apiKey: 'test', model: 'test', messages: [], stream: true }

function closeSignal() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return {
    resolve,
    async wait() {
      let timer
      try {
        await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('取消后连接没有关闭')), 1000) })])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function createClientApi(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    handler(req, res, body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  return (path) => `http://127.0.0.1:${server.address().port}${path}`
}

test('client consumes split UTF-8 events in order and completes without waiting for socket EOF', async (t) => {
  const closed = closeSignal()
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.on('close', closed.resolve)
    const bytes = Buffer.from(sse({ type: 'delta', text: '你好' }) + sse({ type: 'delta', text: '，世界。' }) + sse({ type: 'done' }))
    const split = bytes.indexOf(Buffer.from('你')) + 1
    res.write(bytes.subarray(0, split))
    setImmediate(() => res.write(bytes.subarray(split)))
  })
  const events = []
  const deltas = []
  const text = await requestChat(localApiUrl, request, { onEvent: (event) => events.push(event), onDelta: (delta) => deltas.push(delta) })
  assert.equal(text, '你好，世界。')
  assert.deepEqual(deltas, ['你好', '，世界。'])
  assert.deepEqual(events.map((event) => event.type), ['delta', 'delta', 'done'])
  await closed.wait()
})

test('client rejects EOF, empty completion, malformed events and model errors', async (t) => {
  for (const [name, response, expected] of [
    ['EOF', sse({ type: 'delta', text: '未完成' }), /尚未完成/],
    ['empty', sse({ type: 'done' }), /有效内容/],
    ['malformed', 'data: {oops}\n\n', /无效/],
    ['unknown', sse({ type: 'unexpected' }), /未知/],
    ['error', sse({ type: 'delta', text: '半截' }) + sse({ type: 'error', error: '长度限制' }), /长度限制/],
  ]) {
    await t.test(name, async (sub) => {
      const localApiUrl = await createClientApi(sub, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(response)
      })
      await assert.rejects(requestChat(localApiUrl, request), expected)
    })
  }
})

test('client does not emit content from a failed HTTP response', async (t) => {
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(502, { 'content-type': 'text/event-stream' })
    res.end(sse({ type: 'delta', text: '不应显示' }))
  })
  const deltas = []
  await assert.rejects(requestChat(localApiUrl, request, { onDelta: (text) => deltas.push(text) }), /502/)
  assert.deepEqual(deltas, [])
})

test('client accepts non-stream responses with stream enabled or disabled', async (t) => {
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, text: '完整正文' }))
  })
  assert.equal(await requestChat(localApiUrl, request), '完整正文')
  assert.equal(await requestChat(localApiUrl, { ...request, stream: false }), '完整正文')
})

test('client cancels the actual reader when a consumer callback fails', async (t) => {
  const closed = closeSignal()
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.on('close', closed.resolve)
    res.write(sse({ type: 'delta', text: '正文' }))
  })
  await assert.rejects(requestChat(localApiUrl, request, { onDelta: () => { throw new Error('UI callback error') } }), /UI callback error/)
  await closed.wait()
})

test('client idle timeout closes the connection and reports a useful timeout', async (t) => {
  const closed = closeSignal()
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    res.on('close', closed.resolve)
  })
  await assert.rejects(requestChat(localApiUrl, request, { idleTimeoutMs: 35 }), /超时/)
  await closed.wait()
})

test('client propagates caller cancellation rather than replacing it with a service error', async (t) => {
  const closed = closeSignal()
  const controller = new AbortController()
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.on('close', closed.resolve)
    res.write(sse({ type: 'delta', text: '开头' }))
  })
  await assert.rejects(requestChat(localApiUrl, { ...request, signal: controller.signal }, {
    onDelta: () => controller.abort(new Error('作者取消')),
  }), /作者取消/)
  await closed.wait()
})

test('client hides credential echoes before delivering stream error events to UI consumers', async (t) => {
  const apiKey = 'sk-client-private/A+B==?'
  const encoded = encodeURIComponent(apiKey)
  const message = `Invalid API key ${apiKey}; request key=${encoded}; model test-model remains unavailable`
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse({ type: 'error', error: message }))
  })
  const events = []
  await assert.rejects(requestChat(localApiUrl, { ...request, apiKey }, { onEvent: (event) => events.push(event) }), (error) => {
    assert.match(error.message, /Invalid API key/)
    assert.match(error.message, /model test-model/)
    assert.equal(error.stack.includes(apiKey), false)
    assert.equal(error.stack.includes(encoded), false)
    return true
  })
  assert.equal(events.length, 1)
  assert.equal(JSON.stringify(events).includes(apiKey), false)
  assert.equal(JSON.stringify(events).includes(encoded), false)
})

test('client redacts credentials from both HTTP errors and JSON error responses', async (t) => {
  const apiKey = 'sk-client-private/A+B==?'
  const encoded = encodeURIComponent(apiKey)
  for (const status of [401, 200]) {
    await t.test(`status ${status}`, async (sub) => {
      const localApiUrl = await createClientApi(sub, (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `Permission denied for ${apiKey}; key=${encoded}; project has no model access` }))
      })
      await assert.rejects(requestChat(localApiUrl, { ...request, apiKey, stream: false }), (error) => {
        assert.match(error.message, /project has no model access/)
        assert.equal(error.message.includes(apiKey), false)
        assert.equal(error.message.includes(encoded), false)
        return true
      })
    })
  }
})

test('client preserves ordinary diagnostic text and only masks an exact short credential token', async (t) => {
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: "Model abc-model is unavailable; token 'abc' is invalid" }))
  })
  await assert.rejects(requestChat(localApiUrl, { ...request, apiKey: 'abc' }), {
    message: "Model abc-model is unavailable; token '[已隐藏密钥]' is invalid",
  })
})

test('client keeps caller cancellation semantics while masking credential-bearing reasons', async (t) => {
  const apiKey = 'sk-caller-abort-secret'
  const controller = new AbortController()
  const reason = new DOMException(`作者取消 ${apiKey}`, 'AbortError')
  controller.abort(reason)
  await assert.rejects(requestChat((path) => `http://127.0.0.1:1${path}`, { ...request, apiKey, signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.message, '作者取消 [已隐藏密钥]')
    assert.equal(error.stack.includes(apiKey), false)
    return true
  })
})

test('client delivers real non-stream usage without inventing unknown counts', async (t) => {
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      text: '完整正文',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 2, reasoningTokens: null, uncachedInputTokens: '10', unknown: 99 },
    }))
  })
  const usages = []
  const events = []
  assert.equal(await requestChat(localApiUrl, { ...request, stream: false }, {
    onUsage: async (usage) => { usages.push(usage) },
    onEvent: async (event) => { events.push(event) },
  }), '完整正文')
  const expected = { inputTokens: 12, outputTokens: 3, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 2 }
  assert.deepEqual(usages, [expected])
  assert.deepEqual(events, [{ type: 'usage', usage: expected }])
})

test('client delivers ordered stream usage snapshots and ignores malformed statistics', async (t) => {
  const localApiUrl = await createClientApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      sse({ type: 'usage', usage: { inputTokens: 20, outputTokens: 0, cachedInputTokens: 8 } }),
      sse({ type: 'delta', text: '正文。' }),
      sse({ type: 'usage', usage: null }),
      sse({ type: 'usage', usage: [] }),
      sse({ type: 'usage' }),
      sse({ type: 'usage', usage: { inputTokens: -1, outputTokens: '3', totalTokens: null } }),
      sse({ type: 'usage', usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23, cachedInputTokens: 8, reasoningTokens: 0 } }),
      sse({ type: 'done' }),
    ].join(''))
  })
  const usages = []
  const events = []
  assert.equal(await requestChat(localApiUrl, request, {
    onUsage: (usage) => usages.push(usage),
    onEvent: (event) => events.push(event),
  }), '正文。')
  assert.deepEqual(usages, [
    { inputTokens: 20, outputTokens: 0, cachedInputTokens: 8 },
    { inputTokens: 20, outputTokens: 3, totalTokens: 23, cachedInputTokens: 8, reasoningTokens: 0 },
  ])
  assert.deepEqual(events.map((event) => event.type), ['usage', 'delta', 'usage', 'done'])
})

test('missing or malformed non-stream usage does not prevent normal completion', async (t) => {
  for (const usage of [undefined, null, [], { inputTokens: false, outputTokens: -1, cachedInputTokens: '0' }]) {
    await t.test(JSON.stringify(usage) || 'missing', async (sub) => {
      const localApiUrl = await createClientApi(sub, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, text: '正文。', usage }))
      })
      const usages = []
      assert.equal(await requestChat(localApiUrl, { ...request, stream: false }, { onUsage: (value) => usages.push(value) }), '正文。')
      assert.deepEqual(usages, [])
    })
  }
})

test('client normalizes explicit generation values, preserves zero and omits blank settings', async (t) => {
  const bodies = []
  const localApiUrl = await createClientApi(t, (_req, res, body) => {
    bodies.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, text: '正文。' }))
  })
  await requestChat(localApiUrl, {
    ...request, maxTokens: '8192', temperature: '0', topP: 0, frequencyPenalty: 0, presencePenalty: -2,
    includeUsage: true, outputTokenParameter: 'max_completion_tokens',
  })
  assert.deepEqual(Object.fromEntries(Object.entries(bodies[0]).filter(([key]) => [
    'maxTokens', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'includeUsage', 'outputTokenParameter',
  ].includes(key))), {
    maxTokens: 8192, temperature: 0, topP: 0, frequencyPenalty: 0, presencePenalty: -2,
    includeUsage: true, outputTokenParameter: 'max_completion_tokens',
  })
  await requestChat(localApiUrl, {
    ...request, maxTokens: '', temperature: null, topP: ' ', frequencyPenalty: undefined, presencePenalty: null,
    includeUsage: false, outputTokenParameter: '',
  })
  for (const key of ['maxTokens', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'outputTokenParameter', 'signal']) {
    assert.equal(key in bodies[1], false)
  }
  assert.equal(bodies[1].includeUsage, false)
})

test('client rejects invalid explicit parameters before contacting the local proxy', async (t) => {
  let called = 0
  const localApiUrl = await createClientApi(t, (_req, res) => {
    called += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, text: '正文。' }))
  })
  for (const [parameters, expected] of [
    [{ maxTokens: 0 }, /最大输出/], [{ maxTokens: 1.5 }, /整数/], [{ maxTokens: 2147483648 }, /最大输出/],
    [{ temperature: true }, /温度/], [{ protocol: 'Anthropic', temperature: 2 }, /温度/],
    [{ topP: Number.NaN }, /Top P/], [{ frequencyPenalty: -3 }, /频率惩罚/],
    [{ presencePenalty: 3 }, /存在惩罚/], [{ outputTokenParameter: 'auto' }, /输出 Tokens 字段/],
    [{ includeUsage: 'true' }, /用量统计/], [{ protocol: 'Anthropic', presencePenalty: 0 }, /Anthropic.*不支持/],
  ]) {
    await assert.rejects(requestChat(localApiUrl, { ...request, ...parameters }), expected)
  }
  assert.equal(called, 0)
})
