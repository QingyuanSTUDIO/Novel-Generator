import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installDesktopTerminal, launchTerminalHost } from '../electron/terminal.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function waitFor(predicate, phase, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve() }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`PTY smoke timed out: ${phase}`)) }
    }, 25)
  })
}

test('system Node ConPTY supports PowerShell IO, resize, Ctrl+C and cleanup without any API call', {
  skip: process.platform !== 'win32',
  timeout: 25000,
}, async () => {
  const host = launchTerminalHost({ projectRoot })
  let output = ''
  let exited = false
  host.onEvent((event) => {
    if (event.type === 'data') {
      output = (output + event.data).slice(-262144)
      void host.request('ack', { sessionId: event.sessionId, sequence: event.sequence }).catch(() => {})
    }
    if (event.type === 'exit') exited = true
  })
  try {
    await host.request('create', { id: 'native-smoke', shell: 'powershell', cwd: projectRoot, cols: 90, rows: 25 })
    await host.request('input', { sessionId: 'native-smoke', data: "Write-Output ('QY_' + 'PTY_READY')\r" })
    await waitFor(() => output.includes('QY_PTY_READY'), 'initial PowerShell command')
    await host.request('resize', { sessionId: 'native-smoke', cols: 110, rows: 35 })
    await host.request('input', { sessionId: 'native-smoke', data: 'Start-Sleep -Seconds 30\r' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const interruptOffset = output.length
    await host.request('input', { sessionId: 'native-smoke', data: '\u0003' })
    // A human waits for the prompt before typing again; input submitted while
    // PowerShell is handling Ctrl+C can otherwise be consumed by that command.
    await waitFor(() => output.slice(interruptOffset).includes(`PS ${projectRoot}>`), 'Ctrl+C returns to prompt')
    await host.request('input', { sessionId: 'native-smoke', data: "Write-Output ('QY_' + 'AFTER_INTERRUPT')\r" })
    await waitFor(() => output.includes('QY_AFTER_INTERRUPT'), 'command after Ctrl+C')
    await host.request('stop', { sessionId: 'native-smoke' })
    assert.equal(exited, true)
  } finally {
    await host.dispose()
  }
})

test('native background terminal continues beyond the renderer ACK window while unmounted, then remounts from snapshot', {
  skip: process.platform !== 'win32',
  timeout: 25000,
}, async () => {
  const handlers = new Map()
  const sender = new EventEmitter()
  let deliveredChars = 0
  Object.assign(sender, {
    id: 55, mainFrame: {}, isDestroyed: () => false,
    send(_channel, event) { if (event.type === 'data') deliveredChars += event.data.length },
  })
  const window = { webContents: sender, isDestroyed: () => false }
  const service = installDesktopTerminal({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    BrowserWindow: { fromWebContents: () => window },
    projectRoot,
  })
  const event = { sender, senderFrame: sender.mainFrame }
  const call = (name, payload) => handlers.get(`terminal:${name}`)(event, payload)
  try {
    const session = await call('create', { shell: 'powershell' })
    await call('input', {
      sessionId: session.id,
      data: "1..1024 | ForEach-Object { [Console]::Write('x' * 2048) }; [Console]::WriteLine(('QY_' + 'HIDDEN_DONE'))\r",
    })
    await waitFor(() => call('snapshot', session.id).output.includes('QY_HIDDEN_DONE'), 'unmounted output completes')
    const snapshot = call('snapshot', session.id)
    assert.equal(snapshot.output.length, 262144)
    assert.ok(deliveredChars <= 147456, `renderer pending bytes bounded: ${deliveredChars}`)
    await call('ack', { sessionId: session.id, sequence: snapshot.sequence })
    await call('input', { sessionId: session.id, data: "Write-Output ('QY_' + 'REMOUNT_READY')\r" })
    await waitFor(() => call('snapshot', session.id).output.includes('QY_REMOUNT_READY'), 'command after remount')
    await call('stop', { sessionId: session.id })
  } finally {
    await service.dispose()
  }
})
