import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { installDesktopCloseHandshake } from '../electron/close-handshake.mjs'

function harness({ writeBarrier = async () => {}, dialogResponse = 0, dialogError } = {}) {
  const sent = []
  const dialogs = []
  const logs = []
  const timers = new Map()
  const ipcMain = new EventEmitter()
  const window = new EventEmitter()
  let destroyed = false
  let writesAwaited = 0
  window.isDestroyed = () => destroyed
  window.webContents = {
    isDestroyed: () => destroyed,
    send: (channel, ...args) => sent.push({ channel, args }),
  }
  window.close = () => {
    let prevented = false
    window.emit('close', { preventDefault: () => { prevented = true } })
    if (!prevented) {
      destroyed = true
      window.emit('closed')
    }
  }
  window.destroy = () => {
    destroyed = true
    window.emit('closed')
  }
  installDesktopCloseHandshake(window, {
    ipcMain,
    dialog: {
      async showMessageBox(owner, options) {
        dialogs.push({ owner, options })
        if (dialogError) throw dialogError
        return { response: dialogResponse }
      },
    },
    async waitForPendingWrites() {
      writesAwaited += 1
      await writeBarrier()
    },
    logger: (message, error) => logs.push({ message, error }),
    setTimer(callback) {
      const handle = Symbol('timeout')
      timers.set(handle, callback)
      return handle
    },
    clearTimer: (handle) => timers.delete(handle),
  })
  const latestRequestId = () => sent.filter((event) => event.channel === 'desktop:flush-request').at(-1).args[0]
  return {
    window, sent, dialogs, logs, timers, ipcMain, latestRequestId,
    writesAwaited: () => writesAwaited,
    complete(result, sender = window.webContents) {
      ipcMain.emit('desktop:flush-complete', { sender }, { requestId: latestRequestId(), ...result })
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('canceling the first-save picker keeps the window open without a failure dialog and permits another close attempt', async () => {
  const app = harness()
  app.window.close()
  assert.equal(app.latestRequestId(), 1)
  app.complete({ saved: false, canceled: true })
  await settle()

  assert.equal(app.window.isDestroyed(), false)
  assert.equal(app.dialogs.length, 0)
  assert.equal(app.logs.length, 0)
  assert.equal(app.writesAwaited(), 0)
  assert.equal(app.sent.at(-1).channel, 'desktop:flush-cancelled')
  assert.equal(app.timers.size, 0)
  assert.equal(app.ipcMain.listenerCount('desktop:flush-complete'), 0)

  app.window.close()
  assert.equal(app.latestRequestId(), 2)
  app.complete({ saved: true })
  await settle()
  assert.equal(app.window.isDestroyed(), true)
  assert.equal(app.writesAwaited(), 1)
})

test('successful renderer flush waits for queued .qy writes before destroying the window', async () => {
  let releaseWrites
  const barrier = new Promise((resolve) => { releaseWrites = resolve })
  const app = harness({ writeBarrier: () => barrier })
  app.window.close()
  app.window.close()
  assert.equal(app.sent.filter((event) => event.channel === 'desktop:flush-request').length, 1)
  app.complete({ saved: true })
  await settle()
  assert.equal(app.window.isDestroyed(), false)
  assert.equal(app.writesAwaited(), 1)
  releaseWrites()
  await settle()
  assert.equal(app.window.isDestroyed(), true)
  assert.equal(app.dialogs.length, 0)
})

test('close completion ignores another window and an older request before accepting the matching save', async () => {
  const app = harness()
  app.window.close()
  app.complete({ saved: true }, {})
  app.complete({ requestId: 0, saved: true })
  await settle()
  assert.equal(app.window.isDestroyed(), false)
  assert.equal(app.writesAwaited(), 0)
  assert.equal(app.timers.size, 1)
  app.complete({ saved: true })
  await settle()
  assert.equal(app.window.isDestroyed(), true)
})

test('a real write failure reports and logs its actual error and can return to the editor', async () => {
  const app = harness()
  app.window.close()
  const error = 'EACCES: 无法写入 E:\\作品集.qy'
  app.complete({ saved: false, error })
  await settle()
  assert.equal(app.window.isDestroyed(), false)
  assert.equal(app.dialogs.length, 1)
  assert.strictEqual(app.dialogs[0].owner, app.window)
  assert.equal(app.dialogs[0].options.detail, error)
  assert.equal(app.logs[0].error.message, error)
  assert.equal(app.sent.at(-1).channel, 'desktop:flush-cancelled')
  assert.equal(app.timers.size, 0)
})

test('an explicit abandon choice is the only failed-save path that closes the window', async () => {
  const app = harness({ dialogResponse: 1 })
  app.window.close()
  app.complete({ saved: false, error: '文件被占用。' })
  await settle()
  assert.equal(app.sent.at(-1).channel, 'desktop:flush-abandoned')
  assert.equal(app.window.isDestroyed(), true)
})

test('a failure-dialog exception is logged and leaves a retryable window', async () => {
  const app = harness({ dialogError: new Error('原生提示窗口不可用。') })
  app.window.close()
  app.complete({ saved: false, error: '文件被占用。' })
  await settle()
  assert.equal(app.window.isDestroyed(), false)
  assert.equal(app.logs[1].error.message, '原生提示窗口不可用。')
  assert.equal(app.sent.at(-1).channel, 'desktop:flush-cancelled')
  app.window.close()
  assert.equal(app.latestRequestId(), 2)
  app.complete({ saved: false, canceled: true })
  await settle()
  assert.equal(app.dialogs.length, 1)
})

test('timeout and window destruction clean up the IPC listener and pending timer', async () => {
  const app = harness()
  app.window.close()
  const timeout = [...app.timers.values()][0]
  timeout()
  await settle()
  assert.match(app.dialogs[0].options.detail, /保存完成超时/)
  assert.equal(app.ipcMain.listenerCount('desktop:flush-complete'), 0)
  assert.equal(app.timers.size, 0)
  app.window.close()
  app.window.destroy()
  assert.equal(app.ipcMain.listenerCount('desktop:flush-complete'), 0)
  assert.equal(app.timers.size, 0)
})
