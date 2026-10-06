#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Server } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { MCP_CLIENT_ID_HEADER } from '../electron/mcp-connections.mjs'

export function defaultMcpSettingsPath(env = process.env) {
  if (typeof env.QY_MCP_SETTINGS === 'string' && env.QY_MCP_SETTINGS.trim()) return path.resolve(env.QY_MCP_SETTINGS)
  const appData = env.APPDATA || path.join(env.HOME || os.homedir(), '.config')
  return path.join(appData, 'novel-generator', 'mcp-settings.json')
}

export function parseMcpArguments(args) {
  if (args.length === 0) return { settingsPath: defaultMcpSettingsPath() }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true }
  if (args.length === 2 && args[0] === '--settings' && args[1].trim()) return { settingsPath: path.resolve(args[1]) }
  throw new Error('用法：node scripts/qy-mcp.mjs [--settings 本机MCP配置文件]')
}

export async function readMcpConnection(settingsPath) {
  let configuration
  try {
    const metadata = await stat(settingsPath)
    if (!metadata.isFile() || metadata.size > 65536) throw new Error()
    configuration = JSON.parse(await readFile(settingsPath, 'utf8'))
  } catch {
    throw new Error('无法读取叙事工坊 MCP 配置，请先启动桌面端并启用“设置 → MCP 连接”。')
  }
  if (configuration?.enabled !== true) throw new Error('叙事工坊 MCP 未启用，请在桌面设置中开启。')
  if (configuration.version !== 1 || !Number.isInteger(configuration.port)
    || configuration.port < 1024 || configuration.port > 65535
    || typeof configuration.token !== 'string' || !/^[A-Za-z0-9_-]{43,512}$/.test(configuration.token)) {
    throw new Error('MCP 配置无效，请在桌面设置中重新保存或生成令牌。')
  }
  // Construct the endpoint instead of trusting a URL in a credential file.
  return {
    url: `http://127.0.0.1:${configuration.port}/mcp`,
    token: configuration.token,
  }
}

/**
 * A protocol adapter only. Every tool still executes in the desktop broker;
 * this process neither opens a .qy nor launches another writing Agent.
 */
