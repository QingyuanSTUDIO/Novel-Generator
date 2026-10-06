import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpServer, MCP_LIMITS, MCP_TOOL_NAMES } from '../electron/mcp-server.mjs'
import { createConsoleService } from '../electron/console-service.mjs'

const token = 'qy-mcp-test-only-token-00000000000000000000'
const target = { portfolioId: 'portfolio-a', projectId: 'project-a' }

function fakeService(overrides = {}) {
  const calls = []
  const jobs = new Map()
  const service = {
    inspect: async (query) => {
      calls.push({ method: 'inspect', query })
      if (query.kind === 'status') return { ready: true, ...target }
      if (query.kind === 'providers') return [{ id: 'provider-a', title: '假 API', model: 'model-a', enabled: true }]
      if (query.kind === 'schema') return { type: 'agent', operations: ['create_resource'] }
      return { projectId: query.projectId ?? target.projectId, collection: query.collection, data: [] }
    },
    submit: async (input) => {
      calls.push({ method: 'submit', input })
      const job = { id: `job-${jobs.size + 1}`, ...input, status: 'queued' }
      jobs.set(job.id, job)
      return job
    },
    list: () => { calls.push({ method: 'list' }); return [...jobs.values()] },
    get: (id) => {
      calls.push({ method: 'get', id })
      if (!jobs.has(id)) throw Object.assign(new Error('secret raw error'), { code: 'JOB_NOT_FOUND' })
      return jobs.get(id)
    },
    pause: async (id) => {
      calls.push({ method: 'pause', id })
      return { ...jobs.get(id), id, status: 'paused' }
    },
    resume: async (id) => {
      calls.push({ method: 'resume', id })
      return { ...jobs.get(id), id, status: 'queued' }
    },
    cancel: async (id) => {
      calls.push({ method: 'cancel', id })
      return { ...jobs.get(id), id, status: 'canceled' }
    },
    ...overrides,
  }
  return { service, calls, jobs }
}

async function setup(t, overrides = {}, options = {}) {
  const { service, calls, jobs } = fakeService(overrides)
  const logs = []
  const server = createMcpServer({ service, token, port: 0, logger: (...args) => logs.push(args), ...options })
  const address = await server.start()
  const clients = []
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})))
    await server.close()
  })
  async function client(clientOptions = {}) {
    const instance = new Client({ name: 'qy-mcp-test-client', version: '1.0.0' }, {
      versionNegotiation: { mode: 'auto' }, ...clientOptions,
    })
    clients.push(instance)
    const transport = new StreamableHTTPClientTransport(new URL(address.url), {
      authProvider: { token: async () => token },
      requestInit: { redirect: 'error' },
    })
    await instance.connect(transport)
    return instance
  }
  return { server, address, client, calls, jobs, logs }
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args })
  return { response, value: JSON.parse(response.content[0].text) }
}

