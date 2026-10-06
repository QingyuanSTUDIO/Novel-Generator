import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AgentPlan } from '../types'
import type { ConsoleCommand, ConsoleEvent, ConsoleInspectQuery, ConsoleJob, ConsoleResult, ConsoleSubmission } from '../console/types'

type Options = {
  execute(command: ConsoleCommand): Promise<ConsoleResult>
  inspect(query: ConsoleInspectQuery): unknown | Promise<unknown>
  getPendingPlan(): AgentPlan | null
  clearPendingPlan(): void
}

/**
 * A renderer transport, not another job queue. The Electron broker owns job
 * persistence and execution order, including submissions from external CLIs.
 */
export function useDesktopConsole(options: Options) {
  const jobs = ref<ConsoleJob[]>([])
  const error = ref('')
  const available = ref(false)
  const endpointPath = ref('')
  const cliPath = ref('')
  const activeJobId = ref('')
  const pendingJobId = ref('')
  const dockOpen = ref(false)
  const dockHeight = ref(280)
  const busy = computed(() => jobs.value.some((job) => job.status === 'running' || job.status === 'saving'))
  const disposers: (() => void)[] = []
  let destroyed = false
  let reportTail = Promise.resolve()
  let endResize: (() => void) | undefined

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return
    endResize?.()
    const origin = { y: event.clientY, height: dockHeight.value }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return
      dockHeight.value = Math.max(170, Math.min(window.innerHeight * 0.7, origin.height + origin.y - next.clientY))
    }
    const end = (next?: PointerEvent) => {
      if (next && next.pointerId !== event.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      endResize = undefined
    }
    endResize = end
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    event.preventDefault()
  }

  function updateJobs(next: ConsoleJob[]) {
    jobs.value = next
    if (pendingJobId.value) {
      const pending = next.find((job) => job.id === pendingJobId.value)
      if (!pending || ['canceled', 'paused', 'failed', 'completed'].includes(pending.status)) {
        if (options.getPendingPlan()?.id === pending?.result?.plan?.id) options.clearPendingPlan()
        pendingJobId.value = ''
      }
    }
  }

  async function handleCommand(requestId: string, command: ConsoleCommand) {
    if (destroyed) return
    const running = command.action !== 'cancel'
    if (running) activeJobId.value = command.job.id
    try {
      const result = await options.execute(command)
      if (destroyed) return
      if (running) {
        await reportTail
        if (result.status === 'awaiting_approval') pendingJobId.value = command.job.id
        else if (pendingJobId.value === command.job.id) pendingJobId.value = ''
      }
      window.desktopConsole?.completeCommand(requestId, { result: JSON.parse(JSON.stringify(result)) })
    } catch (failure) {
      window.desktopConsole?.completeCommand(requestId, { error: failure instanceof Error ? failure.message : '桌面任务执行失败。' })
    } finally {
      if (running && activeJobId.value === command.job.id) activeJobId.value = ''
    }
  }

  onMounted(async () => {
    const bridge = window.desktopConsole
    if (!bridge) return
    disposers.push(bridge.onUpdate(updateJobs))
    disposers.push(bridge.onCommand((requestId, command) => { void handleCommand(requestId, command) }))
    disposers.push(bridge.onInspect((requestId, query) => {
      void Promise.resolve().then(() => options.inspect(query)).then(
        (value) => bridge.completeInspect(requestId, { value: JSON.parse(JSON.stringify(value ?? null)) }),
        (failure) => bridge.completeInspect(requestId, { error: failure instanceof Error ? failure.message : '无法读取工作区。' }),
      )
    }))
    try {
      const info = await bridge.info()
      endpointPath.value = info.endpointPath
      cliPath.value = info.cliPath
      updateJobs(await bridge.list())
      available.value = true
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '控制台连接失败。'
    }
  })

  onBeforeUnmount(() => {
    destroyed = true
    endResize?.()
    for (const dispose of disposers) dispose()
  })

  async function submit(input: ConsoleSubmission) {
    if (!window.desktopConsole || !available.value) throw new Error('桌面控制台尚未连接。')
    error.value = ''
    try { return await window.desktopConsole.submit(input) } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '提交任务失败。'
      throw failure
    }
  }

  async function action(input: { jobId: string; action: 'approve' | 'pause' | 'resume' | 'cancel' }) {
    error.value = ''
    try {
      if (!window.desktopConsole) throw new Error('桌面控制台尚未连接。')
      await window.desktopConsole.action(input)
      if ((input.action === 'pause' || input.action === 'cancel') && pendingJobId.value === input.jobId) {
        options.clearPendingPlan()
        pendingJobId.value = ''
      }
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '任务操作失败。'
    }
  }

  function report(event: Omit<ConsoleEvent, 'sequence' | 'createdAt'>) {
    const id = activeJobId.value
    if (!id || !window.desktopConsole) return
    // Stage events are persisted in order. Stream deltas remain in the chat
    // view; they must not cause a disk write for each received character.
    reportTail = reportTail.then(async () => {
      await window.desktopConsole!.report(id, event)
    }).catch((failure) => {
      error.value = failure instanceof Error ? failure.message : '任务日志保存失败。'
    })
  }

  return {
    jobs, error, available, endpointPath, cliPath, activeJobId, pendingJobId,
    busy, dockOpen, dockHeight, startResize, submit, action, report,
    checkpoint: async (jobId: string, result: ConsoleResult) => {
      await reportTail
      if (!window.desktopConsole) throw new Error('控制台已断开，保存断点尚未写入。')
      await window.desktopConsole.checkpoint(jobId, JSON.parse(JSON.stringify(result)))
    },
    suspend: async () => {
      if (available.value) await window.desktopConsole?.suspend()
      await reportTail
    },
  }
}
