import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TERMINAL_MAX_ACTIVE = 4
export const TERMINAL_CHUNK_CHARS = 16384
export const TERMINAL_INPUT_CHARS = 65536
const OUTPUT_HIGH_WATER = 131072
const OUTPUT_LOW_WATER = 32768
const OUTPUT_QUEUE_LIMIT = 1048576

export function terminalSize(value, fallback, minimum, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function executableOnPath(name, { env, platform, exists }) {
  const key = Object.keys(env).find((item) => item.toLowerCase() === 'path')
  const directories = String(env[key] || '').split(platform === 'win32' ? ';' : ':')
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : ['']
  for (const directory of directories) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), `${name}${extension}`)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

export function resolveTerminalPreset(shell, {
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (!['powershell', 'cmd', 'codex'].includes(shell)) throw new Error('不支持的终端类型。')
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  const powershell = platform === 'win32'
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : executableOnPath('pwsh', { env, platform, exists })
  if (shell === 'cmd') {
    if (platform !== 'win32') throw new Error('命令提示符仅支持 Windows。')
    const command = path.join(systemRoot, 'System32', 'cmd.exe')
    if (!exists(command)) throw new Error('未找到 Windows 命令提示符。')
    return { command, args: ['/D'] }
  }
  if (shell === 'codex') {
    const codex = executableOnPath('codex', { env, platform, exists })
    if (!codex) throw new Error('未找到 Codex CLI，请先自行安装并登录后再打开此终端。')
    if (platform !== 'win32') return { command: codex, args: [] }
    if (!powershell || !exists(powershell)) throw new Error('未找到 Windows PowerShell。')
    // PowerShell invokes npm .cmd/.ps1 launchers as well as native executables.
    // This path is selected on the host, never supplied as renderer shell code.
    return { command: powershell, args: ['-NoLogo', '-NoProfile', '-Command', `& '${codex.replaceAll("'", "''")}'`] }
  }
  if (!powershell || !exists(powershell)) throw new Error('未找到 PowerShell。')
  return { command: powershell, args: ['-NoLogo', '-NoProfile'] }
}

export function killTerminalProcessTree(pid, {
  platform = process.platform,
  env = process.env,
  execute = execFile,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    if (platform === 'win32') {
      const command = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe')
      execute(command, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve())
    } else {
      try { process.kill(pid, 'SIGKILL') } catch { /* The process may already have exited. */ }
      resolve()
    }
  })
}

