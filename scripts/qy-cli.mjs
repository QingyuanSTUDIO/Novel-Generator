#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT_BYTES = 2 * 1024 * 1024
const HELP = `叙事工坊 CLI

请先启动桌面软件。CLI 通过本机任务服务操作当前打开的作品集，
复用桌面端的预览、字段锁、修改记录与统一保存，不直接修改 .qy。

用法：
  node scripts/qy-cli.mjs status
  node scripts/qy-cli.mjs inspect [--collection world] [--project ID]
  node scripts/qy-cli.mjs context --query "检索文字" [--project ID]
  node scripts/qy-cli.mjs providers
  node scripts/qy-cli.mjs schema [--collection world]
  node scripts/qy-cli.mjs agent run --prompt "任务要求" --portfolio ID --project ID
      [--chapter ID] [--api ID] [--mode writing|inspiration] [--request-id ID]
  node scripts/qy-cli.mjs plan submit --file "response.json" --portfolio ID --project ID
      [--chapter ID] [--request-id ID]
  node scripts/qy-cli.mjs agent run --current --prompt "任务要求" [--chapter ID]
  node scripts/qy-cli.mjs plan submit --current --file "response.json"
  node scripts/qy-cli.mjs jobs list
  node scripts/qy-cli.mjs jobs status|approve|pause|resume|cancel JOB_ID
  node scripts/qy-cli.mjs save --portfolio ID --project ID [--request-id ID]
  node scripts/qy-cli.mjs save --current [--request-id ID]
  node scripts/qy-cli.mjs help

全局选项：
  --json                 输出机器可读的 JSON，错误写入 stderr
  --endpoint FILE        本机连接文件；默认使用 QY_CLI_ENDPOINT 环境变量，
                        或 %APPDATA%/novel-generator/console-endpoint.json
  --timeout MS           本机请求超时，默认 20000 毫秒
  --current              写入前读取一次当前已保存作品的状态，并固定绑定目标；
                        不能同时使用 --portfolio 或 --project

写入使用 --portfolio/--project，或 --current 绑定本次提交的当前目标。
approve 会再次检查原作品目标与内容指纹；任务失败不会自动再次应用修改。
`

class CliError extends Error {
  constructor(message, code = 'INVALID_ARGUMENT') {
    super(message)
    this.code = code
  }
}

function parseArguments(args) {
  const positionals = []
  const options = {}
  const booleanFlags = new Set(['json', 'help', 'current'])
  const valueFlags = new Set(['endpoint', 'timeout', 'collection', 'query', 'prompt', 'portfolio', 'project', 'chapter', 'api', 'mode', 'file', 'request-id'])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '-h') { options.help = true; continue }
    if (!argument.startsWith('--')) {
      if (argument.startsWith('-')) throw new CliError(`未知选项：${argument}`)
      positionals.push(argument)
      continue
    }
    const equals = argument.indexOf('=')
    const key = argument.slice(2, equals >= 0 ? equals : undefined)
    if (Object.hasOwn(options, key)) throw new CliError(`选项重复：--${key}`)
    if (booleanFlags.has(key)) {
      if (equals >= 0) throw new CliError(`--${key} 不接受附加值`)
      options[key] = true
      continue
    }
    if (!valueFlags.has(key)) throw new CliError(`未知选项：--${key}`)
    const value = equals >= 0 ? argument.slice(equals + 1) : args[++index]
    if (typeof value !== 'string' || !value.trim() || (equals < 0 && value.startsWith('--'))) throw new CliError(`--${key} 需要填写值`)
    options[key] = value
  }
  return { positionals, options }
}

export function defaultEndpointPath(env = process.env) {
  if (typeof env.QY_CLI_ENDPOINT === 'string' && env.QY_CLI_ENDPOINT.trim()) return path.resolve(env.QY_CLI_ENDPOINT)
  const appData = env.APPDATA || path.join(env.HOME || os.homedir(), '.config')
  return path.join(appData, 'novel-generator', 'console-endpoint.json')
}

function requireTargets(options) {
  if (options.current && (options.portfolio || options.project)) {
    throw new CliError('--current 不能与 --portfolio 或 --project 同时使用')
  }
  if (!options.current && (!options.portfolio || !options.project)) {
    throw new CliError('写入任务必须同时指定 --portfolio 和 --project，或使用 --current 固定绑定当前已保存作品')
  }
  if (options.mode && !['writing', 'inspiration'].includes(options.mode)) throw new CliError('--mode 只支持 writing 或 inspiration')
  return {
    ...(!options.current ? { portfolioId: options.portfolio, projectId: options.project } : {}),
    ...(options.chapter ? { chapterId: options.chapter } : {}),
    ...(options.api ? { providerId: options.api } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options['request-id'] ? { requestId: options['request-id'] } : {}),
  }
}

