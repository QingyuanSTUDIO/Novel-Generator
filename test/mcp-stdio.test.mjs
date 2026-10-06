import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createConsoleService } from '../electron/console-service.mjs'
import { createMcpServer, MCP_TOOL_NAMES } from '../electron/mcp-server.mjs'
import { createMcpStdioBridge, defaultMcpSettingsPath, parseMcpArguments, readMcpConnection } from '../scripts/qy-mcp.mjs'

const scriptPath = fileURLToPath(new URL('../scripts/qy-mcp.mjs', import.meta.url))
const target = { portfolioId: 'portfolio-mcp', projectId: 'project-mcp' }

async function fixture(t) {
  const root = path.resolve(await mkdtemp(path.join(os.tmpdir(), 'qy-mcp-stdio-')))
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('qy-mcp-stdio-'))
  const settingsPath = path.join(root, 'mcp-settings.json')
  const fakeQyPath = path.join(root, 'untouched.qy')
  await writeFile(fakeQyPath, '{"synthetic":"only the desktop saver may write here"}\n', 'utf8')
  const service = createConsoleService({
    storagePath: path.join(root, 'jobs.json'), endpointPath: path.join(root, 'endpoint.json'),
    inspect: async (query) => {
      if (query.kind === 'status') return { ...target, ready: true, savedFile: true, filePath: fakeQyPath }
      if (query.kind === 'providers') return [{ id: 'api-fake', title: 'Synthetic API', model: 'no-real-api', apiKey: 'must-be-omitted' }]
      if (query.kind === 'schema') return { operations: ['create_resource'], collection: query.collection }
      return { ...target, collection: query.collection, data: [{ id: 'world-a', title: '测试世界', fields: { 内容: '只读测试' } }] }
    },
    execute: async ({ job }) => job.kind === 'save'
      ? { status: 'completed', message: 'synthetic save only' }
      : { status: 'awaiting_approval', plan: { id: 'preview-a', operations: job.response?.operations ?? [] } },
  })
  await service.start()
  let token = randomBytes(32).toString('base64url')
  let server = createMcpServer({ service, token, port: 0 })
  let address = await server.start()
  async function persist() {
    await writeFile(settingsPath, JSON.stringify({ version: 1, enabled: true, port: address.port, token }), 'utf8')
  }
  await persist()
  const clients = []
  async function client(versionNegotiation = 'auto') {
    let stderr = ''
    const transport = new StdioClientTransport({
      command: process.execPath, args: [scriptPath, '--settings', settingsPath],
      cwd: root, stderr: 'pipe',
    })
    transport.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const instance = new Client({ name: 'qy-external-fixture', version: '1.0.0' }, { versionNegotiation })
    clients.push(instance)
    await instance.connect(transport, { timeout: 10000 })
    return { instance, transport, stderr: () => stderr }
  }
  async function rotateAndMove() {
    await server.close()
    token = randomBytes(32).toString('base64url')
    server = createMcpServer({ service, token, port: 0 })
    address = await server.start()
    await persist()
  }
  t.after(async () => {
    await Promise.all(clients.map((instance) => instance.close().catch(() => {})))
    await server.close()
    await service.close()
    // All targets are unique, resolved children of the operating-system temp.
    await rm(root, { recursive: true, force: true })
  })
  return { root, settingsPath, fakeQyPath, service, client, rotateAndMove, currentToken: () => token }
}

async function call(instance, name, args = {}) {
  const result = await instance.callTool({ name, arguments: args }, { timeout: 10000 })
  return { result, value: JSON.parse(result.content[0].text) }
}

async function waitFor(check) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('合成 MCP 任务没有完成')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('stdio entry resolves the desktop settings path and rejects ambiguous command arguments', () => {
  assert.equal(defaultMcpSettingsPath({ APPDATA: 'C:/custom/data' }), path.join('C:/custom/data', 'novel-generator', 'mcp-settings.json'))
  assert.equal(defaultMcpSettingsPath({ QY_MCP_SETTINGS: './local-mcp.json' }), path.resolve('./local-mcp.json'))
  assert.deepEqual(parseMcpArguments(['--settings', './local-mcp.json']), { settingsPath: path.resolve('./local-mcp.json') })
  assert.deepEqual(parseMcpArguments(['--help']), { help: true })
  for (const args of [['--url', 'https://outside.example'], ['--settings'], ['--settings', '  '], ['--token', 'secret']]) {
    assert.throws(() => parseMcpArguments(args), /用法/)
  }
})