export function createMcpStdioBridge({
  settingsPath = defaultMcpSettingsPath(),
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  connectTimeoutMs = 10000,
  heartbeatIntervalMs = 20000,
} = {}) {
  let upstream
  let upstreamConfiguration
  let connecting
  let connectionKey = ''
  let queue = Promise.resolve()
  let closed = false
  let heartbeat
  let heartbeatBusy = false
  const clientId = randomUUID()

  async function revoke(configuration) {
    if (!configuration) return
    try {
      await fetch(configuration.url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${configuration.token}`, [MCP_CLIENT_ID_HEADER]: clientId },
        signal: AbortSignal.timeout(500),
      })
    } catch {
      // Desktop shutdown/token replacement also clears the lease. An offline
      // listener must never hold the parent's stdio process open on exit.
    }
  }

  function startHeartbeat() {
    if (heartbeat || heartbeatIntervalMs <= 0 || closed) return
    heartbeat = setInterval(() => {
      if (heartbeatBusy || closed) return
      heartbeatBusy = true
      void getUpstream().then((client) => client.ping({
        timeout: Math.min(connectTimeoutMs, 10000), cacheMode: 'bypass',
      })).catch(() => {}).finally(() => { heartbeatBusy = false })
    }, heartbeatIntervalMs)
    heartbeat.unref?.()
  }

  function report() {
    // A transport error can contain request headers. Emit a fixed diagnostic.
    try { stderr.write('叙事工坊 MCP 连接异常；请检查桌面端的 MCP 服务状态。\n') } catch { /* parent pipe closed */ }
  }

  function getUpstream() {
    const run = queue.catch(() => {}).then(async () => {
      if (closed) throw new Error('MCP 接入进程已关闭。')
      const configuration = await readMcpConnection(settingsPath)
      const key = `${configuration.url}|${configuration.token}`
      if (upstream && connectionKey === key) return upstream
      const previous = upstream
      const previousConfiguration = upstreamConfiguration
      upstream = undefined
      upstreamConfiguration = undefined
      connectionKey = ''
      await previous?.close().catch(() => {})
      await revoke(previousConfiguration)
      if (closed) throw new Error('MCP 接入进程已关闭。')
      // The modern 2026 wire era has no ping/session methods. Keep this
      // private HTTP hop in the SDK's supported legacy era for standard ping
      // heartbeats; the outward stdio server still supports either era.
      const client = new Client({ name: 'qy-desktop-stdio', version: '1.0.0' }, {
        versionNegotiation: { mode: 'legacy' },
      })
      const transport = new StreamableHTTPClientTransport(new URL(configuration.url), {
        requestInit: { headers: { Authorization: `Bearer ${configuration.token}`, [MCP_CLIENT_ID_HEADER]: clientId } },
      })
      const pendingConnection = { client, transport, configuration }
      connecting = pendingConnection
      client.onerror = () => { /* request handlers return sanitized errors */ }
      try {
        await client.connect(transport, { timeout: connectTimeoutMs })
        // Modern version discovery is a probe, not evidence of an active
        // client. A successful protocol ping establishes this adapter lease.
        await client.ping({ timeout: connectTimeoutMs, cacheMode: 'bypass' })
      } catch {
        await transport.close().catch(() => {})
        await client.close().catch(() => {})
        await revoke(configuration)
        throw new Error('无法连接叙事工坊桌面端；请保持软件打开，并检查 MCP 端口和服务状态。')
      } finally {
        if (connecting === pendingConnection) connecting = undefined
      }
      if (closed) {
        await client.close().catch(() => {})
        throw new Error('MCP 接入进程已关闭。')
      }
      upstream = client
      upstreamConfiguration = configuration
      connectionKey = key
      startHeartbeat()
      return client
    })
    queue = run.then(() => {}, () => {})
    return run
  }

  async function factory() {
    const connected = await getUpstream()
    const hasResources = Boolean(connected.getServerCapabilities()?.resources)
    const server = new Server({ name: 'qy-novel-generator', version: '1.0.0' }, {
      capabilities: { tools: {}, ...(hasResources ? { resources: {} } : {}) },
      instructions: [
        '你正在操作桌面端叙事工坊。先调用 qy_status 获取作品集、作品和章节 ID。',
        '资料读取是按需的；写入必须显式绑定目标 ID，提交计划后由作者在桌面端确认。',
        '可以调用 qy_run_agent 使用内置 Agent，或自行生成操作并调用 qy_submit_plan。',
        '任务异步执行，请用 qy_get_job 查询结果；取消、暂停和继续不会绕过确认和字段锁。',
      ].join('\n'),
    })
    const forward = (method, invoke) => server.setRequestHandler(method, async (request, context) => {
      try {
        const client = await getUpstream()
        const options = { signal: context.mcpReq.signal, timeout: 30000, cacheMode: 'bypass' }
        return await invoke(client, request.params, options)
      } catch (error) {
        // Do not mirror HTTP exceptions containing bearer credentials.
        const message = /^(叙事工坊|无法读取叙事工坊|MCP 配置|无法连接叙事工坊|MCP 接入)/.test(error?.message || '')
          ? error.message : '桌面 MCP 请求失败；请检查软件内的任务或 MCP 服务状态。'
        if (method === 'tools/call') return { isError: true, content: [{ type: 'text', text: message }] }
        throw new Error(message)
      }
    })
    forward('tools/list', (client, params, options) => client.listTools(params, options))
    forward('tools/call', (client, params, options) => client.callTool(params, options))
    if (hasResources) {
      forward('resources/list', (client, params, options) => client.listResources(params, options))
      forward('resources/templates/list', (client, params, options) => client.listResourceTemplates(params, options))
      forward('resources/read', (client, params, options) => client.readResource(params, options))
    }
    return server
  }

  const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: 2 * 1024 * 1024 })
  const handle = serveStdio(factory, { transport, onerror: report })
  const originalOnClose = transport.onclose
  transport.onclose = () => {
    originalOnClose?.()
    void close()
  }
  let closePromise
  function close() {
    closed = true
    clearInterval(heartbeat)
    heartbeat = undefined
    closePromise ??= Promise.resolve().then(async () => {
      // A version probe may not yet belong to Client.transport. Close the
      // provisional transport as well, so EOF never waits for its timeout.
      const pendingConnection = connecting
      await Promise.allSettled([
        pendingConnection?.transport.close(),
        pendingConnection?.client.close(),
        upstream?.close(),
      ])
      await Promise.allSettled([
        revoke(pendingConnection?.configuration),
        revoke(upstreamConfiguration),
      ])
      await handle.close().catch(() => {})
      await queue.catch(() => {})
      await upstream?.close().catch(() => {})
      upstream = undefined
      upstreamConfiguration = undefined
      connectionKey = ''
    })
    return closePromise
  }
  return { close }
}

async function main() {
  const options = parseMcpArguments(process.argv.slice(2))
  if (options.help) {
    // stdout is exclusively MCP protocol, including help/error invocations.
    process.stderr.write('叙事工坊 MCP stdio 接入\nnode scripts/qy-mcp.mjs [--settings 本机MCP配置文件]\n请先启动桌面端并启用 MCP。\n')
    return
  }
  // Fail fast without printing the configuration or token.
  await readMcpConnection(options.settingsPath)
  const bridge = createMcpStdioBridge(options)
  const stop = () => { void bridge.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