function enforceFlags(options, allowed) {
  const permitted = new Set(['json', 'help', 'endpoint', 'timeout', ...allowed])
  for (const key of Object.keys(options)) {
    if (!permitted.has(key)) throw new CliError(`当前命令不支持 --${key}`)
  }
}

async function commandRequest(positionals, options, readFile) {
  const [command, subcommand, id, ...extra] = positionals
  if (extra.length) throw new CliError('命令包含多余参数')
  const reads = { status: 'status', inspect: 'workspace', context: 'context', providers: 'providers', schema: 'schema' }
  if (Object.hasOwn(reads, command)) {
    if (subcommand || id) throw new CliError('检查命令不接受位置参数，请使用 --collection 或 --query')
    const allowed = command === 'providers' ? [] : command === 'context' ? ['query', 'project'] : ['collection', 'project']
    enforceFlags(options, allowed)
    const params = new URLSearchParams({ kind: reads[command] })
    if (options.project) params.set('projectId', options.project)
    if (options.collection) params.set('collection', options.collection)
    if (options.query) params.set('query', options.query)
    return { method: 'GET', route: `/v1/inspect?${params}`, property: 'data' }
  }
  if (command === 'agent' && subcommand === 'run' && !id) {
    enforceFlags(options, ['prompt', 'portfolio', 'project', 'chapter', 'api', 'mode', 'request-id', 'current'])
    if (!options.prompt) throw new CliError('agent run 需要 --prompt')
    return { method: 'POST', route: '/v1/jobs', body: { kind: 'agent', ...requireTargets(options), prompt: options.prompt }, property: 'job' }
  }
  if (command === 'plan' && subcommand === 'submit' && !id) {
    enforceFlags(options, ['file', 'portfolio', 'project', 'chapter', 'api', 'mode', 'request-id', 'current'])
    const target = requireTargets(options)
    if (!options.file) throw new CliError('plan submit 需要 --file，文件内容应为 Agent 返回的 JSON 结构')
    let text
    try { text = await readFile(path.resolve(options.file), 'utf8') } catch {
      throw new CliError('无法读取计划 JSON 文件', 'PLAN_FILE_UNAVAILABLE')
    }
    if (Buffer.byteLength(text, 'utf8') > LIMIT_BYTES) throw new CliError('计划 JSON 文件超过 2 MiB 限制', 'PAYLOAD_TOO_LARGE')
    let response
    try { response = JSON.parse(text) } catch {
      throw new CliError('计划文件不是有效的 JSON', 'INVALID_PLAN_JSON')
    }
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new CliError('计划文件必须是 Agent 返回的 JSON 对象')
    return { method: 'POST', route: '/v1/jobs', body: { kind: 'plan', ...target, response }, property: 'job' }
  }
  if (command === 'save' && !subcommand && !id) {
    enforceFlags(options, ['portfolio', 'project', 'request-id', 'current'])
    return { method: 'POST', route: '/v1/jobs', body: { kind: 'save', ...requireTargets(options) }, property: 'job' }
  }
  if (command === 'jobs') {
    enforceFlags(options, [])
    if (subcommand === 'list' && !id) return { method: 'GET', route: '/v1/jobs', property: 'jobs' }
    if (['status', 'approve', 'pause', 'resume', 'cancel'].includes(subcommand) && id) {
      const route = `/v1/jobs/${encodeURIComponent(id)}`
      return subcommand === 'status'
        ? { method: 'GET', route, property: 'job' }
        : { method: 'POST', route: `${route}/${subcommand}`, body: {}, property: 'job' }
    }
  }
  throw new CliError('命令无效；运行 help 查看可用命令')
}

function endpointValue(value) {
  if (!value || value.version !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.token)
    || !Number.isInteger(value.pid) || value.pid < 1) {
    throw new CliError('本机连接文件无效；请重启桌面软件', 'INVALID_ENDPOINT')
  }
  return { port: value.port, token: value.token }
}

function safeMessage(value, token) {
  if (typeof value !== 'string') return '桌面服务返回了错误'
  return token ? value.replaceAll(token, '[已隐藏]') : value
}

function currentTarget(status) {
  if (!status || status.ready !== true) throw new CliError('当前作品尚未完成读取；请等待桌面编辑器就绪后再使用 --current', 'CURRENT_TARGET_UNAVAILABLE')
  if (typeof status.filePath !== 'string' || !status.filePath.trim()) {
    throw new CliError('当前作品集尚未保存为 .qy；请先在桌面端保存或打开文件', 'CURRENT_TARGET_UNAVAILABLE')
  }
  for (const key of ['portfolioId', 'projectId']) {
    if (typeof status[key] !== 'string' || !status[key].trim()) {
      throw new CliError('当前作品集或作品 ID 缺失；请先在桌面端选择作品', 'CURRENT_TARGET_UNAVAILABLE')
    }
  }
  return { portfolioId: status.portfolioId, projectId: status.projectId }
}

