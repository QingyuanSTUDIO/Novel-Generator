import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { z } from 'zod/v4'
import {
  createMcpConnectionTracker, MCP_CLIENT_ID_HEADER, MCP_CONNECTION_LEASE_MS, validMcpClientId,
} from './mcp-connections.mjs'

export const MCP_DEFAULT_PORT = 43127
export const MCP_LIMITS = Object.freeze({ requestBytes: 2 * 1024 * 1024 })
export const MCP_TOOL_NAMES = Object.freeze([
  'qy_status', 'qy_read_resources', 'qy_get_schema', 'qy_search_context', 'qy_list_providers',
  'qy_run_agent', 'qy_submit_plan', 'qy_list_jobs', 'qy_get_job',
  'qy_pause_job', 'qy_resume_job', 'qy_cancel_job', 'qy_save_portfolio',
])

const resourceCollections = [
  'volumes', 'chapters', 'world', 'characters', 'items', 'skills', 'outline', 'style',
  'resourceGroups', 'contextBlocks', 'contextGroups', 'worldEngine', 'customModules', 'memes',
]
const sensitiveKeys = new Set([
  'apikey', 'apitoken', 'accesstoken', 'refreshtoken', 'token', 'mcptoken', 'bearertoken',
  'secret', 'clientsecret', 'password', 'authorization', 'credentials',
])
const omittedKeys = new Set([
  'characterimages', 'charactercoverimageid', 'imagedata', 'imagebase64', 'modeloptions',
])
const safeErrors = Object.freeze({
  INVALID_REQUEST: '参数或目标无效，请使用 qy_status 与 qy_get_schema 确认后重试。',
  PAYLOAD_TOO_LARGE: '请求内容超过 2 MiB 限制。',
  REQUEST_ID_CONFLICT: '请求 ID 已用于其他内容或目标，请使用新的 requestId。',
  QUEUE_FULL: '任务队列已满，请先处理已有任务。',
  JOB_NOT_FOUND: '没有找到这个任务。',
  NOT_FOUND: '没有找到这个任务。',
  INVALID_JOB_STATE: '任务当前状态不允许这项操作。',
  ALREADY_APPLIED: '修改已经应用，不能重复应用。',
  SERVICE_CLOSED: '桌面任务服务已经关闭。',
  SERVICE_UNAVAILABLE: '桌面任务服务当前不可用。',
  SERVICE_NOT_READY: '桌面任务服务尚未就绪。',
  DESKTOP_UNAVAILABLE: '桌面窗口当前不可用。',
  INTERNAL_ERROR: '工具执行失败，请检查桌面端任务记录。',
})

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function identifier(description) {
  return z.string().min(1).max(200).refine(
    (value) => Boolean(value.trim()) && !/[\x00-\x1f]/u.test(value),
    { message: '必须提供有效标识' },
  ).describe(description)
}

const targetFields = {
  portfolioId: identifier('明确的作品集 ID，使用 qy_status 获取；执行期间不会跟随桌面选择改变。'),
  projectId: identifier('作品集中的明确作品 ID，使用 qy_status 获取。'),
  chapterId: identifier('可选的明确章节 ID；涉及章节时应提供。').optional(),
  conversationId: identifier('可选的明确 Agent 对话 ID；提供后固定该对话。').optional(),
  providerId: identifier('可选的 API 预设 ID，使用 qy_list_providers 获取。').optional(),
  mode: z.enum(['writing', 'inspiration']).describe('writing 遵守文风规则；inspiration 用于讨论灵感。').optional(),
  requestId: identifier('可选的幂等请求 ID；仅对完全相同的目标和内容去重。').optional(),
}

