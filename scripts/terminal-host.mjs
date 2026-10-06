import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createTerminalHost } from '../electron/terminal-host.mjs'

export async function runTerminalHost() {
  if (typeof process.send !== 'function' || process.versions.electron) {
    process.stderr.write('终端后台必须由系统 Node 通过桌面 IPC 启动。\n')
    process.exitCode = 1
    return
  }
  const send = (message, callback) => {
    if (process.connected) process.send(message, callback || (() => {}))
  }
  let nativePty
  try {
    nativePty = await import('node-pty')
  } catch {
    send({ kind: 'fatal', error: '无法加载 node-pty。请用系统 Node 重新安装依赖；不需要重编译 Electron 模块。' })
    process.disconnect()
    process.exitCode = 1
    return
  }
  const host = createTerminalHost({ pty: nativePty, send })
  let ending = false
  const close = async (code = 0) => {
    if (ending) return
    ending = true
    await host.dispatch('shutdown')
    if (process.connected) process.disconnect()
    process.exit(code)
  }
  process.on('message', async (message) => {
    if (!message || message.kind !== 'request' || !Number.isSafeInteger(message.requestId)) return
    try {
      const result = await host.dispatch(message.command, message.payload)
      if (message.command === 'shutdown') {
        send({ kind: 'response', requestId: message.requestId, ok: true, result }, () => { void close() })
      } else {
        send({ kind: 'response', requestId: message.requestId, ok: true, result })
      }
    } catch (error) {
      send({
        kind: 'response', requestId: message.requestId, ok: false,
        error: error instanceof Error ? error.message : '终端操作失败。',
      })
    }
  })
  process.once('disconnect', () => { void close() })
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
  process.once('uncaughtException', () => {
    send({ kind: 'fatal', error: '终端后台发生异常，正在清理会话。' })
    void close(1)
  })
  process.once('unhandledRejection', () => {
    send({ kind: 'fatal', error: '终端后台发生异常，正在清理会话。' })
    void close(1)
  })
  send({
    kind: 'ready',
    runtime: {
      node: process.version, nodeBinary: process.execPath,
      platform: process.platform, arch: process.arch,
      modules: process.versions.modules, napi: process.versions.napi,
      ptyModulePath: createRequire(import.meta.url).resolve('node-pty'),
    },
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTerminalHost()
}
