import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { installDesktopTerminal, resolveSystemNode } from '../electron/terminal.mjs'

function fixture() {
  const handlers = new Map()
  const hostEvents = new Set()
  const hostFailures = new Set()
  const requests = []
  let disposedCount = 0
  const windows = new Map()
  const owner = (id) => {
    const sender = new EventEmitter()
    Object.assign(sender, {
      id, mainFrame: {}, destroyed: false, events: [],
      isDestroyed() { return this.destroyed },
      send(channel, event) { this.events.push({ channel, event }) },
      destroy() { this.destroyed = true; this.emit('destroyed') },
    })
    windows.set(sender, { webContents: sender, isDestroyed: () => sender.destroyed })
    return { sender, senderFrame: sender.mainFrame }
  }
  const host = {
    onEvent(listener) { hostEvents.add(listener) },
    onFailure(listener) { hostFailures.add(listener) },
    async request(command, payload) {
      requests.push({ command, payload })
      if (command === 'create') return { pid: undefined }
      if (command === 'stop') this.emit({ sessionId: payload.sessionId, type: 'exit', exitCode: 0 })
      return { ok: true }
    },
    emit(event) { for (const listener of hostEvents) listener(event) },
    fail(error) { for (const listener of hostFailures) listener(error) },
    async dispose() { disposedCount += 1 },
  }
  const service = installDesktopTerminal({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    BrowserWindow: { fromWebContents: (sender) => windows.get(sender) },
    projectRoot: 'E:\\writing', userDataPath: 'C:\\profiles', endpointPath: 'C:\\endpoint.json',
    launchHost: () => host, isDirectory: () => true,
  })
  const call = (name, event, payload) => Promise.resolve().then(() => handlers.get(`terminal:${name}`)(event, payload))
  return { host, service, handlers, requests, owner, call, disposed: () => disposedCount }
}

test('every terminal IPC rejects another window and child frames', async () => {
  const { service, owner, call } = fixture()
  const first = owner(1)
  const second = owner(2)
  const session = await call('create', first)
  assert.equal((await call('list', first))[0].id, session.id)
  assert.deepEqual(await call('list', second), [])
  for (const command of ['input', 'resize', 'stop', 'snapshot', 'ack']) {
    await assert.rejects(call(command, second, { sessionId: session.id, data: 'x', sequence: 0 }), /不属于/)
  }
  await assert.rejects(call('list', { sender: first.sender, senderFrame: {} }), /无权/)
  await service.dispose()
})

test('output snapshot preserves cursor and bounds retained text', async () => {
  const { service, owner, call, host } = fixture()
  const event = owner(1)
  const session = await call('create', event)
  host.emit({ sessionId: session.id, type: 'data', sequence: 1, data: 'old'.repeat(100000) })
  host.emit({ sessionId: session.id, type: 'data', sequence: 2, data: 'tail' })
  const snapshot = await call('snapshot', event, session.id)
  assert.equal(snapshot.output.length, 262144)
  assert.equal(snapshot.output.endsWith('tail'), true)
  assert.equal(snapshot.sequence, 2)
  assert.equal(event.sender.events.every((item) => item.channel === 'terminal:event'), true)
  host.emit({ sessionId: session.id, type: 'data', sequence: 1, data: 'duplicate' })
  assert.equal((await call('snapshot', event, session.id)).output, snapshot.output)
  await assert.rejects(call('ack', event, { sessionId: session.id, sequence: 3 }), /序号/)
  await service.dispose()
})

test('main buffers and ACKs background output without a mounted view, bounding renderer delivery separately', async () => {
  const { service, owner, call, host, requests } = fixture()
  const event = owner(1)
  const session = await call('create', event)
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    host.emit({ sessionId: session.id, type: 'data', sequence, data: 'x'.repeat(16384) })
  }
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(requests.at(-1), { command: 'ack', payload: { sessionId: session.id, sequence: 100 } })
  assert.equal(event.sender.events.filter((item) => item.event.type === 'data').length, 8)
  const snapshot = await call('snapshot', event, session.id)
  assert.equal(snapshot.sequence, 100)
  assert.equal(snapshot.output.length, 262144)
  // Remount writes its snapshot, then ACKs that cursor. Old queued frames do
  // not repeat; new output can be delivered immediately after that snapshot.
  await call('ack', event, { sessionId: session.id, sequence: snapshot.sequence })
  host.emit({ sessionId: session.id, type: 'data', sequence: 101, data: 'after-remount' })
  assert.equal(event.sender.events.at(-1).event.data, 'after-remount')
  await service.dispose()
})

test('four concurrent terminal creations reserve capacity before the helper responds', async () => {
  const { service, owner, call, host } = fixture()
  const event = owner(1)
  const release = []
  host.request = (command) => command === 'create'
    ? new Promise((resolve) => release.push(() => resolve({ pid: undefined })))
    : Promise.resolve({ ok: true })
  const pending = Array.from({ length: 4 }, () => call('create', event))
  await Promise.resolve()
  await assert.rejects(call('create', event), /四个/)
  for (const resolve of release) resolve()
  await Promise.all(pending)
  await service.dispose()
})

test('renderer destruction closes only its own sessions', async () => {
  const { service, owner, call, requests } = fixture()
  const first = owner(1)
  const second = owner(2)
  const firstSession = await call('create', first)
  const secondSession = await call('create', second)
  first.sender.destroy()
  await Promise.resolve()
  assert.deepEqual(requests.filter((item) => item.command === 'stop').map((item) => item.payload.sessionId), [firstSession.id])
  assert.equal((await call('list', second))[0].id, secondSession.id)
  await service.dispose()
})

test('helper failure ends visible active status and dispose removes all IPC handlers once', async () => {
  const { service, owner, call, host, handlers, disposed } = fixture()
  const event = owner(1)
  const session = await call('create', event)
  host.fail(new Error('模拟后台错误'))
  assert.equal((await call('snapshot', event, session.id)).session.status, 'error')
  assert.equal(event.sender.events.at(-1).event.error, '模拟后台错误')
  await Promise.all([service.dispose(), service.dispose()])
  assert.equal(handlers.size, 0)
  assert.equal(disposed(), 1)
  assert.equal(event.sender.listenerCount('destroyed'), 0)
})

test('input type/size and unknown shell presets are rejected before reaching a PTY', async () => {
  const { service, owner, call, requests } = fixture()
  const event = owner(1)
  await assert.rejects(call('create', event, { shell: 'exec-anything' }), /不支持/)
  const session = await call('create', event)
  await assert.rejects(call('input', event, { sessionId: session.id, data: 'x'.repeat(65537) }), /输入/)
  await call('input', event, { sessionId: session.id, data: '\u0003', binary: false })
  assert.equal(requests.at(-1).payload.data, '\u0003')
  await service.dispose()
})

test('Node lookup accepts system node but never substitutes electron.exe', () => {
  const exists = () => true
  assert.equal(resolveSystemNode({
    env: { NOVEL_NODE_BINARY: 'D:\\runtime\\node.exe', PATH: '' }, platform: 'win32', exists,
  }), 'D:\\runtime\\node.exe')
  const node = resolveSystemNode({
    env: { NOVEL_NODE_BINARY: 'D:\\electron.exe', ProgramFiles: 'C:\\Program Files', PATH: '' },
    platform: 'win32', exists,
  })
  assert.equal(node, 'C:\\Program Files\\nodejs\\node.exe')
  assert.throws(() => resolveSystemNode({ env: {}, platform: 'win32', exists: () => false }), /系统 Node/)
})