/** Defense in depth: the desktop inspector already projects writing data safely. */
function projectOutput(value, token, providerQuery = false) {
  const secrets = new Set([token])
  const omitted = (key) => {
    const normalized = key.toLowerCase().replace(/[\s_-]/gu, '')
    return sensitiveKeys.has(normalized) || omittedKeys.has(normalized)
      || (providerQuery && normalized === 'key')
      || (!providerQuery && normalized === 'providers')
  }
  const gather = (item) => {
    if (Array.isArray(item)) item.forEach(gather)
    else if (plainObject(item)) {
      for (const [key, child] of Object.entries(item)) {
        const normalized = key.toLowerCase().replace(/[\s_-]/gu, '')
        if ((sensitiveKeys.has(normalized) || (providerQuery && normalized === 'key'))
          && typeof child === 'string' && child) secrets.add(child)
        else gather(child)
      }
    }
  }
  gather(value)
  const secretValues = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
  const redact = (text) => {
    if (/^data:image\//iu.test(text)) return '[图片已省略]'
    let result = text
    for (const secret of secretValues) result = result.split(secret).join('[已隐藏]')
    return result
  }
  const visit = (item) => {
    if (typeof item === 'string') return redact(item)
    if (Array.isArray(item)) return item.map(visit)
    if (plainObject(item)) {
      return Object.fromEntries(Object.entries(item).filter(([key]) => !omitted(key))
        .map(([key, child]) => [redact(key), visit(child)]))
    }
    return item
  }
  // Service methods return JSON snapshots; serialize here to detach their objects.
  return visit(JSON.parse(JSON.stringify(value ?? null)))
}

function toolResult(value, token, providerQuery = false) {
  const projected = projectOutput(value, token, providerQuery)
  return {
    content: [{ type: 'text', text: JSON.stringify(projected, null, 2) }],
    structuredContent: plainObject(projected) ? projected : { data: projected },
  }
}

function toolError(error) {
  const code = typeof error?.code === 'string' && Object.hasOwn(safeErrors, error.code) ? error.code : 'INTERNAL_ERROR'
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message: safeErrors[code] } }) }],
    structuredContent: { error: { code, message: safeErrors[code] } },
  }
}

function parsePlan(responseJSON) {
  let parsed
  try { parsed = JSON.parse(responseJSON) } catch {
    throw Object.assign(new Error('无效计划 JSON'), { code: 'INVALID_REQUEST' })
  }
  if (!plainObject(parsed)) throw Object.assign(new Error('计划必须为对象'), { code: 'INVALID_REQUEST' })
  return parsed
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    const cleanup = () => {
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('error', onError)
      request.removeListener('aborted', onAborted)
    }
    const fail = (code) => {
      cleanup()
      chunks.length = 0
      // Drain an oversized body without the async-iterator destroy/reset behavior.
      request.resume()
      reject(Object.assign(new Error(code), { code }))
    }
    const onData = (chunk) => {
      length += chunk.length
      if (length > MCP_LIMITS.requestBytes) return fail('PAYLOAD_TOO_LARGE')
      chunks.push(chunk)
    }
    const onError = () => fail('REQUEST_ABORTED')
    const onAborted = () => fail('REQUEST_ABORTED')
    const onEnd = () => {
      cleanup()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { fail('INVALID_JSON') }
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })
}