/** Native PTYs live only in a separate system Node process, never in Electron. */
export function createTerminalHost({
  pty,
  send,
  env = process.env,
  platform = process.platform,
  release = os.release(),
  resolvePreset = resolveTerminalPreset,
  isDirectory = (cwd) => statSync(cwd).isDirectory(),
  killTree = killTerminalProcessTree,
  stopTimeoutMs = 7000,
  shutdownGraceMs = platform === 'win32' ? 6000 : 0,
} = {}) {
  const sessions = new Map()
  let closing = false
  let shutdownPromise
  let lastKillAt = 0

  const event = (sessionId, value) => send({ kind: 'event', event: { sessionId, ...value } })
  const getSession = (id) => {
    const session = sessions.get(id)
    if (!session) throw new Error('终端会话已结束或不存在。')
    return session
  }
  const flow = (session) => {
    if (session.stopping) return
    if (!session.paused && session.pendingChars >= OUTPUT_HIGH_WATER) {
      session.paused = true
      session.terminal.pause()
    } else if (session.paused && session.pendingChars <= OUTPUT_LOW_WATER && session.queue.length === 0) {
      session.paused = false
      session.terminal.resume()
    }
  }
  const drain = (session, final = false) => {
    while (session.queue.length && (final || session.pendingChars < OUTPUT_HIGH_WATER)) {
      const data = session.queue.shift()
      session.queuedChars -= data.length
      const sequence = ++session.sequence
      session.pending.push({ sequence, chars: data.length })
      session.pendingChars += data.length
      event(session.id, { type: 'data', sequence, data })
    }
    flow(session)
  }
  const finish = (session, exitCode, error) => {
    if (session.finished) return
    session.finished = true
    clearTimeout(session.stopTimer)
    drain(session, true)
    for (const listener of session.listeners) listener.dispose()
    sessions.delete(session.id)
    event(session.id, { type: 'exit', exitCode, ...(error ? { error } : {}) })
    session.resolveStop?.({ stopped: true })
  }
  const stop = (session) => {
    if (session.stopPromise) return session.stopPromise
    session.stopping = true
    session.stopPromise = new Promise((resolve) => { session.resolveStop = resolve })
    if (session.paused) {
      session.paused = false
      session.terminal.resume()
    }
    lastKillAt = Date.now()
    session.stopTimer = setTimeout(async () => {
      await killTree(session.terminal.pid, { platform, env })
      finish(session, undefined, '终端未响应关闭，已结束其进程。')
    }, stopTimeoutMs)
    try {
      // Windows does not support the signal argument. Its ConPTY cleanup is
      // asynchronous, so keep the helper alive until cleanup has had time.
      session.terminal.kill()
    } catch {
      void killTree(session.terminal.pid, { platform, env }).finally(() => finish(session, undefined))
    }
    return session.stopPromise
  }

  return {
    async dispatch(command, payload = {}) {
      if (closing && command !== 'shutdown') throw new Error('终端服务正在关闭。')
      if (command === 'create') {
        if (sessions.size >= TERMINAL_MAX_ACTIVE) throw new Error('最多同时打开四个终端，请先关闭一个。')
        if (typeof payload.id !== 'string' || !payload.id || sessions.has(payload.id)) throw new Error('终端会话标识无效。')
        if (typeof payload.cwd !== 'string' || payload.cwd.includes('\0') || !isDirectory(payload.cwd)) throw new Error('终端工作目录不存在或不是文件夹。')
        if (platform === 'win32' && Number(release.split('.')[2]) < 18309) throw new Error('终端需要支持 ConPTY 的 Windows 10 1903 或更高版本。')
        const preset = resolvePreset(payload.shell, { env, platform })
        const terminalEnv = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
        delete terminalEnv.NODE_CHANNEL_FD
        delete terminalEnv.NODE_CHANNEL_SERIALIZATION_MODE
        delete terminalEnv.ELECTRON_RUN_AS_NODE
        delete terminalEnv.NODE_OPTIONS
        const terminal = pty.spawn(preset.command, preset.args, {
          name: 'xterm-256color',
          cols: terminalSize(payload.cols, 100, 2, 500),
          rows: terminalSize(payload.rows, 30, 1, 200),
          cwd: payload.cwd,
          env: terminalEnv,
          useConpty: platform === 'win32',
          useConptyDll: false,
        })
        const session = {
          id: payload.id, terminal, sequence: 0, queue: [], queuedChars: 0,
          pending: [], pendingChars: 0, paused: false, stopping: false, finished: false, listeners: [],
        }
        sessions.set(session.id, session)
        session.listeners.push(terminal.onData((data) => {
          if (session.finished) return
          for (let offset = 0; offset < data.length;) {
            let end = Math.min(data.length, offset + TERMINAL_CHUNK_CHARS)
            if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end -= 1
            const chunk = data.slice(offset, end)
            session.queue.push(chunk)
            session.queuedChars += chunk.length
            offset = end
          }
          if (session.queuedChars > OUTPUT_QUEUE_LIMIT) {
            session.queue.length = 0
            session.queuedChars = 0
            event(session.id, { type: 'status', status: 'error', error: '终端输出超过缓冲上限，已停止该会话。' })
            void stop(session)
            return
          }
          drain(session)
        }))
        session.listeners.push(terminal.onExit(({ exitCode }) => finish(session, exitCode)))
        event(session.id, { type: 'status', status: 'running' })
        return { pid: terminal.pid }
      }
      if (command === 'shutdown') {
        if (!shutdownPromise) {
          closing = true
          shutdownPromise = (async () => {
            await Promise.all([...sessions.values()].map(stop))
            const waitMs = Math.max(0, lastKillAt + shutdownGraceMs - Date.now())
            if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs))
            return { stopped: true }
          })()
        }
        return shutdownPromise
      }
      const session = getSession(payload.sessionId)
      if (command === 'stop') return stop(session)
      if (command === 'ack') {
        if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0 || payload.sequence > session.sequence) throw new Error('终端消费序号无效。')
        while (session.pending.length && session.pending[0].sequence <= payload.sequence) {
          session.pendingChars -= session.pending.shift().chars
        }
        drain(session)
        return { ok: true }
      }
      if (session.stopping) throw new Error('终端正在关闭。')
      if (command === 'input') {
        if (typeof payload.data !== 'string' || payload.data.length > TERMINAL_INPUT_CHARS) throw new Error('终端输入过长或格式无效。')
        session.terminal.write(payload.binary ? Buffer.from(payload.data, 'binary') : payload.data)
        return { ok: true }
      }
      if (command === 'resize') {
        session.terminal.resize(terminalSize(payload.cols, 100, 2, 500), terminalSize(payload.rows, 30, 1, 200))
        return { ok: true }
      }
      throw new Error('不支持的终端操作。')
    },
  }
}
