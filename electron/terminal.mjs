import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { killTerminalProcessTree, TERMINAL_INPUT_CHARS, TERMINAL_MAX_ACTIVE, terminalSize } from './terminal-host.mjs'

const OUTPUT_LIMIT = 262144
const RENDERER_HIGH_WATER = 131072
const RETAINED_EXITED = 8
const IPC_NAMES = ['list', 'create', 'input', 'resize', 'stop', 'snapshot', 'ack']
const SHELL_TITLES = { powershell: 'PowerShell', cmd: '命令提示符', codex: 'Codex CLI' }

export function resolveSystemNode({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  const name = platform === 'win32' ? 'node.exe' : 'node'
  const candidates = [
    env.NOVEL_NODE_BINARY,
    ...(platform === 'win32'
      ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', name)]
      : ['/usr/local/bin/node', '/usr/bin/node']),
    ...String(env[pathKey] || '').split(platform === 'win32' ? ';' : ':')
      .filter(Boolean).map((directory) => path.join(directory.replace(/^"|"$/g, ''), name)),
  ]
  const binary = candidates.find((candidate) => candidate && path.isAbsolute(candidate)
    && path.basename(candidate).toLowerCase() === name && exists(candidate))
  if (!binary) throw new Error('未找到系统 Node，终端需要系统 Node；请检查 start.bat 的 Node 环境。')
  return binary
}

export function launchTerminalHost({ projectRoot, endpointPath, logger = () => {} }) {
  const nodeBinary = resolveSystemNode()
  const helperPath = path.join(projectRoot, 'scripts', 'terminal-host.mjs')
  if (!existsSync(helperPath)) throw new Error('终端后台文件不存在，请更新完整的软件目录。')
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  if (endpointPath) env.QY_CLI_ENDPOINT = endpointPath
  const child = spawn(nodeBinary, [helperPath], {
    cwd: projectRoot, env, windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const requests = new Map()
  const listeners = new Set()
  const failures = new Set()
  let counter = 0
  let exited = false
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  // Keep failures observed even when a disposed window no longer awaits ready.
  void ready.catch(() => {})
  const readyTimer = setTimeout(() => fail(new Error('系统 Node 终端后台启动超时。')), 10000)
  const fail = (error) => {
    if (exited) return
    exited = true
    clearTimeout(readyTimer)
    readyReject(error)
    for (const pending of requests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    requests.clear()
    for (const listener of failures) listener(error)
  }
  child.on('message', (message) => {
    if (message?.kind === 'ready') {
      clearTimeout(readyTimer)
      logger('Terminal system Node ready', JSON.stringify(message.runtime))
      readyResolve()
    } else if (message?.kind === 'fatal') {
      fail(new Error(message.error || '终端后台异常。'))
    } else if (message?.kind === 'response') {
      const request = requests.get(message.requestId)
      if (!request) return
      requests.delete(message.requestId)
      clearTimeout(request.timer)
      if (message.ok) request.resolve(message.result)
      else request.reject(new Error(message.error || '终端操作失败。'))
    } else if (message?.kind === 'event') {
      for (const listener of listeners) listener(message.event)
    }
  })
  // Never log terminal output or environment values; a command can print secrets.
  child.stderr.on('data', () => {})
  child.on('error', (error) => fail(new Error(`无法启动系统 Node 终端：${error.code || '进程错误'}。`)))
  child.on('exit', (code) => fail(new Error(`终端后台已退出（${code ?? 'unknown'}）。`)))
  child.on('disconnect', () => fail(new Error('终端后台连接已断开。')))

  const request = async (command, payload = {}) => {
    await ready
    if (exited || !child.connected) throw new Error('终端后台已经关闭。')
    const requestId = ++counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(requestId)
        reject(new Error('终端操作超时。'))
      }, command === 'shutdown' ? 16000 : 12000)
      requests.set(requestId, { resolve, reject, timer })
      child.send({ kind: 'request', requestId, command, payload }, (error) => {
        if (!error || !requests.has(requestId)) return
        requests.delete(requestId)
        clearTimeout(timer)
        reject(new Error('无法向终端后台发送操作。'))
      })
    })
  }
  return {
    request,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    onFailure(listener) { failures.add(listener); return () => failures.delete(listener) },
    async dispose() {
      try { await request('shutdown') } catch {
        if (child.exitCode === null && child.pid) await killTerminalProcessTree(child.pid)
      }
      if (child.connected) child.disconnect()
      listeners.clear()
      failures.clear()
    },
  }
}