function serverFactory(service, token, log, onActivity = () => {}) {
  const server = new McpServer({
    name: 'qy-novel-generator',
    title: 'QY Novel Generator',
    version: '1.0.0',
  }, {
    instructions: '先读取 qy_status 和 qy_get_schema。写入任务必须固定 portfolioId/projectId，不能直接修改 .qy 文件。'
      + '提交 Agent 或计划后轮询 qy_get_job；awaiting_approval 需要作者在桌面端确认。本服务器不提供批准修改的工具。'
      + '使用 pause/resume/cancel 管理长任务；保存任务同样必须绑定明确目标。',
  })
  const register = (name, description, schema, handler, { readOnly = false, providerQuery = false } = {}) => {
    server.registerTool(name, {
      description,
      inputSchema: z.object(schema).strict(),
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly },
    }, async (args) => {
      try {
        const result = toolResult(await handler(args), token, providerQuery)
        onActivity()
        return result
      } catch (error) {
        log('MCP_TOOL_FAILED')
        // A valid tool request returning an application error still proves
        // client activity. Invalid protocol/tool arguments never reach here.
        onActivity()
        return toolError(error)
      }
    })
  }
  const optionalProject = { projectId: identifier('可选作品 ID；未提供时读取当前作品。').optional() }
  const jobFields = { jobId: identifier('由提交工具返回的任务 ID。') }
  register('qy_status', '读取桌面作品集、当前作品、就绪状态与任务服务状态；不返回凭据。', {},
    () => service.inspect({ kind: 'status' }), { readOnly: true })
  register('qy_read_resources', '读取创作资料。collection 可限定章节、卡片或自定义模块；不会返回 API 设置或角色图片。', {
    ...optionalProject,
    collection: z.enum(resourceCollections).describe('可选的创作资料分类。').optional(),
  }, (args) => service.inspect({ kind: 'workspace', ...args }), { readOnly: true })
  register('qy_get_schema', '获取 Agent 计划协议与各类资料结构、创建提示词。collection 可为 agent、world、characters 等，或自定义结构 ID。', {
    collection: identifier('可选的资源类型、agent 或自定义模块结构 ID。').optional(),
  }, (args) => service.inspect({ kind: 'schema', ...args }), { readOnly: true })
  register('qy_search_context', '按关键词智能检索当前作品上下文，返回命中的资料与编排内容；目标作品必须已在桌面打开。', {
    ...optionalProject,
    query: z.string().min(1).max(20_000).refine((value) => Boolean(value.trim()), '检索内容不能为空')
      .describe('用于智能检索的具体要求或关键词。'),
  }, (args) => service.inspect({ kind: 'context', ...args }), { readOnly: true })
  register('qy_list_providers', '获取可选 API 预设的安全摘要（ID、名称、模型和启用状态）；不返回 API Key。', {},
    () => service.inspect({ kind: 'providers' }), { readOnly: true, providerQuery: true })
  register('qy_run_agent', '将要求交给软件内 Agent，加入持久化任务队列。不会等待模型完成；修改按桌面端确认流程处理。', {
    ...targetFields,
    prompt: z.string().min(1).max(MCP_LIMITS.requestBytes)
      .refine((value) => Boolean(value.trim()), '任务要求不能为空').describe('Agent 的任务要求。'),
  }, (args) => service.submit({ kind: 'agent', ...args }))
  register('qy_submit_plan', '提交符合 qy_get_schema 协议的 AgentResponse JSON 计划，进入软件校验、预览与作者确认流程。', {
    ...targetFields,
    responseJSON: z.string().min(2).max(MCP_LIMITS.requestBytes)
      .describe('完整的 AgentResponse JSON 对象字符串，请先读取 qy_get_schema。'),
  }, ({ responseJSON, ...args }) => service.submit({ kind: 'plan', ...args, response: parsePlan(responseJSON) }))
  register('qy_list_jobs', '列出持久化任务及进度、待确认计划、状态与修改记录；不触发模型。', {},
    () => service.list(), { readOnly: true })
  register('qy_get_job', '读取一个任务的进度、结果和待确认计划；适合轮询长任务。', jobFields,
    ({ jobId }) => service.get(jobId), { readOnly: true })
  register('qy_pause_job', '暂停任务并停止该任务当前执行；已应用的修改保留。', jobFields,
    ({ jobId }) => service.pause(jobId))
  register('qy_resume_job', '恢复暂停或失败任务；已有修改只补保存，待确认计划继续等待作者确认。', jobFields,
    ({ jobId }) => service.resume(jobId))
  register('qy_cancel_job', '终止指定任务；已应用的内容不会自动撤销，撤销请使用桌面修改记录。', jobFields,
    ({ jobId }) => service.cancel(jobId))
  register('qy_save_portfolio', '保存指定当前作品集为 .qy；经过软件统一保存管线，不直接写文件。', {
    portfolioId: targetFields.portfolioId,
    projectId: targetFields.projectId,
    requestId: targetFields.requestId,
  }, (args) => service.submit({ kind: 'save', ...args }))

  for (const [name, uri, kind, description] of [
    ['qy-status', 'qy://status', 'status', '当前作品集、作品与桌面任务状态。'],
    ['qy-schemas', 'qy://schemas', 'schema', 'Agent 返回协议、资料字段及创建提示词。'],
    ['qy-providers', 'qy://providers', 'providers', '可选择的 API 预设安全摘要。'],
  ]) {
    server.registerResource(name, uri, { description, mimeType: 'application/json' }, async (resourceUri) => {
      let projected
      try { projected = projectOutput(await service.inspect({ kind }), token, kind === 'providers') } catch (error) {
        log('MCP_RESOURCE_FAILED')
        projected = toolError(error).structuredContent
      }
      onActivity()
      return { contents: [{ uri: resourceUri.href, mimeType: 'application/json', text: JSON.stringify(projected, null, 2) }] }
    })
  }
  return server
}

