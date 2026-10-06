import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createMcpSettingsManager, defaultMcpPort } from '../electron/mcp-settings.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, hooks = {}) {
  const directory = path.resolve(await mkdtemp(path.join(os.tmpdir(), 'novel-mcp-settings-test-')))
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('novel-mcp-settings-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settingsPath = path.join(directory, 'mcp-settings.json')
  const service = { synthetic: true }
  const calls = { factories: [], starts: [], closes: [], notifications: [], logs: [] }
  const listeners = new Map()
  const managers = []

  function createServer(options) {
    assert.equal(options.service, service)
    calls.factories.push(options)
    let state = 'idle'
    const server = {
      async start() {
        calls.starts.push(options)
        if (hooks.beforeStart) await hooks.beforeStart(options, server)
        if (listeners.has(options.port)) throw new Error(`EADDRINUSE: synthetic port ${options.port}`)
        listeners.set(options.port, { server, token: options.token })
        state = 'running'
        return hooks.started?.(options) ?? {
          host: '127.0.0.1', port: options.port, url: `http://127.0.0.1:${options.port}/mcp`,
        }
      },
      async close() {
        calls.closes.push(options)
        if (hooks.beforeClose) await hooks.beforeClose(options, server)
        if (listeners.get(options.port)?.server === server) listeners.delete(options.port)
        state = 'closed'
      },
      status: () => state,
    }
    return server
  }

  function manager() {
    const instance = createMcpSettingsManager({
      settingsPath, createServer, service,
      logger: (...args) => calls.logs.push(args),
      onUpdate: (snapshot) => {
        calls.notifications.push(snapshot)
        hooks.onUpdate?.(snapshot)
      },
    })
    managers.push(instance)
    return instance
  }
  t.after(async () => {
    for (const instance of managers) await instance.close()
  })
  return {
    directory, settingsPath, calls, listeners, manager,
    persisted: async () => JSON.parse(await readFile(settingsPath, 'utf8')),
  }
}

