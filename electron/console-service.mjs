import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const CONSOLE_LIMITS = Object.freeze({
  jobs: 200,
  events: 200,
  requestBytes: 2 * 1024 * 1024,
  eventDetail: 16_384,
})

const jobKinds = new Set(['agent', 'plan', 'save'])
const modes = new Set(['writing', 'inspiration'])
const statuses = new Set(['queued', 'running', 'awaiting_approval', 'saving', 'completed', 'failed', 'paused', 'canceled'])
const resultStatuses = new Set(['awaiting_approval', 'completed', 'failed'])
const eventStates = new Set(['queued', 'running', 'done', 'error'])
const inspectKinds = new Set(['status', 'workspace', 'context', 'providers', 'schema'])
const terminalStatuses = new Set(['completed', 'failed', 'canceled'])
const MAX_STORAGE_BYTES = 512 * 1024 * 1024

export class ConsoleServiceError extends Error {
  constructor(message, code = 'INVALID_REQUEST', statusCode = 400) {
    super(message)
    this.name = 'ConsoleServiceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function jsonValue(value, limit = CONSOLE_LIMITS.requestBytes) {
  let text
  try { text = JSON.stringify(value) } catch {
    throw new ConsoleServiceError('内容必须是可序列化的 JSON')
  }
  if (typeof text !== 'string') throw new ConsoleServiceError('内容必须是有效的 JSON')
  if (Buffer.byteLength(text, 'utf8') > limit) throw new ConsoleServiceError('请求内容超过 2 MiB 限制', 'PAYLOAD_TOO_LARGE', 413)
  return JSON.parse(text)
}

function identifier(value, label, required = false) {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/u.test(value)) {
    throw new ConsoleServiceError(`${label}必须是明确的有效标识`)
  }
  return value.trim()
}