function rawRequest(address, {
  method = 'POST', headers = {}, body,
  authorized = true, requestPath = '/mcp',
} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: address.host, port: address.port, path: requestPath, method,
      headers: {
        ...(authorized ? { authorization: `Bearer ${token}` } : {}),
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...headers,
      },
    }, (response) => {
      const buffers = []
      response.on('data', (chunk) => buffers.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers, body: Buffer.concat(buffers).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

test('official SDK client discovers every tool, resources and projected read results', async (t) => {
  const { client, calls, address, server } = await setup(t)
  const connected = await client()
  const tools = await connected.listTools()
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...MCP_TOOL_NAMES].sort())
  assert.equal(tools.tools.some((tool) => /approve|批准/u.test(tool.name)), false)
  assert.equal(tools.tools.find((tool) => tool.name === 'qy_status').annotations.readOnlyHint, true)
  assert.equal(tools.tools.find((tool) => tool.name === 'qy_run_agent').inputSchema.additionalProperties, false)
  assert.deepEqual((await call(connected, 'qy_status')).value, { ready: true, ...target })
  await call(connected, 'qy_read_resources', { projectId: 'project-b', collection: 'characters' })
  await call(connected, 'qy_get_schema', { collection: 'schema-custom' })
  await call(connected, 'qy_search_context', { projectId: 'project-a', query: '世界规则' })
  const providers = (await call(connected, 'qy_list_providers')).value
  assert.equal(providers[0].id, 'provider-a')
  assert.ok(calls.some((entry) => entry.query?.kind === 'workspace' && entry.query.projectId === 'project-b'))
  assert.ok(calls.some((entry) => entry.query?.kind === 'schema' && entry.query.collection === 'schema-custom'))
  assert.ok(calls.some((entry) => entry.query?.kind === 'context' && entry.query.query === '世界规则'))
  const resources = await connected.listResources()
  assert.deepEqual(resources.resources.map((item) => item.uri).sort(), ['qy://providers', 'qy://schemas', 'qy://status'])
  const resource = await connected.readResource({ uri: 'qy://status' })
  assert.equal(JSON.parse(resource.contents[0].text).portfolioId, target.portfolioId)
  assert.deepEqual(await server.start(), address)
  const metadata = server.status()
  assert.deepEqual(metadata, {
    running: true, ...address, connected: true, connectionCount: 1,
    lastSeenAt: metadata.lastSeenAt, connectionLeaseMs: 90000,
  })
  assert.equal(typeof metadata.lastSeenAt, 'number')
  assert.equal(JSON.stringify(server.status()).includes(token), false)
})

test('pinned 2026 and legacy 2025 clients discover and invoke the same protocol tools', async (t) => {
  const { client, calls } = await setup(t)
  for (const mode of [{ pin: '2026-07-28' }, 'legacy']) {
    const connected = await client({ versionNegotiation: { mode } })
    const discovered = await connected.listTools()
    assert.equal(discovered.tools.length, MCP_TOOL_NAMES.length)
    assert.equal((await call(connected, 'qy_status')).value.portfolioId, target.portfolioId)
    assert.equal((await call(connected, 'qy_run_agent', { ...target, prompt: '核对角色状态' })).value.kind, 'agent')
    await connected.close()
  }
  assert.equal(calls.filter((entry) => entry.method === 'submit').length, 2)
})

test('agent, plan and save tools bind explicit targets and delegate once without approving', async (t) => {
  const { client, calls } = await setup(t)
  const connected = await client()
  const input = {
    ...target, chapterId: 'chapter-a', conversationId: 'conversation-a', providerId: 'provider-b',
    mode: 'inspiration', requestId: 'request-a',
  }
  const agent = await call(connected, 'qy_run_agent', { ...input, prompt: '设计三名角色' })
  assert.equal(agent.value.status, 'queued')
  const response = { summary: '新增道具', operations: [{ type: 'create_resource' }] }
  const plan = await call(connected, 'qy_submit_plan', { ...input, requestId: 'request-b', responseJSON: JSON.stringify(response) })
  assert.equal(plan.value.status, 'queued')
  const save = await call(connected, 'qy_save_portfolio', { ...target, requestId: 'request-c' })
  assert.equal(save.value.kind, 'save')
  assert.deepEqual(calls.filter((entry) => entry.method === 'submit').map((entry) => entry.input), [
    { kind: 'agent', ...input, prompt: '设计三名角色' },
    { kind: 'plan', ...input, requestId: 'request-b', response },
    { kind: 'save', ...target, requestId: 'request-c' },
  ])
  assert.equal((await call(connected, 'qy_list_jobs')).value.length, 3)
  assert.equal((await call(connected, 'qy_get_job', { jobId: agent.value.id })).value.id, agent.value.id)
  assert.equal((await call(connected, 'qy_pause_job', { jobId: agent.value.id })).value.status, 'paused')
  assert.equal((await call(connected, 'qy_resume_job', { jobId: agent.value.id })).value.status, 'queued')
  assert.equal((await call(connected, 'qy_cancel_job', { jobId: agent.value.id })).value.status, 'canceled')
  const missing = await call(connected, 'qy_get_job', { jobId: 'missing' })
  assert.equal(missing.response.isError, true)
  assert.equal(missing.value.error.code, 'JOB_NOT_FOUND')
  assert.equal(JSON.stringify(missing).includes('secret raw error'), false)
})