test('MCP settings are independently initialized disabled with a stable cryptographic token', async (t) => {
  const probe = await fixture(t)
  const manager = probe.manager()
  assert.deepEqual(manager.info(), {
    enabled: false, port: 43127, url: 'http://127.0.0.1:43127/mcp',
    status: 'disabled', tokenConfigured: false,
    connected: false, connectionCount: 0, lastSeenAt: null, connectionLeaseMs: 90000,
  })
  assert.throws(() => manager.connectionCredentials(), /尚未就绪/)
  assert.equal(defaultMcpPort, 43127)

  const info = await manager.start()
  assert.equal(info.status, 'disabled')
  assert.equal(info.tokenConfigured, true)
  const credentials = manager.connectionCredentials()
  assert.match(credentials.token, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(await probe.persisted(), {
    version: 1, enabled: false, port: 43127, token: credentials.token,
  })
  await manager.start()
  assert.equal(manager.connectionCredentials().token, credentials.token)
  assert.equal(probe.calls.factories.length, 0)
  assert.equal(JSON.stringify(probe.calls.notifications).includes(credentials.token), false)
  if (process.platform !== 'win32') assert.equal((await stat(probe.settingsPath)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(probe.directory), ['mcp-settings.json'])
})

test('MCP configured connection and token survive shutdown and reload without rotation', async (t) => {
  const probe = await fixture(t)
  const first = probe.manager()
  await first.start()
  const originalToken = first.connectionCredentials().token
  const configured = await first.configure({ enabled: true, port: 43210 })
  assert.equal(configured.status, 'running')
  assert.equal(configured.port, 43210)
  assert.equal(probe.listeners.get(43210).token, originalToken)
  await first.close()
  assert.equal(probe.listeners.size, 0)
  assert.equal((await probe.persisted()).enabled, true)

  const reloaded = probe.manager()
  assert.equal((await reloaded.start()).status, 'running')
  assert.equal(reloaded.connectionCredentials().token, originalToken)
  assert.equal(reloaded.info().port, 43210)
  assert.equal(probe.listeners.size, 1)
  assert.equal(JSON.stringify(probe.calls.notifications).includes(originalToken), false)
  assert.equal(JSON.stringify(probe.calls.logs).includes(originalToken), false)
})

test('MCP disable closes its listener and persists only the desired setting with the token intact', async (t) => {
  const probe = await fixture(t)
  const manager = probe.manager()
  await manager.configure({ enabled: true, port: 43211 })
  const originalToken = manager.connectionCredentials().token
  const disabled = await manager.configure({ enabled: false, port: 43211 })
  assert.deepEqual(disabled, {
    enabled: false, port: 43211, url: 'http://127.0.0.1:43211/mcp',
    status: 'disabled', tokenConfigured: true,
    connected: false, connectionCount: 0, lastSeenAt: null, connectionLeaseMs: 90000,
  })
  assert.equal(probe.listeners.size, 0)
  assert.equal(probe.calls.closes.length, 1)
  assert.deepEqual(await probe.persisted(), {
    version: 1, enabled: false, port: 43211, token: originalToken,
  })
  assert.equal((await probe.manager().start()).status, 'disabled')
  assert.equal(probe.calls.factories.length, 1)
})

test('MCP token regeneration restarts an enabled listener with a newly persisted token', async (t) => {
  const probe = await fixture(t)
  const manager = probe.manager()
  await manager.configure({ enabled: true, port: 43212 })
  const oldToken = manager.connectionCredentials().token
  const regenerated = await manager.regenerateToken()
  const newToken = manager.connectionCredentials().token
  assert.equal(regenerated.status, 'running')
  assert.notEqual(newToken, oldToken)
  assert.equal((await probe.persisted()).token, newToken)
  assert.equal(probe.calls.factories.length, 2)
  assert.equal(probe.calls.closes.length, 1)
  assert.equal(probe.listeners.size, 1)
  assert.equal(probe.listeners.get(43212).token, newToken)
  for (const token of [oldToken, newToken]) {
    assert.equal(JSON.stringify(probe.calls.notifications).includes(token), false)
    assert.equal(JSON.stringify(probe.calls.logs).includes(token), false)
  }
  await manager.close()
  const reloaded = probe.manager()
  await reloaded.start()
  assert.equal(reloaded.connectionCredentials().token, newToken)
})

test('MCP token regeneration never reinstates the old token after the replacement listener fails', async (t) => {
  let failStart = false
  const probe = await fixture(t, {
    beforeStart: () => { if (failStart) throw new Error('Synthetic replacement listener failure') },
  })
  const manager = probe.manager()
  await manager.configure({ enabled: true, port: 43213 })
  const oldToken = manager.connectionCredentials().token
  failStart = true
  const result = await manager.regenerateToken()
  const newToken = manager.connectionCredentials().token
  assert.equal(result.status, 'error')
  assert.equal(result.enabled, true)
  assert.match(result.error, /replacement listener failure/)
  assert.notEqual(newToken, oldToken)
  assert.equal((await probe.persisted()).token, newToken)
  assert.equal(probe.listeners.size, 0)
  failStart = false
  assert.equal((await manager.start()).status, 'running')
  assert.equal(probe.listeners.get(43213).token, newToken)
})

test('MCP retry after a failed token-rotation cleanup cannot report the old-token listener as usable', async (t) => {
  for (const keepsFailing of [false, true]) {
    await t.test(keepsFailing ? 'old-listener-still-blocked' : 'old-listener-retry-succeeds', async (subtest) => {
      let oldToken
      let failOldClose = true
      let closeFailures = 0
      const probe = await fixture(subtest, {
        beforeClose(options) {
          if (options.token === oldToken && failOldClose && (keepsFailing || closeFailures === 0)) {
            closeFailures += 1
            throw new Error('Synthetic old-token listener cleanup failure')
          }
        },
      })
      const manager = probe.manager()
      await manager.configure({ enabled: true, port: 43227 })
      oldToken = manager.connectionCredentials().token
      assert.equal((await manager.regenerateToken()).status, 'error')
      const newToken = manager.connectionCredentials().token
      assert.notEqual(newToken, oldToken)
      assert.equal((await probe.persisted()).token, newToken)
      assert.equal(probe.listeners.get(43227).token, oldToken)

      const retry = await manager.configure({ enabled: true, port: 43227 })
      if (keepsFailing) {
        assert.equal(retry.status, 'error')
        assert.match(retry.error, /old-token listener cleanup failure/)
        assert.equal(probe.listeners.get(43227).token, oldToken)
        assert.equal(probe.calls.factories.length, 1)
        assert.equal((await manager.start()).status, 'error')
        failOldClose = false
      } else {
        assert.equal(retry.status, 'running')
        assert.equal(probe.listeners.get(43227).token, newToken)
      }
      assert.equal((await manager.start()).status, 'running')
      assert.equal(probe.listeners.size, 1)
      assert.equal(probe.listeners.get(43227).token, newToken)
      assert.equal(manager.connectionCredentials().token, newToken)
    })
  }
})

test('MCP occupied replacement port preserves and restores the original running connection', async (t) => {
  const probe = await fixture(t)
  const manager = probe.manager()
  await manager.configure({ enabled: true, port: 43214 })
  const original = await probe.persisted()
  probe.listeners.set(43215, { external: true })
  const result = await manager.configure({ enabled: true, port: 43215 })

  assert.equal(result.status, 'error')
  assert.equal(result.enabled, true)
  assert.equal(result.port, 43214)
  assert.match(result.error, /EADDRINUSE/)
  assert.deepEqual(await probe.persisted(), original)
  assert.equal(probe.listeners.get(43214).token, original.token)
  assert.equal(probe.listeners.get(43215).external, true)
  assert.equal(manager.connectionCredentials().token, original.token)

  const recovered = await manager.configure({ enabled: true, port: 43216 })
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.error, undefined)
  assert.equal(probe.listeners.has(43214), false)
  assert.equal(probe.listeners.get(43216).token, original.token)
})

test('MCP failed enable leaves the disabled persistent configuration unchanged', async (t) => {
  const probe = await fixture(t)
  const manager = probe.manager()
  await manager.start()
  const original = await probe.persisted()
  probe.listeners.set(43217, { external: true })
  const result = await manager.configure({ enabled: true, port: 43217 })
  assert.equal(result.status, 'error')
  assert.equal(result.enabled, false)
  assert.equal(result.port, 43127)
  assert.match(result.error, /EADDRINUSE/)
  assert.deepEqual(await probe.persisted(), original)
  assert.equal(probe.listeners.size, 1)
})

test('MCP persisted enabled startup failure is a public error snapshot and can retry safely', async (t) => {
  const probe = await fixture(t)
  const initial = probe.manager()
  await initial.configure({ enabled: true, port: 43218 })
  const originalToken = initial.connectionCredentials().token
  await initial.close()
  probe.listeners.set(43218, { external: true })

  const reloaded = probe.manager()
  const failed = await reloaded.start()
  assert.equal(failed.status, 'error')
  assert.equal(failed.enabled, true)
  assert.match(failed.error, /EADDRINUSE/)
  assert.equal(reloaded.connectionCredentials().token, originalToken)
  assert.equal((await probe.persisted()).token, originalToken)
  probe.listeners.delete(43218)
  assert.equal((await reloaded.start()).status, 'running')
  assert.equal(probe.listeners.get(43218).token, originalToken)
})

test('MCP configuration rejects invalid ports and values without touching disk or poisoning later actions', async (t) => {
  const probe = await fixture(t)
  const manager = probe.manager()
  for (const input of [
    null, { enabled: true, port: '43127' }, { enabled: 1, port: 43127 },
    { enabled: true, port: 0 }, { enabled: true, port: 1023 },
    { enabled: false, port: 65536 }, { enabled: true, port: 43200.5 },
    { enabled: true, port: Number.NaN }, { enabled: true, port: Infinity },
    { enabled: true, port: 43127, token: 'injected' },
  ]) {
    await assert.rejects(manager.configure(input), /MCP 配置需要/)
  }
  assert.deepEqual(await readdir(probe.directory), [])
  assert.equal(probe.calls.factories.length, 0)
  assert.equal((await manager.configure({ enabled: true, port: 65535 })).status, 'running')
  assert.equal((await manager.configure({ enabled: false, port: 1024 })).port, 1024)
})

test('MCP corrupt or unsupported settings are preserved until explicit token regeneration repairs them', async (t) => {
  for (const text of [
    '{"token":"sensitive-parser-snippet",',
    JSON.stringify({ version: 1, enabled: true, port: 80, token: 'a'.repeat(43) }),
    JSON.stringify({ version: 2, enabled: false, port: 43127, token: 'b'.repeat(43) }),
    JSON.stringify({ version: 1, enabled: true, port: 43127, token: 'short' }),
  ]) {
    await t.test('malformed-settings', async (subtest) => {
      const probe = await fixture(subtest)
      await writeFile(probe.settingsPath, text)
      const manager = probe.manager()
      const result = await manager.start()
      assert.equal(result.status, 'error')
      assert.equal(result.enabled, false)
      assert.equal(result.tokenConfigured, false)
      assert.match(result.error, /原文件已保留/)
      assert.equal(await readFile(probe.settingsPath, 'utf8'), text)
      assert.equal(probe.calls.factories.length, 0)
      assert.throws(() => manager.connectionCredentials(), /尚未就绪/)
      await assert.rejects(manager.configure({ enabled: false, port: 43127 }), /原文件已保留/)
      assert.equal(await readFile(probe.settingsPath, 'utf8'), text)
      assert.equal(JSON.stringify(probe.calls.logs).includes('sensitive-parser-snippet'), false)
      const fixed = await manager.regenerateToken()
      assert.equal(fixed.status, 'disabled')
      assert.equal(fixed.tokenConfigured, true)
      assert.equal((await probe.persisted()).token, manager.connectionCredentials().token)
    })
  }
})

test('MCP lifecycle actions are serialized while listener startup is pending', async (t) => {
  const started = deferred()
  const finish = deferred()
  t.after(finish.resolve)
  const probe = await fixture(t, {
    async beforeStart() {
      started.resolve()
      await finish.promise
    },
  })
  const manager = probe.manager()
  await manager.start()
  const oldToken = manager.connectionCredentials().token
  const enabling = manager.configure({ enabled: true, port: 43219 })
  await started.promise
  const disabling = manager.configure({ enabled: false, port: 43220 })
  const rotating = manager.regenerateToken()
  const closing = manager.close()
  assert.equal(manager.info().status, 'starting')
  assert.equal(probe.calls.factories.length, 1)
  assert.equal(probe.calls.closes.length, 0)
  assert.equal((await probe.persisted()).enabled, false)
  finish.resolve()

  assert.equal((await enabling).status, 'running')
  assert.equal((await disabling).status, 'disabled')
  assert.equal((await rotating).status, 'disabled')
  assert.equal((await closing).status, 'disabled')
  assert.equal(probe.listeners.size, 0)
  assert.equal(probe.calls.factories.length, 1)
  assert.equal(probe.calls.closes.length, 1)
  const saved = await probe.persisted()
  assert.equal(saved.enabled, false)
  assert.equal(saved.port, 43220)
  assert.notEqual(saved.token, oldToken)
})

test('MCP errors, server logger and status notifications redact all known tokens', async (t) => {
  const probe = await fixture(t, {
    beforeStart(options) {
      options.logger(`Synthetic server log ${options.token}`, new Error(`Synthetic server detail ${options.token}`))
      throw new Error(`Synthetic listener error ${options.token}`)
    },
  })
  const manager = probe.manager()
  await manager.start()
  const oldToken = manager.connectionCredentials().token
  const failed = await manager.configure({ enabled: true, port: 43221 })
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /\[已隐藏\]/)
  assert.equal(JSON.stringify(failed).includes(oldToken), false)
  const regenerated = await manager.regenerateToken()
  assert.equal(regenerated.status, 'disabled')
  const newToken = manager.connectionCredentials().token
  await manager.configure({ enabled: true, port: 43221 })
  for (const token of [oldToken, newToken]) {
    assert.equal(JSON.stringify(probe.calls.notifications).includes(token), false)
    assert.equal(JSON.stringify(probe.calls.logs).includes(token), false)
  }
})