function normalizeSubmission(value) {
  if (!plainObject(value) || !jobKinds.has(value.kind)) throw new ConsoleServiceError('任务类型必须是 agent、plan 或 save')
  const portfolioId = identifier(value.portfolioId, '作品集 ID', true)
  const projectId = identifier(value.projectId, '作品 ID', true)
  const chapterId = identifier(value.chapterId, '章节 ID')
  const conversationId = identifier(value.conversationId, '对话 ID')
  const providerId = identifier(value.providerId, 'API 预设 ID')
  const requestId = identifier(value.requestId, '请求 ID')
  const mode = value.mode ?? 'writing'
  if (!modes.has(mode)) throw new ConsoleServiceError('模式必须是 writing 或 inspiration')
  if (value.prompt !== undefined && typeof value.prompt !== 'string') throw new ConsoleServiceError('任务要求必须是文字')
  const prompt = (value.prompt ?? '').trim()
  if (value.kind === 'agent' && !prompt) throw new ConsoleServiceError('Agent 任务需要填写要求')
  if (value.kind === 'plan' && !plainObject(value.response)) throw new ConsoleServiceError('提交计划需要 JSON 格式的 Agent 返回结构')
  const normalized = {
    kind: value.kind,
    target: {
      portfolioId, projectId,
      ...(chapterId ? { chapterId } : {}),
      ...(conversationId ? { conversationId } : {}),
    },
    prompt,
    ...(providerId ? { providerId } : {}),
    mode,
    ...(value.kind === 'plan' ? { response: jsonValue(value.response) } : {}),
    ...(requestId ? { requestId } : {}),
  }
  return jsonValue(normalized)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function submissionOf(job) {
  return {
    kind: job.kind,
    target: job.target,
    prompt: job.prompt,
    ...(job.providerId ? { providerId: job.providerId } : {}),
    mode: job.mode,
    ...(job.response ? { response: job.response } : {}),
    ...(job.requestId ? { requestId: job.requestId } : {}),
  }
}

function canPrune(job) {
  return terminalStatuses.has(job.status) && !(job.status === 'failed' && job.result?.applied)
}

function publicJob(job) {
  const copy = clone(job)
  delete copy.pendingAction
  return copy
}

function addEvent(job, event, now = Date.now()) {
  const title = typeof event?.title === 'string' && event.title.trim() ? event.title.trim().slice(0, 512) : '任务状态更新'
  const detail = typeof event?.detail === 'string' ? event.detail.slice(0, CONSOLE_LIMITS.eventDetail) : undefined
  const state = eventStates.has(event?.state) ? event.state : 'running'
  const sequence = (job.events.at(-1)?.sequence ?? 0) + 1
  job.events.push({ sequence, createdAt: now, title, ...(detail ? { detail } : {}), state })
  job.events = job.events.slice(-CONSOLE_LIMITS.events)
  job.updatedAt = now
}

function resultValue(value) {
  if (!plainObject(value) || !resultStatuses.has(value.status)) throw new Error('任务执行器返回了无效的状态')
  const result = jsonValue(value)
  for (const key of ['message', 'error', 'afterFingerprint']) {
    if (result[key] !== undefined && typeof result[key] !== 'string') throw new Error(`任务执行器返回了无效的 ${key}`)
  }
  if (result.applied !== undefined && typeof result.applied !== 'boolean') throw new Error('任务执行器返回了无效的应用断点')
  if (result.plan !== undefined && !plainObject(result.plan)) throw new Error('任务执行器返回了无效的修改计划')
  if (result.changes !== undefined && (!Array.isArray(result.changes) || result.changes.some((item) => typeof item !== 'string'))) {
    throw new Error('任务执行器返回了无效的修改记录')
  }
  return result
}

function mergeResult(previous, next) {
  const result = { ...previous, ...next }
  // Once a mutation has been checkpointed, a later transport error or an
  // incomplete executor response must never turn it back into an unapplied run.
  if (previous?.applied) {
    result.applied = true
    result.afterFingerprint = previous.afterFingerprint
  }
  return result
}

function inspectQuery(value) {
  if (!plainObject(value) || !inspectKinds.has(value.kind)) throw new ConsoleServiceError('不支持的检查类型')
  const query = { kind: value.kind }
  for (const key of ['projectId', 'collection']) {
    const normalized = identifier(value[key], key)
    if (normalized) query[key] = normalized
  }
  if (value.query !== undefined) {
    if (typeof value.query !== 'string' || value.query.length > 20_000) throw new ConsoleServiceError('检索文字过长或无效')
    query.query = value.query
  }
  return query
}

function redact(value, providerQuery = false) {
  if (Array.isArray(value)) return value.map((item) => redact(item, providerQuery))
  if (!plainObject(value)) return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-_ ]/gu, '')
    if (['apikey', 'accesstoken', 'token', 'secret', 'password', 'authorization', 'credentials'].includes(normalized)
      || (providerQuery && normalized === 'key')) continue
    Object.defineProperty(result, key, { enumerable: true, writable: true, configurable: true, value: redact(item, providerQuery) })
  }
  return result
}

function errorMessage(error) {
  return error instanceof Error ? error.message : '任务执行失败'
}

async function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, filePath)
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

