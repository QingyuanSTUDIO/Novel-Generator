import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { startLocalApiServer } from '../server/index.mjs'
import { fetchModelLimits } from '../server/model-limits.mjs'

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function within(promise, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('external cancellation closes the real pending metadata GET and does not fall back to other paths', async (t) => {
  let resolveStarted
  let resolveClosed
  const started = new Promise((resolve) => { resolveStarted = resolve })
  const closed = new Promise((resolve) => { resolveClosed = resolve })
  const requests = []
  const upstream = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url })
    res.once('close', () => resolveClosed({ ended: res.writableEnded }))
    res.writeHead(200, { 'content-type': 'application/json' })
    // Headers and an incomplete body exercise cancellation during response
    // consumption, rather than accepting a complete metadata response.
    res.write('{"id":"cancellation-model",')
    resolveStarted()
  })
  const baseUrl = await listen(t, upstream)
  const local = await startLocalApiServer({ host: '127.0.0.1', port: 0 })
  t.after(async () => {
    local.closeAllConnections?.()
    await new Promise((resolve) => local.close(resolve))
  })
  const controller = new AbortController()
  const reason = new Error('主动取消元数据查询')
  const pending = fetch(`http://127.0.0.1:${local.address().port}/api/proxy/model-limits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'cancellation-mock-key',
      protocol: 'OpenAI Compatible',
      model: 'cancellation-model',
    }),
    signal: controller.signal,
  })
  const rejected = assert.rejects(pending, (error) => error === reason)

  await within(started, '本地模型元数据 GET 未开始')
  controller.abort(reason)
  await rejected
  const connection = await within(closed, '取消查询后上游 metadata GET 仍未关闭')
  assert.equal(connection.ended, false)
  assert.deepEqual(requests, [{ method: 'GET', url: '/v1/models/cancellation-model' }])
})

test('a short module timeout aborts the injected request signal and reports its timeout instead of a transport abort', async () => {
  const requests = []
  let abortCount = 0
  const request = (url, _input, signal) => {
    requests.push({ url, signal })
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        abortCount += 1
        // Real transports may throw their own AbortError; the module must
        // retain the timeout's informative reason for the settings UI.
        reject(new DOMException('transport aborted', 'AbortError'))
      }, { once: true })
    })
  }
  const pending = fetchModelLimits({
    baseUrl: 'http://metadata.invalid/v1',
    apiKey: 'timeout-mock-key',
    protocol: 'OpenAI Compatible',
    model: 'timeout-model',
  }, request, undefined, 25)

  await within(
    assert.rejects(pending, /模型上限查询超时/),
    '短超时未传到 metadata 请求的 AbortSignal',
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://metadata.invalid/v1/models/timeout-model')
  assert.equal(requests[0].signal.aborted, true)
  assert.match(requests[0].signal.reason.message, /模型上限查询超时/)
  assert.equal(abortCount, 1)
})