test('MCP unexpected non-local binding is closed and never committed as enabled', async (t) => {
  const probe = await fixture(t, {
    started: ({ port }) => ({ host: '0.0.0.0', port, url: `http://0.0.0.0:${port}/mcp` }),
  })
  const manager = probe.manager()
  const result = await manager.configure({ enabled: true, port: 43222 })
  assert.equal(result.status, 'error')
  assert.match(result.error, /没有绑定预期的本机地址/)
  assert.equal(probe.listeners.size, 0)
  assert.equal(probe.calls.closes.length, 1)
  assert.equal((await probe.persisted()).enabled, false)
})

test('MCP atomic persistence failure cleans temporary files and restores the previous listener', async (t) => {
  const probe = await fixture(t)
  const manager = probe.manager()
  await manager.configure({ enabled: true, port: 43223 })
  const oldToken = manager.connectionCredentials().token
  await unlink(probe.settingsPath)
  await mkdir(probe.settingsPath)
  const result = await manager.configure({ enabled: true, port: 43224 })
  assert.equal(result.status, 'error')
  assert.equal(result.port, 43223)
  assert.equal(manager.connectionCredentials().token, oldToken)
  assert.equal(probe.listeners.has(43224), false)
  assert.equal(probe.listeners.get(43223).token, oldToken)
  assert.deepEqual(await readdir(probe.directory), ['mcp-settings.json'])
})

