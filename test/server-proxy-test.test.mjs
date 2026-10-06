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

test('provider connection test does not require a /models endpoint', async (t) => {
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    requests.push({ url: req.url, body })
    if (req.url === '/v1/models') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'models endpoint unavailable' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }))
  })
  const upstreamUrl = await listen(t, upstream)
  const local = await startLocalApiServer({ host: '127.0.0.1', port: 0 })
  t.after(async () => {
    local.closeAllConnections?.()
    await new Promise((resolve) => local.close(resolve))
  })

  const response = await fetch(`http://127.0.0.1:${local.address().port}/api/proxy/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `${upstreamUrl}/v1`,
      apiKey: 'test-key',
      model: 'manual-model',
      protocol: 'OpenAI Compatible',
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, model: 'manual-model', tested: true })
  assert.deepEqual(requests.map((request) => request.url), ['/v1/chat/completions'])
  assert.equal(requests[0].body.model, 'manual-model')
  assert.equal(requests[0].body.max_tokens, 1)
  assert.deepEqual(requests[0].body.messages, [{ role: 'user', content: '只回复 OK。' }])
})

test('provider connection test rejects an empty model before contacting upstream', async (t) => {
  let contacted = false
  const upstream = http.createServer((_req, res) => {
    contacted = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const upstreamUrl = await listen(t, upstream)
  const local = await startLocalApiServer({ host: '127.0.0.1', port: 0 })
  t.after(async () => {
    local.closeAllConnections?.()
    await new Promise((resolve) => local.close(resolve))
  })

  const response = await fetch(`http://127.0.0.1:${local.address().port}/api/proxy/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `${upstreamUrl}/v1`, apiKey: 'test-key', model: '' }),
  })
  assert.equal(response.status, 502)
  assert.match((await response.json()).error, /模型/)
  assert.equal(contacted, false)
})
