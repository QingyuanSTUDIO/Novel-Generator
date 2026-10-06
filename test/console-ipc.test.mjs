import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConsoleRendererTransport, installConsoleIpc } from '../electron/console-ipc.mjs'

function mockWindow(id = 1) {
  const sender = new EventEmitter()
  Object.assign(sender, {
    id, mainFrame: {}, sent: [], destroyed: false, loading: false,
    isDestroyed() { return this.destroyed },
    isLoadingMainFrame() { return this.loading },
    send(...args) { this.sent.push(args) },
  })
  return { webContents: sender, isDestroyed: () => sender.destroyed }
}
function transportFixture(timeoutMs = 1000) {
  const ipcMain = new EventEmitter()
  const window = mockWindow()
  const transport = createConsoleRendererTransport({ ipcMain, getWindow: () => window, timeoutMs })
  const reply = (channel, requestId, payload, sender = window.webContents, frame = sender.mainFrame) => {
    ipcMain.emit(channel, { sender, senderFrame: frame }, { requestId, ...payload })
  }
  return { ipcMain, window, transport, reply }
}

const command = { action: 'run', job: { id: 'job-one', prompt: 'local test only' } }

test('renderer transport resolves owner main-frame replies and removes per-request lifecycle listeners', async () => {
  const { transport, window, reply } = transportFixture()
  const pending = transport.execute(command)
  const [channel, requestId, payload] = window.webContents.sent[0]
  assert.equal(channel, 'console:execute')
  assert.equal(payload, command)
  reply('console:execute-complete', requestId, { result: { status: 'completed' } })
  assert.deepEqual(await pending, { status: 'completed' })
  for (const name of ['destroyed', 'render-process-gone', 'did-start-loading']) {
    assert.equal(window.webContents.listenerCount(name), 0)
  }
  transport.dispose()
})

test('another window and an iframe cannot complete an owner task', async () => {
  const { transport, window, reply } = transportFixture()
  const pending = transport.execute(command)
  const requestId = window.webContents.sent[0][1]
  let settled = false
  void pending.then(() => { settled = true })
  const other = mockWindow(2).webContents
  reply('console:execute-complete', requestId, { result: 'wrong window' }, other)
  reply('console:execute-complete', requestId, { result: 'wrong frame' }, window.webContents, {})
  await Promise.resolve()
  assert.equal(settled, false)
  reply('console:execute-complete', requestId, { result: { status: 'awaiting_approval' } })
  assert.deepEqual(await pending, { status: 'awaiting_approval' })
  transport.dispose()
})

test('reload, renderer crash and window destruction reject in-flight requests and ignore late completions', async () => {
  for (const lifecycle of ['did-start-loading', 'render-process-gone', 'destroyed']) {
    const { transport, window, reply } = transportFixture()
    const pending = transport.execute(command)
    const requestId = window.webContents.sent[0][1]
    const rejected = assert.rejects(pending, /窗口已关闭或重新加载/)
    if (lifecycle === 'did-start-loading') window.webContents.loading = true
    window.webContents.emit(lifecycle)
    await rejected
    reply('console:execute-complete', requestId, { result: { status: 'completed' } })
    assert.equal(window.webContents.listenerCount(lifecycle), 0)
    transport.dispose()
  }
})

test('subframe loading keeps the main-frame execution alive and does not consume its reload listener', async () => {
  const { transport, window, reply } = transportFixture()
  const pending = transport.execute(command)
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  const requestId = window.webContents.sent[0][1]
  window.webContents.emit('did-start-loading')
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(window.webContents.listenerCount('did-start-loading'), 1)
  const rejected = assert.rejects(pending, /重新加载/)
  window.webContents.loading = true
  window.webContents.emit('did-start-loading')
  await rejected
  reply('console:execute-complete', requestId, { result: { status: 'completed' } })
  assert.equal(window.webContents.listenerCount('did-start-loading'), 0)
  transport.dispose()
})

test('loading main frames reject dispatch before any command is sent', async () => {
  const { transport, window } = transportFixture()
  window.webContents.loading = true
  await assert.rejects(transport.execute(command), /尚未就绪/)
  await assert.rejects(transport.inspect({ kind: 'status' }), /尚未就绪/)
  assert.equal(window.webContents.sent.length, 0)
  transport.dispose()
})

test('timed-out completion cannot resolve a later request', async () => {
  const { transport, window, reply } = transportFixture(10)
  // The production timeout is unref'ed. Keep a short test handle alive while
  // waiting for it, without starting Electron or a real model request.
  const keepAlive = setTimeout(() => {}, 200)
  try {
    const timedOut = transport.execute(command)
    const oldId = window.webContents.sent[0][1]
    await assert.rejects(timedOut, /超时/)
    const replacement = transport.execute({ ...command, job: { id: 'job-two' } })
    const newId = window.webContents.sent.at(-1)[1]
    reply('console:execute-complete', oldId, { result: { status: 'completed', message: 'late' } })
    reply('console:execute-complete', newId, { result: { status: 'awaiting_approval', message: 'current' } })
    assert.deepEqual(await replacement, { status: 'awaiting_approval', message: 'current' })
  } finally {
    clearTimeout(keepAlive)
    transport.dispose()
  }
})

