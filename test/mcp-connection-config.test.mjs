import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mcpConnectionConfig } from '../electron/mcp-connection-config.mjs'
import { installMcpIpc } from '../electron/mcp-ipc.mjs'

const token = 'local-test-token-that-must-only-be-copied-explicitly'
const options = {
  credentials: { token, url: 'http://127.0.0.1:43127/mcp', enabled: true, port: 43127 },
  nodeCommand: 'C:\\Program Files\\nodejs\\node.exe',
  scriptPath: 'E:\\My Novels\\scripts\\qy-mcp.mjs',
  settingsPath: 'C:\\Users\\作者\\AppData\\Roaming\\novel-generator\\mcp-settings.json',
}

test('client exports share a stdio command with literal, safely encoded Windows paths and no credentials', () => {
  for (const kind of ['stdio', 'claude', 'zcode', 'generic', 'codex', 'dsh']) {
    const result = mcpConnectionConfig({ ...options, kind })
    assert.equal(result.text.includes(token), false)
    if (['stdio', 'claude', 'zcode'].includes(kind)) {
      const parsed = JSON.parse(result.text)
      const server = kind === 'zcode' ? parsed.mcp.servers.qy_novel : parsed.mcpServers.qy_novel
      assert.equal(server.command, options.nodeCommand)
      assert.deepEqual(server.args, [options.scriptPath, '--settings', options.settingsPath])
    }
  }
  const http = JSON.parse(mcpConnectionConfig({ ...options, kind: 'generic' }).text)
  assert.equal(http.mcpServers.qy_novel.type, 'http')
  assert.equal(http.mcpServers.qy_novel.url, options.credentials.url)
  assert.equal(http.mcpServers.qy_novel.headers.Authorization, 'Bearer <QY_MCP_TOKEN>')
})

test('Codex export uses TOML and DSH uses a Cordis overlay instead of assuming a universal config file', () => {
  const codex = mcpConnectionConfig({ ...options, kind: 'codex' }).text.split('\n')
  assert.equal(codex[0], '[mcp_servers.qy_novel]')
  assert.equal(JSON.parse(codex[1].slice('command = '.length)), options.nodeCommand)
  assert.deepEqual(JSON.parse(codex[2].slice('args = '.length)), [options.scriptPath, '--settings', options.settingsPath])
  const dsh = mcpConnectionConfig({ ...options, kind: 'dsh' }).text
  assert.match(dsh, /^- insert:\n/)
  assert.match(dsh, /name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(dsh, /serverName: qy_novel\n\s+transport: stdio/)
  const args = dsh.split('\n').filter((line) => line.startsWith('          - ')).map((line) => JSON.parse(line.slice(12)))
  assert.deepEqual(args, [options.scriptPath, '--settings', options.settingsPath])
})

test('only the explicit token export returns the secret and unsupported kinds are rejected', () => {
  assert.deepEqual(mcpConnectionConfig({ ...options, kind: 'token' }), { text: token })
  assert.throws(() => mcpConnectionConfig({ ...options, kind: 'other' }), /不支持/)
  assert.throws(() => mcpConnectionConfig({ ...options, kind: 'token', credentials: {} }), /尚未初始化/)
})

function ipcFixture() {
  const registered = new Map()
  const webContents = { mainFrame: {} }
  const window = { isDestroyed: () => false, webContents }
  const calls = []
  const manager = {
    info: () => ({ status: 'disabled', tokenConfigured: true }),
    configure: (input) => { calls.push(['configure', input]); return { status: 'running' } },
    regenerateToken: () => { calls.push(['rotate']); return { status: 'running' } },
    connectionCredentials: () => { calls.push(['credentials']); return options.credentials },
  }
  const bridge = installMcpIpc({
    ...options, manager, getWindow: () => window,
    ipcMain: { handle: (name, handler) => registered.set(name, handler), removeHandler: (name) => registered.delete(name) },
  })
  return { registered, bridge, window, calls, event: { sender: webContents, senderFrame: webContents.mainFrame } }
}

test('MCP settings IPC refuses other windows and iframes before reading any credentials or changing settings', () => {
  const fixture = ipcFixture()
  for (const handler of fixture.registered.values()) {
    assert.throws(() => handler({ sender: {}, senderFrame: {} }, 'token'), /无权/)
    assert.throws(() => handler({ sender: fixture.window.webContents, senderFrame: {} }, 'token'), /无权/)
  }
  assert.deepEqual(fixture.calls, [])
  fixture.bridge.dispose()
  assert.equal(fixture.registered.size, 0)
})

test('owner settings bridge exposes public info and accesses secrets only when exporting connection data', async () => {
  const fixture = ipcFixture()
  assert.deepEqual(await fixture.registered.get('mcp:info')(fixture.event), { status: 'disabled', tokenConfigured: true })
  assert.deepEqual(fixture.calls, [])
  assert.deepEqual(await fixture.registered.get('mcp:connection-config')(fixture.event, 'token'), { text: token })
  assert.deepEqual(await fixture.registered.get('mcp:configure')(fixture.event, { enabled: true, port: 43127 }), { status: 'running' })
  assert.deepEqual(fixture.calls, [['credentials'], ['configure', { enabled: true, port: 43127 }]])
  fixture.bridge.dispose()
})