test('MCP disable cannot succeed while a failed replacement instance still has an open listener', async (t) => {
  let failedCleanupBlocked = true
  const probe = await fixture(t, {
    started: ({ port }) => ({
      host: port === 43229 ? '0.0.0.0' : '127.0.0.1',
      port, url: `http://127.0.0.1:${port}/mcp`,
    }),
    beforeClose: ({ port }) => {
      if (port === 43229 && failedCleanupBlocked) throw new Error('Synthetic failed replacement cleanup')
    },
  })
  const manager = probe.manager()
  await manager.configure({ enabled: true, port: 43228 })
  const original = await probe.persisted()
  assert.equal((await manager.configure({ enabled: true, port: 43229 })).status, 'error')
  assert.equal(probe.listeners.size, 2)

  const blockedDisable = await manager.configure({ enabled: false, port: 43228 })
  assert.equal(blockedDisable.status, 'error')
  assert.equal(blockedDisable.enabled, true)
  assert.match(blockedDisable.error, /failed replacement cleanup/)
  assert.deepEqual(await probe.persisted(), original)
  failedCleanupBlocked = false
  assert.equal((await manager.configure({ enabled: false, port: 43228 })).status, 'disabled')
  assert.equal(probe.listeners.size, 0)
  assert.equal((await probe.persisted()).enabled, false)
})