function validateSavedJobs(document) {
  if (!plainObject(document) || document.version !== 1 || !Array.isArray(document.jobs) || document.jobs.length > CONSOLE_LIMITS.jobs) {
    throw new Error('任务记录格式无效；原文件已保留')
  }
  const ids = new Set()
  const requests = new Set()
  for (const job of document.jobs) {
    if (!plainObject(job) || typeof job.id !== 'string' || ids.has(job.id)
      || !jobKinds.has(job.kind) || !modes.has(job.mode) || !statuses.has(job.status)
      || !plainObject(job.target) || typeof job.target.portfolioId !== 'string' || !job.target.portfolioId
      || typeof job.target.projectId !== 'string' || !job.target.projectId
      || typeof job.prompt !== 'string' || !Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt)
      || !Array.isArray(job.events) || job.events.length > CONSOLE_LIMITS.events) {
      throw new Error('任务记录内容损坏；原文件已保留')
    }
    ids.add(job.id)
    if (job.target.conversationId !== undefined) {
      try {
        if (identifier(job.target.conversationId, '任务对话 ID') !== job.target.conversationId) throw new Error('标识尚未规范化')
      } catch {
        throw new Error('任务对话标识损坏；原文件已保留')
      }
    }
    if (job.requestId) {
      if (typeof job.requestId !== 'string' || requests.has(job.requestId)) throw new Error('任务请求标识损坏；原文件已保留')
      requests.add(job.requestId)
    }
    let sequence = 0
    for (const event of job.events) {
      if (!plainObject(event) || !Number.isInteger(event.sequence) || event.sequence <= sequence
        || !Number.isFinite(event.createdAt) || typeof event.title !== 'string' || !eventStates.has(event.state)) {
        throw new Error('任务事件记录损坏；原文件已保留')
      }
      sequence = event.sequence
    }
    if (job.result !== undefined) resultValue(job.result)
    if (job.pendingAction !== undefined && !['run', 'approve'].includes(job.pendingAction)) throw new Error('任务执行记录损坏；原文件已保留')
    if (job.kind === 'plan' && !plainObject(job.response)) throw new Error('任务计划记录损坏；原文件已保留')
  }
  return document.jobs
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const pieces = []
    let failed = false
    request.on('data', (piece) => {
      if (failed) return
      bytes += piece.length
      if (bytes > CONSOLE_LIMITS.requestBytes) {
        failed = true
        // Discard the rest of an oversized body without retaining it. An
        // immediate socket destroy would hide the 413 response behind an
        // ECONNRESET error in clients still uploading their request.
        request.resume()
        reject(new ConsoleServiceError('请求内容超过 2 MiB 限制', 'PAYLOAD_TOO_LARGE', 413))
        return
      }
      pieces.push(piece)
    })
    request.on('error', reject)
    request.on('aborted', () => reject(new ConsoleServiceError('请求已中断', 'REQUEST_ABORTED', 400)))
    request.on('end', () => {
      if (failed) return
      const text = Buffer.concat(pieces).toString('utf8')
      if (!text.trim()) return resolve({})
      try { resolve(JSON.parse(text)) } catch {
        reject(new ConsoleServiceError('请求不是有效的 JSON'))
      }
    })
  })
}

function timeout(promise, duration) {
  let timer
  const expiration = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ConsoleServiceError('桌面服务处理请求超时', 'REQUEST_TIMEOUT', 504)), duration)
    timer.unref?.()
  })
  return Promise.race([promise, expiration]).finally(() => clearTimeout(timer))
}

/**
 * Local task broker. Only execute() can change the open workspace: this module
 * never opens or writes a .qy document. Every accepted mutation is durable
 * before the caller receives its acknowledgement.
 */