function publicOutput(value, hideProviderKey = false) {
  if (Array.isArray(value)) return value.map((item) => publicOutput(item, hideProviderKey))
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-_ ]/gu, '')
    if (['apikey', 'accesstoken', 'token', 'secret', 'password', 'authorization', 'credentials'].includes(normalized)
      || (hideProviderKey && normalized === 'key')) continue
    Object.defineProperty(output, key, { enumerable: true, writable: true, configurable: true, value: publicOutput(item, hideProviderKey) })
  }
  return output
}

/**
 * The injected I/O keeps tests fully local. The CLI never runs a model or
 * writes a .qy file; even save is a target-bound job sent to the desktop app.
 */
export async function runCli(args = process.argv.slice(2), {
  env = process.env,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  readFile = fs.readFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  let options = { json: args.includes('--json') }
  let token
  try {
    const parsed = parseArguments(args)
    options = parsed.options
    if (options.help || !parsed.positionals.length || parsed.positionals[0] === 'help') {
      stdout(options.json ? `${JSON.stringify({ help: HELP })}\n` : HELP)
      return 0
    }
    const request = await commandRequest(parsed.positionals, options, readFile)
    const duration = options.timeout === undefined ? 20_000 : Number(options.timeout)
    if (!Number.isInteger(duration) || duration < 100 || duration > 120_000) throw new CliError('--timeout 必须是 100 到 120000 之间的毫秒数')
    const endpointPath = options.endpoint ? path.resolve(options.endpoint) : defaultEndpointPath(env)
    let endpointText
    try { endpointText = await readFile(endpointPath, 'utf8') } catch {
      throw new CliError('找不到本机连接文件。请先启动叙事工坊桌面版，或设置 QY_CLI_ENDPOINT', 'DESKTOP_UNAVAILABLE')
    }
    if (Buffer.byteLength(endpointText, 'utf8') > 4096) throw new CliError('本机连接文件无效；请重启桌面软件', 'INVALID_ENDPOINT')
    let endpoint
    try { endpoint = endpointValue(JSON.parse(endpointText)) } catch (error) {
      if (error instanceof CliError) throw error
      throw new CliError('本机连接文件无效；请重启桌面软件', 'INVALID_ENDPOINT')
    }
    token = endpoint.token
    async function call(localRequest) {
      const body = localRequest.body === undefined ? undefined : JSON.stringify(localRequest.body)
      if (body && Buffer.byteLength(body, 'utf8') > LIMIT_BYTES) throw new CliError('请求内容超过 2 MiB 限制', 'PAYLOAD_TOO_LARGE')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), duration)
      timer.unref?.()
      let response
      let payload
      try {
        response = await fetchImpl(`http://127.0.0.1:${endpoint.port}${localRequest.route}`, {
          method: localRequest.method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body } : {}),
          signal: controller.signal,
          redirect: 'error',
        })
        const text = await response.text()
        try { payload = JSON.parse(text) } catch {
          throw new CliError('桌面服务没有返回有效的 JSON；请确认软件已经完成启动', 'INVALID_RESPONSE')
        }
      } catch (error) {
        if (error instanceof CliError) throw error
        if (controller.signal.aborted) {
          throw new CliError(localRequest.method === 'POST'
            ? '本机请求超时；任务可能已提交，请用 jobs list 或相同 request-id 确认'
            : '读取本机状态超时；请确认桌面编辑器已经就绪后重试', 'REQUEST_TIMEOUT')
        }
        throw new CliError('无法连接桌面任务服务；请确认桌面软件正在运行', 'DESKTOP_UNAVAILABLE')
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        const error = payload?.error
        throw new CliError(safeMessage(typeof error === 'string' ? error : error?.message, token), error?.code || `HTTP_${response.status}`)
      }
      if (!Object.hasOwn(payload ?? {}, localRequest.property)) throw new CliError('桌面服务返回了不完整的数据', 'INVALID_RESPONSE')
      return payload[localRequest.property]
    }
    if (options.current) {
      const status = await call({ method: 'GET', route: '/v1/inspect?kind=status', property: 'data' })
      // Bind once. A later desktop selection change is rejected by the
      // workspace executor instead of silently targeting a different work.
      request.body = { ...request.body, ...currentTarget(status) }
    }
    const result = await call(request)
    // JSON output also escapes control characters from untrusted model text.
    // Do not print HTTP headers, endpoint metadata or bearer credentials.
    stdout(`${safeMessage(JSON.stringify(publicOutput(result, parsed.positionals[0] === 'providers'), null, options.json ? undefined : 2), token)}\n`)
    return 0
  } catch (error) {
    const message = safeMessage(error instanceof Error ? error.message : 'CLI 执行失败', token)
    const candidateCode = error instanceof CliError ? error.code : 'CLI_ERROR'
    const code = typeof candidateCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidateCode) ? candidateCode : 'CLI_ERROR'
    stderr(options.json ? `${JSON.stringify({ error: { code, message } })}\n` : `错误：${message}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli()
}
