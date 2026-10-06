import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalHost, resolveTerminalPreset, terminalSize } from '../electron/terminal-host.mjs'

function fixture(options = {}) {
  const events = []
  const terminals = []
  const spawnCalls = []
  const killedTrees = []
  const pty = {
    spawn(command, args, settings) {
      spawnCalls.push({ command, args, settings })
      const dataListeners = new Set()
      const exitListeners = new Set()
      const terminal = {
        pid: 100 + terminals.length, writes: [], sizes: [], paused: 0, resumed: 0, kills: [],
        onData(listener) { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) } },
        onExit(listener) { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) } },
        emitData(data) { for (const listener of dataListeners) listener(data) },
        emitExit(exitCode = 0) { for (const listener of exitListeners) listener({ exitCode }) },
        write(data) { this.writes.push(data) },
        resize(cols, rows) { this.sizes.push({ cols, rows }) },
        pause() { this.paused += 1 },
        resume() { this.resumed += 1 },
        kill(...args) { this.kills.push(args); if (!options.deferExit) this.emitExit(0) },
      }
      terminals.push(terminal)
      return terminal
    },
  }
  const host = createTerminalHost({
    pty, send: (message) => events.push(message.event),
    env: { SystemRoot: 'C:\\Windows', QY_CLI_ENDPOINT: 'endpoint.json', NODE_CHANNEL_FD: '7', NODE_OPTIONS: '--inspect' },
    platform: 'win32', release: '10.0.26100',
    resolvePreset: () => ({ command: 'powershell.exe', args: ['-NoProfile'] }),
    isDirectory: () => true,
    killTree: async (pid) => { killedTrees.push(pid) },
    shutdownGraceMs: 0, stopTimeoutMs: 20,
    ...options.host,
  })
  const create = (id = 'one', extra = {}) => host.dispatch('create', { id, cwd: 'C:\\writing', shell: 'powershell', ...extra })
  return { host, create, events, terminals, spawnCalls, killedTrees }
}

test('host starts a real PTY contract with ConPTY and keeps endpoint as environment only', async () => {
  const { create, host, spawnCalls, events } = fixture()
  assert.deepEqual(await create(), { pid: 100 })
  const settings = spawnCalls[0].settings
  assert.equal(settings.useConpty, true)
  assert.equal(settings.env.SystemRoot, 'C:\\Windows')
  assert.equal(settings.env.QY_CLI_ENDPOINT, 'endpoint.json')
  assert.equal(settings.env.NODE_CHANNEL_FD, undefined)
  assert.equal(settings.env.NODE_OPTIONS, undefined)
  assert.equal(JSON.stringify(events).includes('endpoint.json'), false)
  await host.dispatch('shutdown')
})

test('stdin includes control characters, and binary input keeps byte values', async () => {
  const { create, host, terminals } = fixture()
  await create()
  await host.dispatch('input', { sessionId: 'one', data: 'hello\r\u0003' })
  await host.dispatch('input', { sessionId: 'one', data: '\xff\x00', binary: true })
  assert.equal(terminals[0].writes[0], 'hello\r\u0003')
  assert.deepEqual([...terminals[0].writes[1]], [255, 0])
  await assert.rejects(host.dispatch('input', { sessionId: 'one', data: 'x'.repeat(65537) }), /输入/)
  await host.dispatch('shutdown')
})

test('resize clamps invalid or enormous dimensions', async () => {
  const { create, host, spawnCalls, terminals } = fixture()
  await create('one', { cols: -1, rows: Number.POSITIVE_INFINITY })
  assert.equal(spawnCalls[0].settings.cols, 2)
  assert.equal(spawnCalls[0].settings.rows, 30)
  await host.dispatch('resize', { sessionId: 'one', cols: 9000, rows: -9 })
  assert.deepEqual(terminals[0].sizes, [{ cols: 500, rows: 1 }])
  assert.equal(terminalSize(Number.NaN, 100, 2, 500), 100)
  await host.dispatch('shutdown')
})

test('output is sequenced, pauses at high water and resumes only after consumer ACK', async () => {
  const { create, host, terminals, events } = fixture()
  await create()
  terminals[0].emitData('x'.repeat(200000))
  const before = events.filter((event) => event.type === 'data')
  assert.equal(before.reduce((total, event) => total + event.data.length, 0), 131072)
  assert.equal(terminals[0].paused, 1)
  assert.deepEqual(before.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8])
  await host.dispatch('ack', { sessionId: 'one', sequence: 8 })
  const after = events.filter((event) => event.type === 'data')
  assert.equal(after.reduce((total, event) => total + event.data.length, 0), 200000)
  assert.equal(terminals[0].resumed, 0)
  await host.dispatch('ack', { sessionId: 'one', sequence: after.at(-1).sequence })
  assert.equal(terminals[0].resumed, 1)
  await assert.rejects(host.dispatch('ack', { sessionId: 'one', sequence: 9999 }), /序号/)
  await host.dispatch('shutdown')
})

test('unbounded output queue stops its PTY instead of growing memory indefinitely', async () => {
  const { create, host, terminals, events } = fixture()
  await create()
  terminals[0].emitData('x'.repeat(1100000))
  assert.equal(terminals[0].kills.length, 1)
  assert.equal(events.some((event) => event.type === 'status' && event.status === 'error'), true)
  await host.dispatch('shutdown')
})

test('host enforces four active PTYs and frees capacity after natural exit', async () => {
  const { create, host, terminals } = fixture()
  for (const id of ['one', 'two', 'three', 'four']) await create(id)
  await assert.rejects(create('five'), /四个/)
  terminals[0].emitExit(3)
  await create('five')
  await assert.rejects(host.dispatch('input', { sessionId: 'one', data: 'x' }), /结束/)
  await host.dispatch('shutdown')
})

test('immediate close is idempotent and kills without a Windows signal argument', async () => {
  const { create, host, terminals, events } = fixture({ deferExit: true })
  await create()
  const first = host.dispatch('stop', { sessionId: 'one' })
  const second = host.dispatch('stop', { sessionId: 'one' })
  assert.deepEqual(terminals[0].kills, [[]])
  terminals[0].emitData('last output')
  terminals[0].emitExit(130)
  await Promise.all([first, second])
  assert.equal(events.filter((event) => event.type === 'exit').length, 1)
  assert.equal(events.filter((event) => event.type === 'data')[0].data, 'last output')
  await host.dispatch('shutdown')
})

test('nonresponsive ConPTY gets a bounded process-tree cleanup on close', async () => {
  const { create, host, killedTrees } = fixture({ deferExit: true })
  await create()
  await host.dispatch('stop', { sessionId: 'one' })
  assert.deepEqual(killedTrees, [100])
  await host.dispatch('shutdown')
})

test('old Windows cannot silently fall back to winpty', async () => {
  const { create } = fixture({ host: { release: '10.0.17763' } })
  await assert.rejects(create(), /ConPTY/)
})

test('Codex preset reports absent CLI and quotes detected launcher without interpreting its path', () => {
  assert.throws(() => resolveTerminalPreset('codex', {
    platform: 'win32', env: { PATH: 'C:\\none' }, exists: () => false,
  }), /未找到 Codex CLI/)
  const preset = resolveTerminalPreset('codex', {
    platform: 'win32', env: { PATH: "C:\\a'b", SystemRoot: 'C:\\Windows' }, exists: () => true,
  })
  assert.equal(preset.args.at(-1), "& 'C:\\a''b\\codex.exe'")
  assert.throws(() => resolveTerminalPreset('custom'), /不支持/)
})