export function createConsoleService({
  storagePath,
  endpointPath,
  execute,
  inspect: inspectExecutor,
  logger = () => {},
} = {}) {
  if (!storagePath || !endpointPath || typeof execute !== 'function' || typeof inspectExecutor !== 'function') {
    throw new TypeError('storagePath、endpointPath、execute 和 inspect 必须提供')
  }
  storagePath = path.resolve(storagePath)
  endpointPath = path.resolve(endpointPath)
  if (storagePath === endpointPath) throw new TypeError('任务记录和连接文件不能使用同一个路径')
  if ([storagePath, endpointPath].some((value) => path.extname(value).toLowerCase() === '.qy')) throw new TypeError('控制台不能将 .qy 作为任务或连接文件')
  const suppliedLogger = logger
  logger = (...args) => {
    try { suppliedLogger(...args) } catch { /* diagnostics must not turn an acknowledged disk write into an error */ }
  }

  let jobs = []
  let server
  let token
  let endpoint
  let started = false
  let starting
  let closed = false
  let closing = false
  let suspended = false
  let dispatching = false
  let scheduled = false
  let activeLease
  let activeTask
  let dispatchTask
  const cancellationTasks = new Set()
  let mutationTail = Promise.resolve()
  let closePromise
  const subscribers = new Set()

  function notify() {
    const snapshot = list()
    for (const subscriber of subscribers) {
      try { subscriber(snapshot) } catch (error) { logger('Console job subscriber failed', error) }
    }
  }

  function ensureAvailable(allowWhileClosing = false) {
    if (!started || closed || (closing && !allowWhileClosing)) throw new ConsoleServiceError('桌面任务服务尚未启动或已经关闭', 'SERVICE_UNAVAILABLE', 503)
  }

  function enqueueMutation(operation, internal = false) {
    const work = mutationTail.catch(() => {}).then(async () => {
      if (closed || (closing && !internal)) throw new ConsoleServiceError('桌面任务服务已经关闭', 'SERVICE_UNAVAILABLE', 503)
      const next = clone(jobs)
      const response = await operation(next)
      if (response?.unchanged) return response.value
      await atomicWrite(storagePath, { version: 1, kind: 'console-jobs', jobs: next })
      jobs = next
      notify()
      return response?.value
    })
    mutationTail = work.catch(() => {})
    return work
  }

  function requiredJob(next, id) {
    const job = next.find((item) => item.id === id)
    if (!job) throw new ConsoleServiceError('任务不存在或已超过历史保留上限', 'JOB_NOT_FOUND', 404)
    return job
  }

  function schedule() {
    if (!started || closed || closing || suspended || scheduled || activeLease || dispatching) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const task = dispatch().catch((error) => logger('Unable to dispatch console job', error))
      dispatchTask = task
      void task.finally(() => {
        if (dispatchTask === task) dispatchTask = undefined
      })
    })
  }

  async function finish(lease, output, failure) {
    await enqueueMutation((next) => {
      const job = requiredJob(next, lease.id)
      if (activeLease !== lease || lease.canceled || !['running', 'saving'].includes(job.status)) return { unchanged: true }
      const result = failure
        ? { status: 'failed', error: errorMessage(failure) }
        : resultValue(output)
      job.result = mergeResult(job.result, result)
      job.status = result.status
      if (result.status === 'failed') job.error = result.error || result.message || '任务执行失败'
      else delete job.error
      const titles = { awaiting_approval: '修改计划已生成，等待确认', completed: '任务已完成', failed: '任务执行失败' }
      addEvent(job, { title: titles[job.status], detail: result.message || job.error, state: job.status === 'failed' ? 'error' : 'done' })
    }, true)
  }

  async function perform(lease, action, job) {
    try {
      const output = await execute({ action, job })
      await finish(lease, output)
    } catch (error) {
      if (!closed) {
        try { await finish(lease, undefined, error) } catch (writeError) {
          logger('Unable to persist console execution failure', writeError)
        }
      }
    } finally {
      if (activeLease === lease) {
        activeLease = undefined
        activeTask = undefined
      }
      schedule()
    }
  }

  async function dispatch() {
    if (dispatching || activeLease || suspended || closing || closed) return
    dispatching = true
    let chosen
    let reservationCanceled = false
    try {
      await enqueueMutation((next) => {
        if (activeLease || suspended || closing) return { unchanged: true }
        const approval = next.find((item) => item.status === 'queued' && item.pendingAction === 'approve')
        if (!approval && next.some((job) => job.status === 'awaiting_approval')) return { unchanged: true }
        const job = approval || next.find((item) => item.status === 'queued')
        if (!job) return { unchanged: true }
        const action = job.pendingAction || 'run'
        delete job.pendingAction
        job.status = 'running'
        addEvent(job, { title: action === 'approve' ? '正在确认并应用修改' : job.kind === 'save' ? '正在保存作品集' : '任务开始执行', state: 'running' })
        chosen = { action, job: publicJob(job), lease: { id: job.id, canceled: false } }
      })
      if (chosen && !closing && !closed) {
        activeLease = chosen.lease
        // notify() may cause a pause/cancel to be queued while the running
        // state is committed. Let that control finish, then validate the
        // reservation before starting a model request.
        await mutationTail
        const current = jobs.find((job) => job.id === chosen.job.id)
        if (!chosen.lease.canceled && !closing && !closed && !suspended && current?.status === 'running') {
          activeTask = perform(chosen.lease, chosen.action, publicJob(current))
        } else if (activeLease === chosen.lease) {
          activeLease = undefined
          reservationCanceled = true
        }
      }
    } finally {
      dispatching = false
      if (reservationCanceled) schedule()
    }
  }

  function cancelExecution(id) {
    const lease = activeLease
    if (!lease || lease.id !== id || lease.canceled) return Promise.resolve()
    lease.canceled = true
    const job = jobs.find((item) => item.id === id)
    if (!job) return Promise.resolve()
    // Keep the serial execution slot until the original promise settles.
    // A cancel acknowledgement alone cannot prove that a late model response
    // has stopped running in the renderer.
    const task = Promise.resolve().then(() => execute({ action: 'cancel', job: publicJob(job) })).catch((error) => {
      logger('Unable to cancel console execution', error)
    })
    cancellationTasks.add(task)
    void task.finally(() => cancellationTasks.delete(task))
    return task
  }

  async function submit(input) {
    ensureAvailable()
    const normalized = normalizeSubmission(input)
    const result = await enqueueMutation((next) => {
      if (normalized.requestId) {
        const existing = next.find((job) => job.requestId === normalized.requestId)
        if (existing) {
          if (canonical(submissionOf(existing)) !== canonical(normalized)) {
            throw new ConsoleServiceError('同一请求 ID 已用于另一项任务', 'REQUEST_ID_CONFLICT', 409)
          }
          return { unchanged: true, value: publicJob(existing) }
        }
      }
      while (next.length >= CONSOLE_LIMITS.jobs) {
        const index = next.findIndex(canPrune)
        if (index < 0) throw new ConsoleServiceError('任务队列已满，请先处理或取消现有任务', 'QUEUE_FULL', 409)
        next.splice(index, 1)
      }
      const now = Date.now()
      const job = { id: randomUUID(), ...normalized, status: 'queued', createdAt: now, updatedAt: now, events: [] }
      addEvent(job, { title: '任务已加入队列', state: 'queued' }, now)
      next.push(job)
      return { value: publicJob(job) }
    })
    // A canceled close/reload can leave the desktop open after suspend().
    // A new, explicit submission re-enables scheduling, while the old jobs
    // remain paused and still require their own resume command.
    if (!closing && !closed) suspended = false
    schedule()
    return result
  }

  function list() {
    return jobs.map(publicJob)
  }

  function get(id) {
    identifier(id, '任务 ID', true)
    return publicJob(requiredJob(jobs, id))
  }

  async function approve(id) {
    ensureAvailable()
    const result = await enqueueMutation((next) => {
      const job = requiredJob(next, id)
      if (job.status !== 'awaiting_approval') throw new ConsoleServiceError('只有等待确认的任务可以批准', 'INVALID_JOB_STATE', 409)
      if (job.result?.applied) throw new ConsoleServiceError('修改已经应用，不能再次批准', 'ALREADY_APPLIED', 409)
      job.status = 'queued'
      job.pendingAction = 'approve'
      addEvent(job, { title: '已确认修改，等待执行', state: 'queued' })
      return { value: publicJob(job) }
    })
    if (!closing && !closed) suspended = false
    schedule()
    return result
  }

  async function pause(id) {
    ensureAvailable()
    const result = await enqueueMutation((next) => {
      const job = requiredJob(next, id)
      if (job.status === 'paused') return { unchanged: true, value: publicJob(job) }
      if (terminalStatuses.has(job.status)) throw new ConsoleServiceError('已结束的任务不能暂停', 'INVALID_JOB_STATE', 409)
      job.status = 'paused'
      delete job.pendingAction
      addEvent(job, { title: '任务已暂停', state: 'done' })
      return { value: publicJob(job) }
    })
    cancelExecution(id)
    schedule()
    return result
  }

  async function resume(id) {
    ensureAvailable()
    const result = await enqueueMutation((next) => {
      const job = requiredJob(next, id)
      if (!['paused', 'failed'].includes(job.status)) throw new ConsoleServiceError('只有暂停或失败的任务可以继续', 'INVALID_JOB_STATE', 409)
      delete job.error
      if (!job.result?.applied && (job.result?.plan || job.result?.status === 'awaiting_approval')) {
        job.status = 'awaiting_approval'
        delete job.pendingAction
        addEvent(job, { title: '已恢复原修改计划，等待确认', state: 'done' })
      } else {
        job.status = 'queued'
        job.pendingAction = 'run'
        addEvent(job, { title: job.result?.applied ? '已恢复保存断点，等待保存' : '任务已恢复，等待执行', state: 'queued' })
      }
      return { value: publicJob(job) }
    })
    suspended = false
    schedule()
    return result
  }

  async function cancel(id) {
    ensureAvailable()
    const result = await enqueueMutation((next) => {
      const job = requiredJob(next, id)
      if (job.status === 'canceled') return { unchanged: true, value: publicJob(job) }
      if (job.status === 'completed') throw new ConsoleServiceError('任务已经完成；撤销修改请使用修改记录', 'INVALID_JOB_STATE', 409)
      job.status = 'canceled'
      delete job.pendingAction
      addEvent(job, { title: job.result?.applied ? '任务已终止；已应用的内容不会自动撤销' : '任务已终止', state: 'done' })
      return { value: publicJob(job) }
    })
    cancelExecution(id)
    schedule()
    return result
  }

  async function report(id, event) {
    ensureAvailable(true)
    return enqueueMutation((next) => {
      const job = requiredJob(next, id)
      if (!['running', 'saving'].includes(job.status) || (activeLease?.id === id && activeLease.canceled)) {
        return { unchanged: true, value: publicJob(job) }
      }
      addEvent(job, event)
      return { value: publicJob(job) }
    }, true)
  }

  async function checkpoint(id, value) {
    ensureAvailable(true)
    const data = jsonValue(value)
    if (!plainObject(data) || data.applied !== true || typeof data.afterFingerprint !== 'string' || !data.afterFingerprint) {
      throw new ConsoleServiceError('保存断点必须包含已应用状态和内容指纹')
    }
    const fields = resultValue({ status: 'completed', ...data })
    return enqueueMutation((next) => {
      const job = requiredJob(next, id)
      if (!activeLease || activeLease.id !== id || !['running', 'saving', 'paused', 'canceled'].includes(job.status)) {
        throw new ConsoleServiceError('此任务没有正在执行的修改', 'INVALID_JOB_STATE', 409)
      }
      job.result = mergeResult(job.result, fields)
      if (job.status !== 'paused' && job.status !== 'canceled') job.status = 'saving'
      addEvent(job, { title: '修改已应用，保存断点已写入', detail: '后续恢复只保存已应用的内容，不会重复执行修改。', state: 'running' })
      return { value: publicJob(job) }
    }, true)
  }

  async function inspect(input) {
    ensureAvailable()
    const query = inspectQuery(input)
    const data = redact(await inspectExecutor(query), query.kind === 'providers')
    if (query.kind !== 'status' || !plainObject(data)) return data
    return {
      ...data,
      console: {
        suspended,
        activeJobId: activeLease?.id ?? null,
        jobs: jobs.length,
        awaitingApproval: jobs.filter((job) => job.status === 'awaiting_approval').length,
      },
    }
  }

  async function suspend() {
    if (!started || closed) return list()
    suspended = true
    await enqueueMutation((next) => {
      let changed = false
      for (const job of next) {
        if (!['queued', 'running', 'saving', 'awaiting_approval'].includes(job.status)) continue
        job.status = 'paused'
        delete job.pendingAction
        addEvent(job, { title: '应用退出，任务已暂停并保留检查点', state: 'done' })
        changed = true
      }
      return changed ? {} : { unchanged: true }
    }, true)
    if (activeLease) await cancelExecution(activeLease.id)
    return list()
  }

  async function waitForIdle({ timeoutMs = 30_000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须大于零')
    await timeout((async () => {
      // Both the original execution and its cancellation must settle. A
      // cancellation acknowledgement cannot substitute for the save stage
      // already in progress.
      while (activeTask || dispatchTask || cancellationTasks.size) {
        await Promise.allSettled([activeTask, dispatchTask, ...cancellationTasks].filter(Boolean))
      }
      await mutationTail
    })(), timeoutMs)
  }

  function authorized(request) {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
    const candidate = Buffer.from(authorization.slice(7), 'utf8')
    const expected = Buffer.from(token, 'utf8')
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  }

  async function route(request, response) {
    const send = (statusCode, data) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(`${JSON.stringify(data)}\n`)
    }
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
        throw new ConsoleServiceError('只接受本机连接', 'FORBIDDEN', 403)
      }
      // The token is intended for the CLI, never a web page. Browser origins
      // are rejected even if a page somehow obtains an Authorization header.
      if (request.headers.origin) throw new ConsoleServiceError('不接受浏览器跨域调用', 'FORBIDDEN', 403)
      if (!authorized(request)) throw new ConsoleServiceError('无法认证本机控制台连接，请重新读取连接文件', 'UNAUTHORIZED', 401)
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/inspect') {
        const query = Object.fromEntries(url.searchParams)
        return send(200, { data: await timeout(inspect(query), 20_000) })
      }
      if (request.method === 'GET' && url.pathname === '/v1/jobs') return send(200, { jobs: list() })
      const match = /^\/v1\/jobs\/([^/]+)(?:\/(approve|pause|resume|cancel))?$/u.exec(url.pathname)
      if (match && request.method === 'GET' && !match[2]) return send(200, { job: get(decodeURIComponent(match[1])) })
      if (request.method === 'POST') {
        if (Number(request.headers['content-length']) > CONSOLE_LIMITS.requestBytes) {
          throw new ConsoleServiceError('请求内容超过 2 MiB 限制', 'PAYLOAD_TOO_LARGE', 413)
        }
        if (request.headers['content-type'] && !request.headers['content-type'].toLowerCase().startsWith('application/json')) {
          throw new ConsoleServiceError('请求内容必须使用 application/json', 'UNSUPPORTED_MEDIA_TYPE', 415)
        }
        const body = await readRequestBody(request)
        if (url.pathname === '/v1/jobs') return send(202, { job: await submit(body) })
        if (match?.[2]) {
          const controls = { approve, pause, resume, cancel }
          return send(202, { job: await controls[match[2]](decodeURIComponent(match[1])) })
        }
      }
      throw new ConsoleServiceError('控制台接口不存在', 'NOT_FOUND', 404)
    } catch (error) {
      const known = error instanceof ConsoleServiceError
      if (!known) logger('Console HTTP request failed', error)
      send(known ? error.statusCode : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '桌面服务处理请求失败' } })
    }
  }

  async function start() {
    if (closed || closing) throw new ConsoleServiceError('已经关闭的服务不能再次启动', 'SERVICE_UNAVAILABLE', 503)
    if (started) return { version: 1, port: endpoint.port, pid: process.pid, endpointPath }
    if (starting) return starting
    starting = (async () => {
      try {
        const stat = await fs.stat(storagePath).catch((error) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (stat) {
          if (stat.size > MAX_STORAGE_BYTES) throw new Error('任务记录文件过大；原文件已保留')
          let document
          try { document = JSON.parse(await fs.readFile(storagePath, 'utf8')) } catch {
            throw new Error('任务记录文件无法读取；原文件已保留')
          }
          jobs = validateSavedJobs(document)
        }
        for (const job of jobs) {
          if (!['queued', 'running', 'saving'].includes(job.status)) continue
          job.status = 'paused'
          delete job.pendingAction
          addEvent(job, { title: '应用重新启动，任务已暂停并保留检查点', state: 'done' })
        }
        await atomicWrite(storagePath, { version: 1, kind: 'console-jobs', jobs })
        token = randomBytes(32).toString('hex')
        server = http.createServer((request, response) => { void route(request, response) })
        server.requestTimeout = 20_000
        server.headersTimeout = 10_000
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('无法确定本机控制台端口')
        endpoint = { version: 1, port: address.port, token, pid: process.pid }
        await atomicWrite(endpointPath, endpoint)
        started = true
        notify()
        schedule()
        return { version: 1, port: address.port, pid: process.pid, endpointPath }
      } catch (error) {
        if (server?.listening) await new Promise((resolve) => server.close(resolve))
        server = undefined
        throw error
      } finally {
        starting = undefined
      }
    })()
    return starting
  }

  async function close() {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      try {
        await suspend()
        await waitForIdle()
        await mutationTail
      } finally {
        closed = true
        started = false
        if (server?.listening) {
          const done = new Promise((resolve) => server.close(resolve))
          server.closeAllConnections?.()
          await done
        }
        server = undefined
        try {
          const current = JSON.parse(await fs.readFile(endpointPath, 'utf8'))
          if (current.token === token && current.pid === process.pid) await fs.unlink(endpointPath)
        } catch (error) {
          if (error.code !== 'ENOENT') logger('Unable to remove console endpoint', error)
        }
      }
    })()
    return closePromise
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('任务订阅器必须是函数')
    subscribers.add(listener)
    return () => subscribers.delete(listener)
  }

  return { start, submit, list, get, approve, pause, resume, cancel, report, checkpoint, inspect, suspend, waitForIdle, close, dispose: close, subscribe }
}
