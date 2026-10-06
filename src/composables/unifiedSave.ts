export type UnifiedSaveState = 'saving' | 'saved' | 'dirty' | 'error' | 'conflict'

export type UnifiedSaveResult = {
  saved: boolean
  canceled?: boolean
  error?: string
  conflict?: boolean
}

export type UnifiedSaveOptions = {
  saveAs?: boolean
  allowDialog?: boolean
  profileOnly?: boolean
}

export type UnifiedSaveWriteOptions = {
  saveAs: boolean
  allowDialog: boolean
  profileOnly: boolean
}

export type UnifiedSaveQueueOptions<T> = {
  getGeneration: () => number
  capture: (options: UnifiedSaveWriteOptions) => T | Promise<T>
  write: (snapshot: T, options: UnifiedSaveWriteOptions) => Promise<UnifiedSaveResult>
  onState?: (state: UnifiedSaveState, error?: string, options?: UnifiedSaveWriteOptions) => void
  /** Wait for pending reactive updates, such as Vue's nextTick. */
  settle?: () => void | Promise<void>
  /** Total write attempts per request, including the first; limited to three. */
  maxAttempts?: number
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

/**
 * One queue for manual, automatic and closing saves. Snapshots are captured
 * when a request starts, rather than when it is added to a busy queue.
 *
 * capture must return an independent snapshot without changing editable data.
 * getGeneration must count actual edits, not serialization or save-status
 * changes. A successful write confirms only that generation; later edits are
 * captured and written again before the request can report success.
 */
export function createUnifiedSaveQueue<T>(options: UnifiedSaveQueueOptions<T>) {
  const requestedAttempts = options.maxAttempts ?? 3
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.min(3, Math.floor(requestedAttempts)))
    : 3
  let queue: Promise<void> = Promise.resolve()
  let pending = 0

  function notify(state: UnifiedSaveState, request: UnifiedSaveWriteOptions, error?: string) {
    // Rendering a status is an observer of persistence. An observer failure
    // must not discard a confirmed write or poison subsequent queued saves.
    try { options.onState?.(state, error, request) } catch { /* preserve the save result */ }
  }

  async function settle() {
    await Promise.resolve()
    await options.settle?.()
  }

  function fail(message: string, request: UnifiedSaveWriteOptions): UnifiedSaveResult {
    notify('error', request, message)
    return { saved: false, error: message }
  }

  async function execute(request: UnifiedSaveWriteOptions): Promise<UnifiedSaveResult> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      notify('saving', request)
      let generation: number
      let snapshot: T
      try {
        await settle()
        generation = options.getGeneration()
        snapshot = await options.capture(request)
      } catch (error) {
        return fail(`准备保存内容失败：${errorMessage(error, '无法读取当前内容')}`, request)
      }

      let result: UnifiedSaveResult
      try {
        result = await options.write(snapshot, attempt === 0 ? request : {
          saveAs: false,
          allowDialog: false,
          profileOnly: request.profileOnly,
        })
      } catch (error) {
        return fail(`保存失败：${errorMessage(error, '无法写入当前内容')}`, request)
      }
      if (result?.canceled) {
        notify('dirty', request)
        return { saved: false, canceled: true }
      }
      if (!result?.saved) {
        if (result?.conflict) {
          const error = result.error?.trim() || '文件已被外部修改，请先处理保存冲突。'
          notify('conflict', request, error)
          return { saved: false, conflict: true, error }
        }
        return fail(result?.error?.trim() || '保存未完成，请重试。', request)
      }

      let currentGeneration: number
      try {
        await settle()
        currentGeneration = options.getGeneration()
      } catch (error) {
        return fail(`无法确认保存状态：${errorMessage(error, '读取修改状态失败')}`, request)
      }
      if (generation === currentGeneration) {
        // A confirmed settings-only write says nothing about the portfolio
        // file. Let the caller retain its content dirty state.
        notify(request.profileOnly ? 'dirty' : 'saved', request)
        return { saved: true }
      }
      notify('dirty', request)
    }
    return fail(`保存期间内容持续变化，已尝试 ${maxAttempts} 次。最新修改仍未保存，请停止编辑后重试。`, request)
  }

  function save(request: UnifiedSaveOptions = {}): Promise<UnifiedSaveResult> {
    // Copy caller options now, but defer capturing content until execution.
    const writeOptions: UnifiedSaveWriteOptions = {
      saveAs: request.saveAs === true,
      allowDialog: request.allowDialog === true,
      profileOnly: request.saveAs !== true && request.profileOnly === true,
    }
    pending += 1
    const run = queue
      .catch(() => {})
      .then(() => execute(writeOptions))
      .finally(() => { pending -= 1 })
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  async function waitForPending() {
    // A completion callback may queue another save while this one settles.
    // Re-read the tail until every request, including those saves, has ended.
    while (pending > 0) await queue
  }

  return {
    save,
    waitForPending,
    pendingCount: () => pending,
  }
}