test('MCP close failure retains the server for another cleanup attempt without erasing startup preference', async (t) => {
  let closeAttempts = 0
  const probe = await fixture(t, {
    beforeClose: () => { if (++closeAttempts === 1) throw new Error('Synthetic shutdown failure') },
  })
  const manager = probe.manager()
  await manager.configure({ enabled: true, port: 43225 })
  const failed = await manager.close()
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /shutdown failure/)
  assert.equal(probe.listeners.size, 1)
  assert.equal((await probe.persisted()).enabled, true)
  assert.equal((await manager.close()).status, 'disabled')
  assert.equal(probe.listeners.size, 0)
  assert.equal((await probe.persisted()).enabled, true)
})

test('MCP notification and logging failures cannot interrupt startup or cleanup', async (t) => {
  const probe = await fixture(t, {
    onUpdate: () => { throw new Error('Synthetic notification consumer failure') },
  })
  const manager = createMcpSettingsManager({
    settingsPath: probe.settingsPath,
    service: {},
    createServer: ({ port }) => ({
      start: async () => ({ host: '127.0.0.1', port, url: `http://127.0.0.1:${port}/mcp` }),
      close: async () => {},
      status: () => 'running',
    }),
    onUpdate: () => { throw new Error('Synthetic notification failure') },
    logger: () => { throw new Error('Synthetic logger failure') },
  })
  t.after(() => manager.close())
  assert.equal((await manager.configure({ enabled: true, port: 43226 })).status, 'running')
  assert.equal((await manager.close()).status, 'disabled')
})
