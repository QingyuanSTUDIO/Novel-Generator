import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpConnectionTracker, MCP_CLIENT_ID_HEADER, validMcpClientId } from '../electron/mcp-connections.mjs'
import { createMcpServer } from '../electron/mcp-server.mjs'
import { createMcpSettingsManager } from '../electron/mcp-settings.mjs'
import { createMcpStdioBridge } from '../scripts/qy-mcp.mjs'

const token = randomBytes(32).toString('base64url')
const ids = ['test-client-one-0000000000', 'test-client-two-0000000000']

function service(overrides = {}) {
  return {
    inspect: async () => ({ ready: true, portfolioId: 'fixture', projectId: 'test' }),
    submit: async () => ({ id: 'job', status: 'queued' }),
    list: async () => [],
    get: async () => { throw Object.assign(new Error('no job'), { code: 'JOB_NOT_FOUND' }) },
    pause: async () => ({}), resume: async () => ({}), cancel: async () => ({}),
    ...overrides,
  }
}

async function setup(t, options = {}) {
  const notifications = []
  const server = createMcpServer({
    service: service(), token, port: 0,
    onConnectionsChanged: (snapshot) => notifications.push(snapshot),
    ...options,
  })
  const address = await server.start()
  const clients = []
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await server.close()
  })
  async function connect(clientId = ids[0], url = address.url, credential = token) {
    const client = new Client({ name: 'connection-fixture', version: '1' }, {
      versionNegotiation: { mode: 'auto' },
    })
    clients.push(client)
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: {
        Authorization: `Bearer ${credential}`,
        ...(clientId ? { [MCP_CLIENT_ID_HEADER]: clientId } : {}),
      } },
    })
    await client.connect(transport)
    return client
  }
  return { server, address, connect, notifications }
}