const observedMethods = new Set([
  'initialize', 'ping', 'tools/list', 'resources/list', 'resources/templates/list',
])

async function successfulBuiltinResponse(response, request) {
  if (!response.ok || !plainObject(request) || request.jsonrpc !== '2.0'
    || !observedMethods.has(request.method)
    || !['string', 'number'].includes(typeof request.id) || !response.body) return false
  const reader = response.clone().body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MCP_LIMITS.requestBytes) return false
      chunks.push(value)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const results = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/u).flatMap((event) => {
        const data = event.split(/\r?\n/u).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n')
        if (!data) return []
        try { return [JSON.parse(data)] } catch { return [] }
      })
      : [JSON.parse(text)]
    return results.some((value) => plainObject(value) && value.id === request.id
      && Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error'))
  } catch {
    return false
  } finally {
    // A clone may be a tee of an SSE body. Never wait for cancellation while
    // the original response has not yet been delivered to the Node adapter.
    void reader.cancel().catch(() => {})
  }
}

/**
 * An authenticated loopback MCP endpoint delegating to the desktop console.
 * The official SDK serves both current and legacy stateless MCP protocols.
 */
export function createMcpServer({
  service, token, port = MCP_DEFAULT_PORT, logger = () => {}, onConnectionsChanged = () => {},
  connectionTtlMs = MCP_CONNECTION_LEASE_MS, now = () => Date.now(),
} = {}) {
  if (!service || ['inspect', 'submit', 'list', 'get', 'pause', 'resume', 'cancel']
    .some((name) => typeof service[name] !== 'function')) throw new TypeError('MCP 需要完整的桌面任务服务')
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /[^\x21-\x7e]/u.test(token)) {
    throw new TypeError('MCP 访问令牌必须为至少 32 字符的安全令牌')
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('MCP 端口必须为 0 到 65535 的整数')
  const expectedToken = Buffer.from(token)
  const log = (code) => { try { logger(code) } catch { /* logging must not break serving */ } }
  let server
  let handler
  let address
  let starting
  let closing
  let errorCode
  const sockets = new Set()
  const requestActivities = new WeakMap()
  const connections = createMcpConnectionTracker({
    ttlMs: connectionTtlMs,
    now,
    onChange: (snapshot) => {
      try { onConnectionsChanged(snapshot) } catch { log('MCP_CONNECTION_NOTIFICATION_FAILED') }
    },
  })

  const authenticated = (authorization) => {
    if (typeof authorization !== 'string' || !/^Bearer /iu.test(authorization)) return false
    const supplied = Buffer.from(authorization.slice(7))
    return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken)
  }
  const reject = (response, statusCode, code) => {
    if (response.headersSent || response.destroyed) return
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(statusCode === 401 ? { 'www-authenticate': 'Bearer realm="qy-mcp"' } : {}),
    })
    response.end(JSON.stringify({ error: code }))
  }
  function status() {
    return {
      running: Boolean(server?.listening && address && !closing),
      host: '127.0.0.1',
      port: address?.port ?? port,
      url: address?.url ?? `http://127.0.0.1:${port}/mcp`,
      ...connections.snapshot(),
      ...(errorCode ? { error: errorCode } : {}),
    }
  }
  async function start() {
    if (closing) await closing
    if (address && server?.listening) return { ...address }
    if (starting) return starting
    starting = (async () => {
      errorCode = undefined
      handler = createMcpHandler((context) => serverFactory(
        service, token, log, requestActivities.get(context.requestInfo),
      ), {
        legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: MCP_LIMITS.requestBytes,
        onerror: () => log('MCP_PROTOCOL_FAILED'),
      })
      const nodeHandler = toNodeHandler({
        async fetch(request, options) {
          const explicitId = request.headers.get(MCP_CLIENT_ID_HEADER)
          // Plain HTTP without an explicit client ID is one activity group:
          // stateless requests do not contain a reliable session identity.
          const identity = explicitId ?? 'direct-http'
          const ticket = connections.ticket(identity)
          const activity = () => connections.touch(identity, ticket)
          requestActivities.set(request, activity)
          const response = await handler.fetch(request, options)
          if (await successfulBuiltinResponse(response, options?.parsedBody)) activity()
          return response
        },
      }, {
        maxRequestBodySize: MCP_LIMITS.requestBytes,
        onerror: () => log('MCP_TRANSPORT_FAILED'),
      })
      server = http.createServer((request, response) => {
        response.setHeader('cache-control', 'no-store')
        response.setHeader('x-content-type-options', 'nosniff')
        if (!authenticated(request.headers.authorization)) return reject(response, 401, 'UNAUTHORIZED')
        if (request.headers.origin !== undefined) return reject(response, 403, 'ORIGIN_FORBIDDEN')
        const hostCount = request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'host').length
        if (hostCount !== 1) return reject(response, 403, 'HOST_FORBIDDEN')
        const acceptedHosts = [`127.0.0.1:${address?.port}`, `localhost:${address?.port}`]
        if (!acceptedHosts.includes(request.headers.host)) return reject(response, 403, 'HOST_FORBIDDEN')
        if (request.url !== '/mcp') return reject(response, 404, 'NOT_FOUND')
        if (closing || !address) return reject(response, 503, 'SERVICE_UNAVAILABLE')
        const clientId = request.headers[MCP_CLIENT_ID_HEADER]
        if (clientId !== undefined && !validMcpClientId(clientId)) return reject(response, 400, 'INVALID_CLIENT_ID')
        if (request.method === 'DELETE' && clientId !== undefined) {
          connections.forget(clientId)
          response.writeHead(204)
          response.end()
          return
        }
        void (async () => {
          if (request.method === 'POST') {
            const mediaType = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
            if (mediaType !== 'application/json') {
              request.resume()
              return reject(response, 415, 'UNSUPPORTED_MEDIA_TYPE')
            }
            // Body parsing is HTTP plumbing only; the SDK owns all MCP validation.
            const parsedBody = await readBody(request)
            return nodeHandler(request, response, parsedBody)
          }
          return nodeHandler(request, response)
        })().catch((error) => {
          if (error?.code === 'PAYLOAD_TOO_LARGE') return reject(response, 413, 'PAYLOAD_TOO_LARGE')
          if (error?.code === 'INVALID_JSON') return reject(response, 400, 'INVALID_JSON')
          if (error?.code === 'REQUEST_ABORTED') return
          log('MCP_REQUEST_FAILED')
          reject(response, 500, 'INTERNAL_ERROR')
        })
      })
      server.requestTimeout = 30_000
      server.headersTimeout = 10_000
      server.maxHeadersCount = 64
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      try {
        await new Promise((resolve, fail) => {
          const onError = (error) => { server.removeListener('listening', onListen); fail(error) }
          const onListen = () => { server.removeListener('error', onError); resolve() }
          server.once('error', onError)
          server.once('listening', onListen)
          server.listen(port, '127.0.0.1')
        })
        const bound = server.address()
        address = { host: '127.0.0.1', port: bound.port, url: `http://127.0.0.1:${bound.port}/mcp` }
        server.on('error', () => { errorCode = 'MCP_SERVER_ERROR'; log(errorCode) })
        return { ...address }
      } catch (error) {
        errorCode = error?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'MCP_START_FAILED'
        log(errorCode)
        await handler.close().catch(() => {})
        handler = undefined
        server = undefined
        address = undefined
        connections.clear()
        throw Object.assign(new Error(errorCode === 'PORT_IN_USE' ? 'MCP 端口已被占用' : 'MCP 服务启动失败'), { code: errorCode })
      } finally {
        starting = undefined
      }
    })()
    return starting
  }
  async function close() {
    if (closing) return closing
    closing = (async () => {
      if (starting) await starting.catch(() => {})
      const currentServer = server
      const currentHandler = handler
      address = undefined
      connections.clear()
      const shutdown = currentServer?.listening
        ? new Promise((resolve) => currentServer.close(resolve)) : Promise.resolve()
      for (const socket of sockets) socket.destroy()
      await Promise.all([shutdown, currentHandler?.close().catch(() => log('MCP_CLOSE_FAILED'))])
      server = undefined
      handler = undefined
      sockets.clear()
    })()
    try { await closing } finally { closing = undefined }
  }
  return { start, close, status }
}