test('invalid targets, unknown properties and malformed plan JSON never submit', async (t) => {
  const { client, calls } = await setup(t)
  const connected = await client()
  const invalid = [
    ['qy_run_agent', { prompt: '创建角色' }],
    ['qy_run_agent', { ...target, projectId: ' ', prompt: '创建角色' }],
    ['qy_run_agent', { ...target, chapterId: 'bad\nid', prompt: '创建角色' }],
    ['qy_run_agent', { ...target, prompt: '   ' }],
    ['qy_run_agent', { ...target, prompt: '要求', mode: 'unknown' }],
    ['qy_run_agent', { ...target, prompt: '要求', useCurrent: true }],
    ['qy_run_agent', { ...target, prompt: '要求', conversationId: 42 }],
    ['qy_submit_plan', { ...target, responseJSON: '{not JSON}' }],
    ['qy_submit_plan', { ...target, responseJSON: 'null' }],
    ['qy_submit_plan', { ...target, responseJSON: '[]' }],
    ['qy_save_portfolio', { portfolioId: target.portfolioId }],
    ['qy_read_resources', { collection: 'providers' }],
    ['qy_search_context', { query: ' ' }],
  ]
  for (const [name, args] of invalid) {
    // The official SDK may represent schema violations as protocol errors or tool errors.
    let rejected = false
    try {
      const result = await connected.callTool({ name, arguments: args })
      rejected = result.isError === true
    } catch (error) {
      assert.ok(error instanceof Error)
      rejected = true
    }
    assert.equal(rejected, true, name)
  }
  assert.equal(calls.some((entry) => entry.method === 'submit'), false)
  assert.equal(calls.some((entry) => entry.query?.kind === 'workspace'), false)
})

test('every HTTP verb including legacy initialize requires bearer authentication', async (t) => {
  const { address, calls } = await setup(t)
  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  }
  for (const method of ['POST', 'GET', 'DELETE', 'OPTIONS']) {
    const response = await rawRequest(address, { method, authorized: false, ...(method === 'POST' ? { body: initialize } : {}) })
    assert.equal(response.status, 401, method)
    assert.match(response.headers['www-authenticate'], /Bearer/u)
  }
  const wrong = await rawRequest(address, { body: initialize, headers: { authorization: 'Bearer incorrect' } })
  assert.equal(wrong.status, 401)
  const queryToken = await rawRequest(address, { authorized: false, requestPath: `/mcp?token=${token}`, body: initialize })
  assert.equal(queryToken.status, 401)
  assert.equal(calls.length, 0)
  const valid = await rawRequest(address, { body: initialize })
  assert.equal(valid.status, 200)
  const initialized = valid.headers['content-type'].startsWith('text/event-stream')
    ? JSON.parse(valid.body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(valid.body)
  assert.equal(initialized.result.serverInfo.name, 'qy-novel-generator')
  const get = await rawRequest(address, { method: 'GET' })
  assert.equal(get.status, 405)
})

test('all origins and foreign hosts or ports are denied before service access', async (t) => {
  const { address, calls } = await setup(t)
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  for (const origin of ['https://evil.example', `http://127.0.0.1:${address.port}`, 'null', '']) {
    const response = await rawRequest(address, { body, headers: { origin } })
    assert.equal(response.status, 403, origin)
  }
  for (const host of ['evil.example', '127.0.0.1:1', `127.0.0.2:${address.port}`, `localhost:${address.port + 1}`]) {
    const response = await rawRequest(address, { body, headers: { host } })
    assert.equal(response.status, 403, host)
  }
  assert.equal((await rawRequest(address, { body, headers: { host: `localhost:${address.port}` } })).status, 200)
  assert.equal((await rawRequest(address, { method: 'GET', requestPath: '/v1/jobs' })).status, 404)
  assert.equal(calls.length, 0)
})