async function request(url, { method = 'POST', credential = token, clientId = ids[0], body, headers = {} } = {}) {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${credential}`,
      ...(clientId ? { [MCP_CLIENT_ID_HEADER]: clientId } : {}),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Synthetic MCP connection condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('lease identities expire independently and clear/revoke invalidate already running requests', () => {
  let time = 100
  const notices = []
  const tracker = createMcpConnectionTracker({ now: () => time, ttlMs: 90, onChange: (state) => notices.push(state) })
  tracker.touch(ids[0])
  time = 140
  tracker.touch(ids[1])
  time = 190
  assert.equal(tracker.snapshot().connectionCount, 1)
  assert.equal(tracker.snapshot().lastSeenAt, 140)
  const pending = tracker.ticket(ids[1])
  tracker.forget(ids[1])
  assert.equal(tracker.touch(ids[1], pending), false)
  assert.equal(tracker.snapshot().connected, false)
  tracker.touch(ids[1])
  const beforeClose = tracker.ticket(ids[1])
  tracker.clear()
  assert.equal(tracker.touch(ids[1], beforeClose), false)
  assert.deepEqual(tracker.snapshot(), {
    connected: false, connectionCount: 0, lastSeenAt: null, connectionLeaseMs: 90,
  })
  assert.equal(JSON.stringify(notices).includes(ids[0]), false)
})

test('private client identities validate without accepting injected or duplicate header values', () => {
  assert.equal(validMcpClientId(ids[0]), true)
  for (const value of ['', 'tiny', `${ids[0]}, ${ids[1]}`, 'x'.repeat(200), `${ids[0]}\r\nX:test`, [ids[0]]]) {
    assert.equal(validMcpClientId(value), false)
  }
})

test('service enablement and modern discovery alone stay disconnected until actual MCP activity', async (t) => {
  let time = 1000
  const probe = await setup(t, { now: () => time, connectionTtlMs: 90 })
  assert.equal(probe.server.status().running, true)
  assert.equal(probe.server.status().connected, false)
  const client = await probe.connect()
  assert.equal(probe.server.status().connected, false, 'version discovery must not pretend to be an active session')
  await client.listTools({}, { cacheMode: 'bypass' })
  assert.equal(probe.server.status().connectionCount, 1)
  assert.equal(probe.server.status().lastSeenAt, 1000)
  time = 1090
  assert.equal(probe.server.status().connected, false)
  await client.listTools({}, { cacheMode: 'bypass' })
  assert.equal(probe.server.status().connected, true)
  assert.equal(probe.server.status().lastSeenAt, 1090)
})

test('idle HTTP activity expires through a timer notification without another UI status read', async (t) => {
  const probe = await setup(t, { connectionTtlMs: 45 })
  const client = await probe.connect()
  await client.listTools({}, { cacheMode: 'bypass' })
  assert.equal(probe.notifications.at(-1).connected, true)
  await waitFor(() => probe.notifications.at(-1)?.connected === false)
  assert.equal(probe.notifications.at(-1).connectionCount, 0)
  assert.equal(probe.server.status().connected, false)
})

test('invalid credentials/origin/JSON/protocol requests and probes never create a lease', async (t) => {
  const probe = await setup(t)
  const malformed = [
    { credential: 'bad-token', body: { jsonrpc: '2.0', id: 1, method: 'ping' } },
    { headers: { Origin: 'http://127.0.0.1' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } },
    { body: 'bad JSON' },
    { body: { id: 1, method: 'ping' } },
    { body: { jsonrpc: '2.0', id: 1, method: 'made-up-method' } },
    { method: 'GET' },
    { clientId: `${ids[0]}, ${ids[1]}`, body: { jsonrpc: '2.0', id: 1, method: 'ping' } },
    { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } },
  ]
  for (const options of malformed) {
    const response = await request(probe.address.url, options)
    await response.text()
    assert.equal(probe.server.status().connected, false, JSON.stringify(options))
  }
  const client = await probe.connect()
  const invalid = await client.callTool({ name: 'qy_run_agent', arguments: { prompt: 'missing IDs' } })
  assert.equal(invalid.isError, true)
  assert.equal(probe.server.status().connected, false, 'invalid tool arguments must not create activity')
})

test('authenticated tool/resource callbacks count only their client and support multiple independent clients', async (t) => {
  const probe = await setup(t)
  const first = await probe.connect(ids[0])
  const second = await probe.connect(ids[1])
  await first.callTool({ name: 'qy_status', arguments: {} })
  assert.equal(probe.server.status().connectionCount, 1)
  await second.readResource({ uri: 'qy://status' })
  assert.equal(probe.server.status().connectionCount, 2)
  const dropped = await request(probe.address.url, { method: 'DELETE', clientId: ids[0] })
  assert.equal(dropped.status, 204)
  assert.equal(probe.server.status().connectionCount, 1)
  await first.listTools({}, { cacheMode: 'bypass' })
  assert.equal(probe.server.status().connectionCount, 2)
  const failedTool = await second.callTool({ name: 'qy_get_job', arguments: { jobId: 'missing' } })
  assert.equal(failedTool.isError, true)
  assert.equal(probe.server.status().connectionCount, 2, 'an application-level error still proves a valid client request')
  assert.equal(JSON.stringify(probe.notifications).includes(token), false)
  assert.equal(JSON.stringify(probe.notifications).includes(ids[0]), false)
})

test('an in-flight tool cannot resurrect a lease revoked during the request', async (t) => {
  let release
  let arrived
  const reached = new Promise((resolve) => { arrived = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const probe = await setup(t, { service: service({
    async inspect() { arrived(); await gate; return { ready: true } },
  }) })
  const client = await probe.connect()
  await client.listTools({}, { cacheMode: 'bypass' })
  const pending = client.callTool({ name: 'qy_status', arguments: {} })
  await reached
  await request(probe.address.url, { method: 'DELETE' })
  assert.equal(probe.server.status().connected, false)
  release()
  await pending
  assert.equal(probe.server.status().connected, false)
})

test('server shutdown and restart clear all prior activity', async (t) => {
  const probe = await setup(t)
  const client = await probe.connect()
  await client.listTools({}, { cacheMode: 'bypass' })
  assert.equal(probe.server.status().connected, true)
  await probe.server.close()
  assert.equal(probe.server.status().connected, false)
  await probe.server.start()
  assert.equal(probe.server.status().running, true)
  assert.equal(probe.server.status().connected, false)
})

test('generic stateless HTTP without an explicit identity reports one recent-activity group', async (t) => {
  const probe = await setup(t)
  const first = await probe.connect(null)
  const second = await probe.connect(null)
  await first.listTools({}, { cacheMode: 'bypass' })
  await second.callTool({ name: 'qy_status', arguments: {} })
  assert.equal(probe.server.status().connectionCount, 1)
})

async function temporaryRoot(t) {
  const root = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'qy-mcp-activity-test-')))
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function unusedPort() {
  const socket = http.createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

test('settings forwards only active-server leases and clears them on port/token changes or disable', async (t) => {
  const root = await temporaryRoot(t)
  const factories = []
  const clients = []
  const notifications = []
  const manager = createMcpSettingsManager({
    settingsPath: path.join(root, 'mcp-settings.json'),
    service: service(),
    createServer: (options) => {
      factories.push(options)
      return createMcpServer(options)
    },
    onUpdate: (state) => notifications.push(state),
  })
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await manager.close()
  })
  await manager.configure({ enabled: true, port: await unusedPort() })
  const firstCredentials = manager.connectionCredentials()
  async function connectCurrent() {
    const configuration = manager.connectionCredentials()
    const client = new Client({ name: 'settings-activity', version: '1' }, {
      versionNegotiation: { mode: 'auto' },
    })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(configuration.url), {
      requestInit: { headers: {
        Authorization: `Bearer ${configuration.token}`, [MCP_CLIENT_ID_HEADER]: ids[0],
      } },
    }))
    await client.listTools({}, { cacheMode: 'bypass' })
    return client
  }
  assert.equal(manager.info().connected, false)
  await connectCurrent()
  assert.equal(manager.info().connected, true)
  assert.equal(notifications.at(-1).connected, true)
  const oldFactory = factories[0]
  await manager.configure({ enabled: true, port: await unusedPort() })
  assert.equal(manager.info().connected, false)
  const beforeStale = notifications.length
  oldFactory.onConnectionsChanged({ connected: true, connectionCount: 999 })
  assert.equal(notifications.length, beforeStale)
  await connectCurrent()
  await manager.regenerateToken()
  assert.equal(manager.info().connected, false)
  await connectCurrent()
  assert.equal(manager.info().connectionCount, 1)
  await manager.configure({ enabled: false, port: manager.info().port })
  assert.equal(manager.info().connected, false)
  assert.equal(manager.info().connectionCount, 0)
  assert.equal(manager.info().lastSeenAt, null)
  assert.equal(JSON.stringify(notifications).includes(firstCredentials.token), false)
})

test('independent stdio clients heartbeat while idle and explicitly remove their lease on EOF/close', { timeout: 6000 }, async (t) => {
  const root = await temporaryRoot(t)
  const probe = await setup(t, { connectionTtlMs: 110 })
  const settingsPath = path.join(root, 'mcp-settings.json')
  await fs.writeFile(settingsPath, JSON.stringify({
    version: 1, enabled: true, port: probe.address.port, token,
  }))
  const bridges = []
  const inputs = []
  t.after(async () => { await Promise.allSettled(bridges.map((bridge) => bridge.close())) })
  for (let index = 0; index < 2; index += 1) {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stdout.resume()
    stderr.resume()
    inputs.push(stdin)
    bridges.push(createMcpStdioBridge({
      settingsPath, stdin, stdout, stderr, connectTimeoutMs: 1500, heartbeatIntervalMs: 20,
    }))
    stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: `stdio-${index}`, version: '1' } },
    })}\n`)
  }
  await waitFor(() => probe.server.status().connectionCount === 2)
  await new Promise((resolve) => setTimeout(resolve, 240))
  assert.equal(probe.server.status().connectionCount, 2, 'idle adapters must remain active beyond a lease interval')
  inputs[0].end()
  await bridges[0].close()
  assert.equal(probe.server.status().connectionCount, 1)
  await bridges[1].close()
  assert.equal(probe.server.status().connectionCount, 0)
})
