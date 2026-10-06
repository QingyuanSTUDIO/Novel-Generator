import { getCurrentScope, onScopeDispose, ref } from 'vue'
import type { DesktopQyOpenResult, FileRevisionConflict } from '../files/types'

export type QyFileConflictTarget = {
  path: string
  portfolioId: string
  generation: number
}

export type QyFileConflictOptions = {
  getTarget: () => QyFileConflictTarget
  stopAutoSave: () => void
  beforeReload: () => Promise<void>
  readFile: (path: string) => Promise<DesktopQyOpenResult>
  /**
   * Validate and clone first, then apply synchronously. No editable state may
   * change before validation succeeds or while awaiting further work.
   */
  applyFile: (result: DesktopQyOpenResult) => Promise<void>
  /** Uses the application's guarded, unified Save As queue. */
  saveAs: () => Promise<{ saved: boolean; canceled?: boolean; error?: string }>
}

type ConflictAction = {
  epoch: number
  conflict: FileRevisionConflict
  target: QyFileConflictTarget
  confirmedWrite?: {
    epoch: number
    path: string
    portfolioId: string
  }
}

type ConflictFileWrite = {
  epoch: number
  target: QyFileConflictTarget
  action: ConflictAction | null
}

const revisionPattern = /^sha256:[a-f0-9]{64}$/
const changedTargetMessage = '作品集或编辑内容在处理冲突期间发生了变化，已保留当前编辑。请重新检查后处理冲突。'

function failureText(failure: unknown, fallback: string) {
  if (failure instanceof Error && failure.message.trim()) return failure.message
  if (typeof failure === 'string' && failure.trim()) return failure
  return fallback
}

/**
 * Resolves a disk conflict without letting delayed reads replace newer edits.
 * Hiding the dialog never removes the conflict or resumes automatic saving.
 */
