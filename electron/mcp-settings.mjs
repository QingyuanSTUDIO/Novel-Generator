import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { MCP_CONNECTION_LEASE_MS } from './mcp-connections.mjs'

export const defaultMcpPort = 43127

const defaultSettings = () => ({ version: 1, enabled: false, port: defaultMcpPort, token: '' })
const connectionUrl = (port) => `http://127.0.0.1:${port}/mcp`
const validPort = (port) => Number.isInteger(port) && port >= 1024 && port <= 65535

function validateConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || !validPort(value.port)
    || Object.keys(value).some((key) => !['enabled', 'port'].includes(key))) {
    throw new Error('MCP 配置需要启用开关及 1024～65535 范围内的整数端口。')
  }
  return { enabled: value.enabled, port: value.port }
}

function parseSettings(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    // JSON parser diagnostics can quote document contents, including a token.
    throw new Error('MCP 配置文件已损坏；原文件已保留，请显式重新生成令牌以修复。')
  }
  if (!value || value.version !== 1 || typeof value.enabled !== 'boolean'
    || !validPort(value.port) || typeof value.token !== 'string'
    || !/^[A-Za-z0-9_-]{43,512}$/.test(value.token)) {
    throw new Error('MCP 配置文件格式无效；原文件已保留，请显式重新生成令牌以修复。')
  }
  return { version: 1, enabled: value.enabled, port: value.port, token: value.token }
}

async function writeSettings(filePath, settings) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let handle
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, filePath)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temporaryPath).catch(() => {})
  }
}

/**
 * This file belongs in Electron's userData directory. It is deliberately
 * independent of the portfolio and desktop profile serializers. Only the
 * main process may use connectionCredentials(); notifications are public.
 */