test('the official Node adapter enforces the 2 MiB body limit before parsing or execution', async (t) => {
  const { address, calls } = await setup(t)
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'qy_run_agent', arguments: { ...target, prompt: 'x'.repeat(MCP_LIMITS.requestBytes) } },
  })
  const response = await rawRequest(address, { body })
  assert.equal(response.status, 413)
  assert.equal(calls.length, 0)
  const invalid = await rawRequest(address, { body: '{bad json' })
  assert.equal(invalid.status, 400)
})

test('tool/resource projections remove credentials, images, settings and known tokens without raw logs', async (t) => {
  const credential = 'fake-api-secret-00000000000'
  const image = 'data:image/png;base64,not-a-real-image'
  const source = {
    title: '作品', apiKey: credential, authorization: `Bearer ${credential}`, token,
    providers: [{ id: 'api', fields: { key: credential } }],
    modelOptions: [{ id: 'private-model' }],
    characterImages: [{ id: 'image', data: image }], characterCoverImageId: 'image',
    cards: [{ title: '角色', text: `凭据 ${credential}; MCP ${token}`, image, tokens: 120 }],
    nested: { access_token: credential, 'client-secret': credential },
  }
  const { client, logs } = await setup(t, {
    inspect: async ({ kind }) => {
      if (kind === 'schema') throw new Error(`raw private error ${credential} ${token}`)
      if (kind === 'providers') return [{ id: 'api', key: credential, apiKey: credential, title: '假模型', message: credential }]
      return source
    },
    get: () => { throw new Error(`raw private error ${credential} ${token}`) },
  })
  const connected = await client()
  for (const [name, args] of [
    ['qy_read_resources', {}], ['qy_status', {}], ['qy_list_providers', {}], ['qy_get_job', { jobId: 'test' }],
  ]) {
    const { response, value } = await call(connected, name, args)
    const output = JSON.stringify(response)
    assert.equal(output.includes(credential), false)
    assert.equal(output.includes(token), false)
    assert.equal(output.includes(image), false)
    assert.equal(output.includes('raw private error'), false)
    assert.equal(output.includes('private-model'), false)
    if (name === 'qy_read_resources') {
      assert.equal(value.cards[0].tokens, 120)
      assert.equal(value.cards[0].image, '[图片已省略]')
      for (const key of ['apiKey', 'providers', 'modelOptions', 'characterImages', 'characterCoverImageId']) {
        assert.equal(key in value, false)
      }
    }
  }
  for (const uri of ['qy://status', 'qy://schemas', 'qy://providers']) {
    const resource = await connected.readResource({ uri })
    const output = JSON.stringify(resource)
    assert.equal(output.includes(credential), false)
    assert.equal(output.includes(token), false)
    assert.equal(output.includes(image), false)
    assert.equal(output.includes('raw private error'), false)
  }
  assert.ok(logs.length > 0)
  assert.equal(JSON.stringify(logs).includes(credential), false)
  assert.equal(JSON.stringify(logs).includes(token), false)
  assert.equal(JSON.stringify(logs).includes('raw private error'), false)
})

test('closing releases the loopback port, repeated close is safe, and the instance can restart', async (t) => {
  const { server, address, client } = await setup(t)
  const connected = await client()
  await connected.close()
  await Promise.all([server.close(), server.close()])
  assert.equal(server.status().running, false)
  await assert.rejects(fetch(address.url), /fetch failed/u)
  const probe = http.createServer()
  probe.listen(address.port, address.host)
  await once(probe, 'listening')
  assert.equal(probe.address().address, '127.0.0.1')
  await new Promise((resolve) => probe.close(resolve))
  const restarted = await server.start()
  assert.equal(server.status().running, true)
  assert.equal((await rawRequest(restarted, { authorized: false, method: 'GET' })).status, 401)
})