export function installDesktopTerminal({
  ipcMain, BrowserWindow, projectRoot, userDataPath, endpointPath,
  logger = () => {},
  launchHost = launchTerminalHost,
  isDirectory = (cwd) => statSync(cwd).isDirectory(),
}) {
  const sessions = new Map()
  const owners = new Map()
  let host
  let disposed = false
  let disposePromise
  const view = ({ id, title, shell, cwd, status, createdAt, exitCode, error }) => ({
    id, title, shell, cwd, status, createdAt,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(error ? { error } : {}),
  })
  const isActive = (session) => ['starting', 'running'].includes(session.status)
  const send = (session, event) => {
    if (!session.owner.isDestroyed()) session.owner.send('terminal:event', event)
  }
  const flushRenderer = (session) => {
    while (session.renderQueue.length && session.renderPendingChars < RENDERER_HIGH_WATER) {
      const event = session.renderQueue.shift()
      session.renderQueuedChars -= event.data.length
      session.renderPending.push({ sequence: event.sequence, chars: event.data.length })
      session.renderPendingChars += event.data.length
      send(session, event)
    }
  }
  const enqueueRenderer = (session, event) => {
    session.renderQueue.push(event)
    session.renderQueuedChars += event.data.length
    // The persistent main-process ring continues collecting output when its
    // view is unmounted. Bound renderer delivery independently; the next view
    // snapshot restores the retained tail without suspending a background job.
    while (session.renderQueuedChars > OUTPUT_LIMIT && session.renderQueue.length > 1) {
      session.renderQueuedChars -= session.renderQueue.shift().data.length
    }
    flushRenderer(session)
  }
  const acknowledgeHost = (session) => {
    if (session.hostAckTimer) return
    const sourceHost = host
    session.hostAckTimer = setTimeout(() => {
      session.hostAckTimer = undefined
      if (disposed || sessions.get(session.id) !== session || sourceHost !== host) return
      // ACK means the sole persistent output owner has buffered the data, not
      // that an optional view is mounted. A hidden terminal must keep working.
      void sourceHost?.request('ack', { sessionId: session.id, sequence: session.sequence }).catch(() => {})
    }, 5)
  }
  const currentOwner = (event) => {
    if (disposed) throw new Error('终端服务已关闭。')
    const sender = event?.sender
    const window = sender && BrowserWindow.fromWebContents(sender)
    if (!sender || sender.isDestroyed() || !window || window.isDestroyed()
      || window.webContents !== sender || event.senderFrame !== sender.mainFrame) {
      throw new Error('该窗口无权操作桌面终端。')
    }
    if (!owners.has(sender.id)) {
      const destroyed = () => {
        owners.delete(sender.id)
        for (const session of sessions.values()) {
          if (session.owner.id !== sender.id) continue
          sessions.delete(session.id)
          clearTimeout(session.hostAckTimer)
          if (isActive(session)) void host?.request('stop', { sessionId: session.id }).catch(() => {})
        }
      }
      owners.set(sender.id, { sender, destroyed })
      sender.once('destroyed', destroyed)
    }
    return sender
  }
  const getSession = (owner, payload) => {
    const id = typeof payload === 'string' ? payload : payload?.sessionId
    const session = sessions.get(id)
    if (!session || session.owner.id !== owner.id) throw new Error('该终端不存在或不属于当前窗口。')
    return session
  }
  const getHost = () => {
    if (host) return host
    host = launchHost({ projectRoot, userDataPath, endpointPath, logger })
    host.onEvent((event) => {
      const session = sessions.get(event?.sessionId)
      if (!session) return
      if (event.type === 'data' && typeof event.data === 'string' && Number.isSafeInteger(event.sequence)) {
        if (event.sequence <= session.sequence) return
        session.sequence = event.sequence
        session.output = (session.output + event.data).slice(-OUTPUT_LIMIT)
        acknowledgeHost(session)
        enqueueRenderer(session, event)
        return
      } else if (event.type === 'status') {
        if (['starting', 'running', 'error'].includes(event.status)) session.status = event.status
        if (event.error) session.error = event.error
      } else if (event.type === 'exit') {
        session.status = event.error || session.status === 'error' ? 'error' : 'exited'
        session.exitCode = event.exitCode
        if (event.error) session.error = event.error
      } else {
        return
      }
      send(session, event)
    })
    host.onFailure((error) => {
      logger('Terminal host failed', error)
      for (const session of sessions.values()) {
        if (!isActive(session)) continue
        session.status = 'error'
        session.error = error.message
        send(session, { sessionId: session.id, type: 'status', status: 'error', error: session.error })
        if (session.pid) void killTerminalProcessTree(session.pid)
      }
      const failedHost = host
      host = undefined
      void failedHost?.dispose().catch(() => {})
    })
    return host
  }
  const handlers = {
    list(event) {
      const owner = currentOwner(event)
      return [...sessions.values()].filter((session) => session.owner.id === owner.id).map(view)
    },
    async create(event, payload = {}) {
      const owner = currentOwner(event)
      const shell = payload.shell || 'powershell'
      if (!Object.hasOwn(SHELL_TITLES, shell)) throw new Error('不支持的终端类型。')
      if ([...sessions.values()].filter(isActive).length >= TERMINAL_MAX_ACTIVE) throw new Error('最多同时打开四个终端，请先关闭一个。')
      const cwd = typeof payload.cwd === 'string' ? path.resolve(payload.cwd) : path.resolve(projectRoot)
      try {
        if (cwd.includes('\0') || !isDirectory(cwd)) throw new Error()
      } catch { throw new Error('终端工作目录不存在或不是文件夹。') }
      const exited = [...sessions.values()].filter((session) => !isActive(session))
      for (const old of exited.slice(0, Math.max(0, exited.length - RETAINED_EXITED + 1))) sessions.delete(old.id)
      const session = {
        id: randomUUID(), title: SHELL_TITLES[shell], shell, cwd,
        status: 'starting', createdAt: Date.now(), owner, output: '', sequence: 0,
        renderQueue: [], renderQueuedChars: 0, renderPending: [], renderPendingChars: 0,
      }
      sessions.set(session.id, session)
      try {
        const result = await getHost().request('create', {
          id: session.id, shell, cwd,
          cols: terminalSize(payload.cols, 100, 2, 500),
          rows: terminalSize(payload.rows, 30, 1, 200),
        })
        session.pid = result.pid
        if (owner.isDestroyed() || disposed) {
          sessions.delete(session.id)
          await host?.request('stop', { sessionId: session.id }).catch(() => {})
          throw new Error('创建终端的窗口已经关闭。')
        }
        if (session.status === 'starting') session.status = 'running'
        return view(session)
      } catch (error) {
        session.status = 'error'
        session.error = error instanceof Error ? error.message : '无法创建终端。'
        send(session, { sessionId: session.id, type: 'status', status: 'error', error: session.error })
        throw error
      }
    },
    async input(event, payload) {
      const session = getSession(currentOwner(event), payload)
      if (!isActive(session)) throw new Error('终端会话已经结束。')
      if (typeof payload.data !== 'string' || payload.data.length > TERMINAL_INPUT_CHARS) throw new Error('终端输入过长或格式无效。')
      return getHost().request('input', { sessionId: session.id, data: payload.data, binary: payload.binary === true })
    },
    async resize(event, payload) {
      const session = getSession(currentOwner(event), payload)
      if (!isActive(session)) return { ok: true }
      return getHost().request('resize', {
        sessionId: session.id, cols: terminalSize(payload.cols, 100, 2, 500),
        rows: terminalSize(payload.rows, 30, 1, 200),
      })
    },
    async stop(event, payload) {
      const session = getSession(currentOwner(event), payload)
      if (isActive(session)) await getHost().request('stop', { sessionId: session.id })
      return { ok: true }
    },
    snapshot(event, payload) {
      const session = getSession(currentOwner(event), payload)
      return { session: view(session), output: session.output, sequence: session.sequence }
    },
    async ack(event, payload) {
      const session = getSession(currentOwner(event), payload)
      if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0 || payload.sequence > session.sequence) throw new Error('终端消费序号无效。')
      while (session.renderPending.length && session.renderPending[0].sequence <= payload.sequence) {
        session.renderPendingChars -= session.renderPending.shift().chars
      }
      while (session.renderQueue.length && session.renderQueue[0].sequence <= payload.sequence) {
        session.renderQueuedChars -= session.renderQueue.shift().data.length
      }
      flushRenderer(session)
      return { ok: true }
    },
  }
  for (const name of IPC_NAMES) ipcMain.handle(`terminal:${name}`, handlers[name])
  return {
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      for (const name of IPC_NAMES) ipcMain.removeHandler(`terminal:${name}`)
      for (const { sender, destroyed } of owners.values()) sender.removeListener('destroyed', destroyed)
      owners.clear()
      for (const session of sessions.values()) clearTimeout(session.hostAckTimer)
      const closingHost = host
      host = undefined
      disposePromise = Promise.resolve(closingHost?.dispose()).finally(() => sessions.clear())
      return disposePromise
    },
  }
}