export function createMcpSettingsManager({
  settingsPath,
  createServer,
  service,
  logger = () => {},
  onUpdate = () => {},
}) {
  if (typeof settingsPath !== 'string' || !settingsPath.trim() || !path.isAbsolute(settingsPath)) {
    throw new Error('MCP 配置文件需要绝对路径。')
  }
  if (typeof createServer !== 'function') throw new Error('缺少 MCP 服务工厂。')

  let settings = defaultSettings()
  let pendingSettings
  let loaded = false
  let loadAttempted = false
  let status = 'disabled'
  let error
  let activeServer
  const servers = new Set()
  const serverConfigurations = new WeakMap()
  const privateTokens = new Set()
  let queue = Promise.resolve()

  function publicError(cause) {
    let message = cause instanceof Error ? cause.message : String(cause || 'MCP 服务操作失败。')
    for (const token of privateTokens) message = message.split(token).join('[已隐藏]')
    return message
  }

  function safeLog(message, cause) {
    try {
      logger(message, cause === undefined ? undefined : publicError(cause))
    } catch {
      // A diagnostic sink must not interrupt service cleanup or persistence.
    }
  }

  function info() {
    const visible = pendingSettings ?? settings
    const activeConfiguration = activeServer ? serverConfigurations.get(activeServer) : undefined
    const currentCredentials = visible.enabled && activeConfiguration?.token === visible.token
      && activeConfiguration?.port === visible.port
    let actual
    if (currentCredentials && typeof activeServer?.status === 'function') {
      try { actual = activeServer.status() } catch { /* public status remains disconnected */ }
    }
    const connected = Boolean(actual?.running && actual?.connected)
    return {
      enabled: visible.enabled,
      port: visible.port,
      url: connectionUrl(visible.port),
      status,
      ...(error ? { error } : {}),
      tokenConfigured: Boolean(visible.token),
      connected,
      connectionCount: connected ? actual.connectionCount : 0,
      lastSeenAt: currentCredentials && actual?.running ? (actual.lastSeenAt ?? null) : null,
      connectionLeaseMs: actual?.connectionLeaseMs ?? MCP_CONNECTION_LEASE_MS,
    }
  }

  function publish(nextStatus, cause) {
    status = nextStatus
    error = cause === undefined ? undefined : publicError(cause)
    const snapshot = info()
    try {
      const notification = onUpdate(snapshot)
      if (notification && typeof notification.catch === 'function') {
        notification.catch((cause) => safeLog('MCP status notification failed', cause))
      }
    } catch (cause) {
      safeLog('MCP status notification failed', cause)
    }
    return info()
  }

  function serialize(operation) {
    const result = queue.then(operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  async function load() {
    if (loadAttempted) return loaded
    loadAttempted = true
    try {
      let text
      try {
        text = await readFile(settingsPath, 'utf8')
      } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause
      }
      if (text === undefined) {
        const initial = { ...defaultSettings(), token: randomBytes(32).toString('base64url') }
        privateTokens.add(initial.token)
        await writeSettings(settingsPath, initial)
        settings = initial
      } else {
        settings = parseSettings(text)
        privateTokens.add(settings.token)
      }
      loaded = true
      return true
    } catch (cause) {
      safeLog('MCP settings could not be loaded', cause)
      publish('error', cause)
      return false
    }
  }

  async function stopServer(server) {
    if (!server) return
    await server.close()
    servers.delete(server)
    if (activeServer === server) activeServer = undefined
  }

  async function openServer(configuration) {
    let server
    server = createServer({
      service, token: configuration.token, port: configuration.port,
      logger: (message, cause) => safeLog(publicError(message), cause),
      onConnectionsChanged: () => {
        // A replaced listener may still finish a request during cleanup.
        // Only the actual active instance can publish its connection leases.
        if (server && activeServer === server) publish(status, error)
      },
    })
    if (!server || typeof server.start !== 'function' || typeof server.close !== 'function') {
      throw new Error('MCP 服务工厂返回了无效服务。')
    }
    servers.add(server)
    serverConfigurations.set(server, { token: configuration.token, port: configuration.port })
    try {
      const started = await server.start()
      const url = new URL(started?.url)
      if (started?.host !== '127.0.0.1' || started.port !== configuration.port
        || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
        || Number(url.port) !== configuration.port || url.pathname !== '/mcp'
        || url.username || url.password || url.search || url.hash) {
        throw new Error('MCP 服务没有绑定预期的本机地址。')
      }
      return server
    } catch (cause) {
      try {
        await stopServer(server)
      } catch (closeError) {
        safeLog('MCP failed service cleanup failed', closeError)
      }
      throw cause
    }
  }

  async function startLoaded() {
    const activeConfiguration = activeServer ? serverConfigurations.get(activeServer) : undefined
    const matchesSavedCredentials = settings.enabled && activeConfiguration?.token === settings.token
      && activeConfiguration?.port === settings.port
    if (!settings.enabled && servers.size === 0) return publish('disabled')
    if (matchesSavedCredentials && servers.size === 1) return publish('running')
    publish('starting')
    try {
      // A failed close during token rotation can leave an old listener alive.
      // Its existence never proves that the new saved credentials work.
      for (const server of [...servers]) {
        if (matchesSavedCredentials && server === activeServer) continue
        await stopServer(server)
      }
      if (!settings.enabled) return publish('disabled')
      if (matchesSavedCredentials) return publish('running')
      activeServer = await openServer(settings)
      return publish('running')
    } catch (cause) {
      safeLog('MCP service startup failed', cause)
      return publish('error', cause)
    }
  }

  function start() {
    return serialize(async () => {
      if (!await load()) return info()
      return startLoaded()
    })
  }

  function configure(configuration) {
    return serialize(async () => {
      const validated = validateConfiguration(configuration)
      if (!await load()) throw new Error(error || 'MCP 配置尚未就绪。')
      if (validated.enabled === settings.enabled && validated.port === settings.port) {
        return startLoaded()
      }
      const previous = settings
      const previousServer = activeServer
      let candidate
      pendingSettings = { ...settings, ...validated }
      publish('starting')
      try {
        // Failed starts can also leave tracked instances whose cleanup failed.
        // Enabling a replacement or reporting disabled requires closing them.
        for (const server of [...servers]) await stopServer(server)
        if (pendingSettings.enabled) candidate = await openServer(pendingSettings)
        await writeSettings(settingsPath, pendingSettings)
        settings = pendingSettings
        pendingSettings = undefined
        activeServer = candidate
        return publish(settings.enabled ? 'running' : 'disabled')
      } catch (cause) {
        let recoveryError
        let restoredConnection = false
        try {
          await stopServer(candidate)
          // If stopping the old instance threw, keep it tracked for close().
          // Otherwise restore its exact saved token and port.
          if (previousServer && !servers.has(previousServer)) {
            activeServer = await openServer(previous)
            restoredConnection = true
          }
        } catch (restoreError) {
          recoveryError = restoreError
          safeLog('MCP previous connection restoration failed', restoreError)
        }
        pendingSettings = undefined
        safeLog('MCP configuration update failed', cause)
        return publish('error', `${publicError(cause)}${recoveryError
          ? `；恢复原连接失败：${publicError(recoveryError)}`
          : restoredConnection ? '；原配置已保留，原连接已恢复。' : '；原配置已保留。'}`)
      }
    })
  }

  function regenerateToken() {
    return serialize(async () => {
      await load()
      const next = { ...settings, token: randomBytes(32).toString('base64url') }
      privateTokens.add(next.token)
      try {
        // Rotation is explicit. Once confirmed on disk, never reinstate the
        // old token because restarting the listener failed.
        await writeSettings(settingsPath, next)
      } catch (cause) {
        safeLog('MCP token could not be saved', cause)
        return publish('error', cause)
      }
      settings = next
      loaded = true
      pendingSettings = undefined
      publish(settings.enabled ? 'starting' : 'disabled')
      try {
        for (const server of [...servers]) await stopServer(server)
        return await startLoaded()
      } catch (cause) {
        safeLog('MCP old token listener could not be stopped', cause)
        return publish('error', cause)
      }
    })
  }

  function close() {
    return serialize(async () => {
      let closeError
      for (const server of [...servers]) {
        try {
          await stopServer(server)
        } catch (cause) {
          closeError = cause
          safeLog('MCP service shutdown failed', cause)
        }
      }
      return publish(closeError ? 'error' : 'disabled', closeError)
    })
  }

  function connectionCredentials() {
    if (!loaded || !settings.token) throw new Error('MCP 配置尚未就绪，请先初始化或显式重新生成令牌。')
    return {
      token: settings.token, url: connectionUrl(settings.port),
      enabled: settings.enabled, port: settings.port,
    }
  }

  return { info, configure, regenerateToken, start, close, connectionCredentials }
}