export function useQyFileConflict(options: QyFileConflictOptions) {
  const conflict = ref<FileRevisionConflict | null>(null)
  const open = ref(false)
  const busy = ref(false)
  const error = ref('')
  let reportedTarget: QyFileConflictTarget | null = null
  let pendingSaveAs: ConflictAction | null = null
  let epoch = 0
  let disposed = false

  function report(value: FileRevisionConflict) {
    if (disposed) return
    epoch += 1
    reportedTarget = { ...options.getTarget() }
    conflict.value = { ...value }
    error.value = ''
    open.value = true
    options.stopAutoSave()
  }

  function clear() {
    epoch += 1
    reportedTarget = null
    conflict.value = null
    error.value = ''
    open.value = false
    // A read/save already in progress still owns busy until its finally block.
  }

  function dismiss() {
    open.value = false
  }

  function reopen() {
    if (!disposed && conflict.value) open.value = true
  }

  function begin(): ConflictAction | null {
    if (disposed || busy.value || !conflict.value || !reportedTarget) return null
    const current = options.getTarget()
    if (current.path !== reportedTarget.path || current.portfolioId !== reportedTarget.portfolioId) {
      error.value = changedTargetMessage
      return null
    }
    busy.value = true
    error.value = ''
    // Clicking a resolution button is a new explicit choice. Edits made after
    // dismissing the original dialog belong to that choice; only edits made
    // after this action starts invalidate its asynchronous read.
    return { epoch, conflict: { ...conflict.value }, target: { ...current } }
  }

  function active(action: ConflictAction) {
    return !disposed && epoch === action.epoch && Boolean(conflict.value)
  }

  function captureFileWrite(): ConflictFileWrite {
    return { epoch, target: { ...options.getTarget() }, action: pendingSaveAs }
  }

  function ownsFileWrite(write: ConflictFileWrite) {
    return !disposed && write.epoch === epoch && write.action === pendingSaveAs
      && (!write.action || active(write.action) || confirmedWriteStillCurrent(write.action))
  }

  /** Check before adopting the save response's new path or revision. */
  function acceptsFileWrite(write: ConflictFileWrite) {
    const current = options.getTarget()
    return ownsFileWrite(write)
      && current.path === write.target.path
      && current.portfolioId === write.target.portfolioId
  }

  /**
   * A confirmed file write resolves the old disk conflict immediately, even
   * while the shared queue is saving newer edits or independent local records.
   * Retain the owning action's receipt so clearing that resolved conflict does
   * not turn its eventual successful Save As reply into a canceled action.
   */
  function confirmFileWrite(write: ConflictFileWrite, savedPath: string) {
    if (!ownsFileWrite(write) || !conflict.value) return
    const target = options.getTarget()
    if (target.path !== savedPath || target.portfolioId !== write.target.portfolioId) return
    const action = write.action
    if (action && !active(action)) return
    clear()
    if (action) {
      action.confirmedWrite = {
        epoch,
        path: target.path,
        portfolioId: target.portfolioId,
      }
    }
  }

  function confirmedWriteStillCurrent(action: ConflictAction) {
    const receipt = action.confirmedWrite
    if (disposed || !receipt || receipt.epoch !== epoch || conflict.value) return false
    const current = options.getTarget()
    return current.path === receipt.path && current.portfolioId === receipt.portfolioId
  }

  function targetUnchanged(action: ConflictAction) {
    const current = options.getTarget()
    return current.path === action.target.path
      && current.portfolioId === action.target.portfolioId
      && current.generation === action.target.generation
  }

  function refuseChangedTarget(action: ConflictAction) {
    if (targetUnchanged(action)) return false
    error.value = changedTargetMessage
    return true
  }

  async function reload(): Promise<boolean> {
    const action = begin()
    if (!action) return false
    try {
      if (action.conflict.kind === 'missing') {
        error.value = '原作品集文件已不存在，无法重新加载。请另存为保留当前编辑。'
        return false
      }
      if (refuseChangedTarget(action)) return false
      await options.beforeReload()
      if (!active(action)) return false
      if (refuseChangedTarget(action)) return false
      const result = await options.readFile(action.conflict.path)
      if (!active(action)) return false
      if (refuseChangedTarget(action)) return false
      if (result.canceled) return false
      if (result.error) {
        error.value = result.error
        return false
      }
      if (!result.revision || !revisionPattern.test(result.revision)) {
        error.value = '读取的作品集缺少有效文件版本，未重新加载，当前编辑已保留。'
        return false
      }
      if (result.document === undefined) {
        error.value = '未能读取作品集内容，当前编辑已保留。'
        return false
      }
      await options.applyFile(result)
      if (!active(action)) return false
      clear()
      return true
    } catch (failure) {
      if (active(action)) error.value = failureText(failure, '重新加载失败，当前编辑已保留。')
      return false
    } finally {
      busy.value = false
    }
  }

  async function saveAs(): Promise<boolean> {
    const action = begin()
    if (!action) return false
    pendingSaveAs = action
    try {
      const result = await options.saveAs()
      if (!active(action) && !confirmedWriteStillCurrent(action)) return false
      if (result.canceled) return false
      if (!result.saved) {
        if (active(action)) error.value = result.error || '另存为未完成，当前编辑和文件冲突已保留。'
        return false
      }
      if (active(action)) {
        const current = options.getTarget()
        if (current.path !== action.target.path || current.portfolioId !== action.target.portfolioId) {
          error.value = changedTargetMessage
          return false
        }
        clear()
      }
      return true
    } catch (failure) {
      if (active(action)) error.value = failureText(failure, '另存为失败，当前编辑和文件冲突已保留。')
      return false
    } finally {
      if (pendingSaveAs === action) pendingSaveAs = null
      busy.value = false
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      epoch += 1
    })
  }

  return {
    conflict, open, busy, error, report, clear,
    captureFileWrite, acceptsFileWrite, confirmFileWrite,
    dismiss, reopen, reload, saveAs,
  }
}