test('occupied port fails with a bounded status and no token or raw errors', async (t) => {
  const occupied = http.createServer()
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  t.after(() => new Promise((resolve) => occupied.close(resolve)))
  const { service } = fakeService()
  const logs = []
  const server = createMcpServer({ service, token, port: occupied.address().port, logger: (...args) => logs.push(args) })
  t.after(() => server.close())
  await assert.rejects(server.start(), { code: 'PORT_IN_USE' })
  assert.equal(server.status().running, false)
  assert.equal(server.status().error, 'PORT_IN_USE')
  assert.deepEqual(logs, [['PORT_IN_USE']])
  assert.equal(JSON.stringify(server.status()).includes(token), false)
})

test('server construction rejects weak tokens, invalid ports and incomplete services', () => {
  const { service } = fakeService()
  for (const invalid of ['', 'short', null, `${token}\n`]) {
    assert.throws(() => createMcpServer({ service, token: invalid }), /令牌/u)
  }
  for (const invalid of [-1, 65536, 1.5, '43127', null]) {
    assert.throws(() => createMcpServer({ service, token, port: invalid }), /端口/u)
  }
  assert.throws(() => createMcpServer({ service: {}, token }), /任务服务/u)
})

test('MCP delegates to the durable console queue, deduplicates and keeps author approval in the desktop', async (t) => {
  const temporaryRoot = path.resolve(os.tmpdir())
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'qy-mcp-console-'))
  const executions = []
  const service = createConsoleService({
    storagePath: path.join(directory, 'jobs.json'),
    endpointPath: path.join(directory, 'endpoint.json'),
    inspect: async () => ({ ready: true, ...target }),
    execute: async ({ action, job }) => {
      executions.push({ action, job })
      if (job.kind === 'save') return { status: 'completed', message: '假保存器完成' }
      return { status: 'awaiting_approval', plan: { operations: [{ type: 'create_resource' }] } }
    },
  })
  t.after(async () => {
    await service.close()
    const resolved = path.resolve(directory)
    assert.equal(path.dirname(resolved), temporaryRoot)
    assert.ok(path.basename(resolved).startsWith('qy-mcp-console-'))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  await service.start()
  const { client } = await setup(t, service)
  const connected = await client()
  const input = { ...target, conversationId: 'dialogue-a', prompt: '创建角色', requestId: 'mcp-durable-request' }
  const created = (await call(connected, 'qy_run_agent', input)).value
  const repeated = (await call(connected, 'qy_run_agent', input)).value
  assert.equal(repeated.id, created.id)
  const conflict = await call(connected, 'qy_run_agent', { ...input, conversationId: 'dialogue-b' })
  assert.equal(conflict.response.isError, true)
  assert.equal(conflict.value.error.code, 'REQUEST_ID_CONFLICT')
  async function until(check) {
    const deadline = Date.now() + 5000
    while (!check()) {
      assert.ok(Date.now() < deadline, '任务没有达到预期状态')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  await until(() => service.get(created.id).status === 'awaiting_approval')
  const disk = JSON.parse(await fs.readFile(path.join(directory, 'jobs.json'), 'utf8'))
  assert.equal(disk.jobs.length, 1)
  assert.deepEqual(disk.jobs[0].target, { ...target, conversationId: 'dialogue-a' })
  const save = (await call(connected, 'qy_save_portfolio', target)).value
  assert.equal(service.get(save.id).status, 'queued')
  assert.equal(executions.length, 1)
  assert.equal(service.get(created.id).result.applied, undefined)
  assert.equal((await connected.listTools()).tools.some((tool) => /approve/u.test(tool.name)), false)
  await call(connected, 'qy_cancel_job', { jobId: created.id })
  await until(() => service.get(save.id).status === 'completed')
  assert.deepEqual(executions.map((entry) => entry.job.kind), ['agent', 'save'])
  await connected.close()
})