test('execution timeout awaits the cancellation fence before rejecting the transport promise', { timeout: 1000 }, async () => {
  const ipcMain = new EventEmitter()
  const window = mockWindow()
  let beginHook
  let releaseHook
  const hookStarted = new Promise((resolve) => { beginHook = resolve })
  const fence = new Promise((resolve) => { releaseHook = resolve })
  const observed = []
  const transport = createConsoleRendererTransport({
    ipcMain, getWindow: () => window, timeoutMs: 5,
    onTimeout: async (payload) => { observed.push(payload); beginHook(); await fence },
  })
  const keepAlive = setTimeout(() => {}, 200)
  try {
    let settled = false
    const pending = transport.execute(command)
    void pending.then(() => { settled = true }, () => { settled = true })
    const rejected = assert.rejects(pending, /超时/)
    await hookStarted
    await Promise.resolve()
    assert.equal(settled, false)
    assert.deepEqual(observed, [command])
    releaseHook()
    await rejected
  } finally {
    releaseHook()
    clearTimeout(keepAlive)
    transport.dispose()
  }
})

test('dispose rejects execute and inspection together and removes transport IPC listeners', async () => {
  const { ipcMain, transport, window } = transportFixture()
  const execution = assert.rejects(transport.execute(command), /服务已关闭/)
  const inspection = assert.rejects(transport.inspect({ kind: 'status' }), /服务已关闭/)
  transport.dispose()
  await Promise.all([execution, inspection])
  assert.equal(ipcMain.listenerCount('console:execute-complete'), 0)
  assert.equal(ipcMain.listenerCount('console:inspect-complete'), 0)
  assert.equal(window.webContents.listenerCount('destroyed'), 0)
})

function ipcFixture() {
  const handlers = new Map()
  let currentWindow = mockWindow()
  const calls = []
  let notify
  let unsubscribed = 0
  const service = Object.fromEntries(['list', 'submit', 'approve', 'pause', 'resume', 'cancel', 'report', 'checkpoint', 'suspend', 'waitForIdle']
    .map((name) => [name, (...args) => { calls.push({ name, args }); return name === 'list' ? [] : Promise.resolve() }]))
  service.subscribe = (callback) => { notify = callback; return () => { unsubscribed += 1 } }
  const installed = installConsoleIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    getWindow: () => currentWindow,
    service, endpointPath: 'endpoint-only.json', cliPath: 'qy-cli.mjs',
  })
  const owner = () => ({ sender: currentWindow.webContents, senderFrame: currentWindow.webContents.mainFrame })
  const call = (name, event = owner(), payload) => Promise.resolve().then(() => handlers.get(`console:${name}`)(event, payload))
  return {
    handlers, calls, installed, call, owner, notify: (jobs) => notify(jobs),
    window: () => currentWindow, replace: () => { currentWindow = mockWindow(2) },
    unsubscribed: () => unsubscribed,
  }
}

test('all console IPC handlers enforce the current main window and reject iframe calls before service mutations', async () => {
  const { installed, call, owner, handlers, calls } = ipcFixture()
  const mainOwner = owner()
  const other = mockWindow(3).webContents
  for (const channel of handlers.keys()) {
    const name = channel.slice('console:'.length)
    await assert.rejects(call(name, { sender: other, senderFrame: other.mainFrame }), /无权/)
    await assert.rejects(call(name, { sender: mainOwner.sender, senderFrame: {} }), /无权/)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(await call('info'), { endpointPath: 'endpoint-only.json', cliPath: 'qy-cli.mjs' })
  installed.dispose()
})

test('console IPC validates action enum, waits for suspended work, and targets only the current window for updates', async () => {
  const fixture = ipcFixture()
  await assert.rejects(fixture.call('action', fixture.owner(), { action: 'arbitrary', jobId: 'job' }), /无效/)
  await fixture.call('action', fixture.owner(), { action: 'pause', jobId: 'job' })
  await fixture.call('suspend')
  assert.deepEqual(fixture.calls.map((call) => call.name), ['pause', 'suspend', 'waitForIdle'])
  assert.deepEqual(fixture.calls.at(-1).args, [{ timeoutMs: 30000 }])
  const original = fixture.window()
  fixture.notify([{ id: 'first' }])
  fixture.replace()
  fixture.notify([{ id: 'second' }])
  assert.equal(original.webContents.sent.length, 1)
  assert.deepEqual(fixture.window().webContents.sent[0], ['console:update', [{ id: 'second' }]])
  fixture.installed.dispose()
  assert.equal(fixture.handlers.size, 0)
  assert.equal(fixture.unsubscribed(), 1)
})