test('invalid and disabled credential files fail without quoting secrets or allowing an arbitrary URL', async (t) => {
  const fixtureRoot = path.resolve(await mkdtemp(path.join(os.tmpdir(), 'qy-mcp-stdio-read-')))
  assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()))
  assert.ok(path.basename(fixtureRoot).startsWith('qy-mcp-stdio-read-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))
  const settingsPath = path.join(fixtureRoot, 'settings.json')
  const secret = randomBytes(32).toString('base64url')
  for (const value of [
    `{"token":"${secret}",`, { enabled: false, token: secret },
    { version: 1, enabled: true, token: secret, port: '43127' },
    { version: 1, enabled: true, token: secret, port: 1 },
    { version: 1, enabled: true, token: 'bad\r\nheader', port: 43127 },
  ]) {
    await writeFile(settingsPath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
    await assert.rejects(readMcpConnection(settingsPath), (error) => {
      assert.equal(error.message.includes(secret), false)
      return /未启用|无法读取|配置无效/.test(error.message)
    })
  }
  await writeFile(settingsPath, JSON.stringify({
    version: 1, enabled: true, port: 43127, token: secret, url: 'https://do-not-call.example/mcp',
  }), 'utf8')
  assert.deepEqual(await readMcpConnection(settingsPath), { url: 'http://127.0.0.1:43127/mcp', token: secret })
})

for (const negotiation of ['auto', 'legacy']) {
  test(`real stdio child (${negotiation}) discovers shared tools and submits a bound, idempotent preview without writing .qy`, { timeout: 20000 }, async (t) => {
    const probe = await fixture(t)
    const { instance, stderr } = await probe.client(negotiation)
    const tools = await instance.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...MCP_TOOL_NAMES].sort())
    assert.equal(tools.tools.some((tool) => tool.name.includes('approve')), false)
    const status = (await call(instance, 'qy_status')).value
    assert.equal(status.portfolioId, target.portfolioId)
    assert.equal(status.savedFile, true)
    const resources = await instance.listResources()
    assert.ok(resources.resources.some((resource) => resource.uri === 'qy://status'))
    assert.equal(JSON.parse((await instance.readResource({ uri: 'qy://status' })).contents[0].text).projectId, target.projectId)
    const providers = (await call(instance, 'qy_list_providers')).value
    assert.equal(JSON.stringify(providers).includes('must-be-omitted'), false)
    const responseJSON = JSON.stringify({
      message: '外部模型生成的测试计划', operations: [{ action: 'create_resource', resourceType: 'world', title: '合成世界' }],
    })
    const args = { ...target, responseJSON, requestId: `stdio-${negotiation}-plan` }
    const first = (await call(instance, 'qy_submit_plan', args)).value
    const duplicate = (await call(instance, 'qy_submit_plan', args)).value
    assert.equal(first.id, duplicate.id)
    await waitFor(() => probe.service.get(first.id).status === 'awaiting_approval')
    const preview = (await call(instance, 'qy_get_job', { jobId: first.id })).value
    assert.deepEqual(preview.target, target)
    assert.equal(preview.status, 'awaiting_approval')
    assert.equal(preview.result.plan.operations[0].title, '合成世界')
    assert.equal(await readFile(probe.fakeQyPath, 'utf8'), '{"synthetic":"only the desktop saver may write here"}\n')
    const bad = await instance.callTool({ name: 'qy_submit_plan', arguments: { responseJSON } })
    assert.equal(bad.isError, true)
    assert.equal(probe.service.list().length, 1)
    assert.equal(stderr().includes(probe.currentToken()), false)
  })
}

test('a running stdio adapter refreshes saved credentials after port change or token reset, and reports a disabled service', { timeout: 20000 }, async (t) => {
  const probe = await fixture(t)
  const { instance, stderr } = await probe.client()
  assert.equal((await call(instance, 'qy_status')).value.projectId, target.projectId)
  const previous = await readMcpConnection(probe.settingsPath)
  await probe.rotateAndMove()
  const next = await readMcpConnection(probe.settingsPath)
  assert.notEqual(next.token, previous.token)
  assert.equal((await call(instance, 'qy_status')).value.portfolioId, target.portfolioId)
  await writeFile(probe.settingsPath, JSON.stringify({ version: 1, enabled: false, port: 43127, token: next.token }), 'utf8')
  const disabled = await instance.callTool({ name: 'qy_status', arguments: {} })
  assert.equal(disabled.isError, true)
  assert.match(disabled.content[0].text, /未启用/)
  assert.equal(stderr().includes(previous.token) || stderr().includes(next.token), false)
})

test('stdin EOF cancels a provisional HTTP handshake promptly instead of waiting for its timeout', { timeout: 5000 }, async (t) => {
  const root = path.resolve(await mkdtemp(path.join(os.tmpdir(), 'qy-mcp-stdio-eof-')))
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('qy-mcp-stdio-eof-'))
  const sockets = new Set()
  let received
  const requested = new Promise((resolve) => { received = resolve })
  const stalled = http.createServer((request) => { request.resume(); received() })
  stalled.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve))
  const settingsPath = path.join(root, 'mcp-settings.json')
  await writeFile(settingsPath, JSON.stringify({
    version: 1, enabled: true, port: stalled.address().port, token: randomBytes(32).toString('base64url'),
  }), 'utf8')
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdout.resume()
  stderr.resume()
  const bridge = createMcpStdioBridge({ settingsPath, stdin, stdout, stderr, connectTimeoutMs: 10000 })
  t.after(async () => {
    await bridge.close()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => stalled.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eof-test', version: '1' } },
  })}\n`)
  await requested
  stdin.end()
  let timer
  try {
    await Promise.race([
      bridge.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('关闭仍然在等握手超时')), 1500) }),
    ])
  } finally {
    clearTimeout(timer)
  }
})

function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end()
  })
}

test('stdio help and invalid startup keep stdout exclusively for protocol and end without leftover processes', { timeout: 10000 }, async () => {
  const help = await invoke(['--help'])
  assert.equal(help.code, 0)
  assert.equal(help.stdout, '')
  assert.match(help.stderr, /MCP stdio/)
  const missing = await invoke(['--settings', path.join(os.tmpdir(), 'nonexistent-qy-mcp-configuration.json')])
  assert.equal(missing.code, 1)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /无法读取/)
})
