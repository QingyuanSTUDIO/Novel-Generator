import type { AgentMode, AgentPlan } from '../types'
import type { AgentResponse } from '../agent/schema'
import type { ConsoleCommand, ConsoleJob, ConsoleResult } from './types'

export type ConsoleTarget = {
  portfolioId: string
  projectId: string
  chapterId?: string
  conversationId?: string
  filePath: string
  ready: boolean
}

type ExecutorOptions = {
  target(): ConsoleTarget
  busy(): boolean
  pendingPlan(): AgentPlan | null
  fingerprint(): Promise<string>
  run(prompt: string, options: { mode: AgentMode; providerId?: string }): Promise<ConsoleResult>
  stage(response: AgentResponse, existingPlan?: AgentPlan): Promise<ConsoleResult>
  approve(checkpoint: (result: ConsoleResult) => Promise<void>, providerId?: string, operationIndexes?: number[]): Promise<ConsoleResult>
  checkpoint(jobId: string, result: ConsoleResult): Promise<void>
  save(): Promise<boolean>
  saveError(): string
  cancel(jobId: string): void
}

/**
 * Both desktop buttons and the CLI submit to this executor. It delegates all
 * edits to the existing Agent operator and all writes to the unified saver.
 * An execution target is explicit; it never silently switches a portfolio.
 */
export function createConsoleExecutor(options: ExecutorOptions) {
  const leases = new Map<string, symbol>()
  function requireLease(id: string, lease: symbol) {
    if (leases.get(id) !== lease) throw new Error('任务已暂停或取消，未继续执行。')
  }
  function requireTarget(job: ConsoleJob, includeChapter = true) {
    const target = options.target()
    if (!target.ready) throw new Error('桌面作品尚未完成读取，请稍后重试。')
    if (!target.filePath) throw new Error('请先在桌面端保存或打开 .qy 作品集，再提交创作任务。')
    if (target.portfolioId !== job.target.portfolioId || target.projectId !== job.target.projectId) {
      throw new Error('任务绑定的作品集或作品与当前打开的作品不同。请打开目标作品后再恢复任务。')
    }
    if (includeChapter && job.target.chapterId && target.chapterId !== job.target.chapterId) {
      throw new Error('任务绑定的章节与当前章节不同。请选中目标章节后再恢复任务。')
    }
    if (includeChapter && job.target.conversationId && target.conversationId !== job.target.conversationId) {
      throw new Error('任务绑定的 Agent 对话与当前对话不同。请打开原对话后再恢复任务。')
    }
    return target
  }

  async function saveApplied(job: ConsoleJob, lease: symbol): Promise<ConsoleResult> {
    requireTarget(job, false)
    const result = job.result!
    const fingerprint = await options.fingerprint()
    requireLease(job.id, lease)
    requireTarget(job, false)
    if (!result.afterFingerprint || result.afterFingerprint !== fingerprint) {
      return {
        ...result, status: 'failed',
        error: '已应用任务的保存断点与当前作品不一致。为避免重复写入，恢复已停止；请检查当前 .qy 文件及修改记录。',
      }
    }
    const saved = await options.save()
    return saved
      ? { ...result, status: 'completed', error: undefined, message: '保存断点已完成，未重复生成或应用修改。' }
      : { ...result, status: 'failed', error: options.saveError() || '修改已保留，保存尚未完成。可以恢复任务重试保存。' }
  }

  async function execute(command: ConsoleCommand): Promise<ConsoleResult> {
    const { job, action } = command
    if (action === 'cancel') {
      leases.delete(job.id)
      options.cancel(job.id)
      return { status: 'completed', message: '已停止当前请求。已应用的修改请通过修改记录撤销。' }
    }
    const lease = Symbol(job.id)
    leases.set(job.id, lease)
    try {
      if (job.result?.applied) return await saveApplied(job, lease)
      requireTarget(job)
      if (options.busy()) throw new Error('当前还有创作操作在执行，请等待结束后恢复此任务。')
      if (action === 'approve') {
        const plan = job.result?.plan
        if (!plan) throw new Error('此任务没有可确认的修改计划。')
        const pending = options.pendingPlan()
        if (pending && pending.id !== plan.id) throw new Error('请先处理当前显示的另一份修改计划。')
        const staged = await options.stage({ message: plan.message, operations: plan.operations }, plan)
        requireLease(job.id, lease)
        requireTarget(job)
        if (staged.status !== 'awaiting_approval') return staged
        return await options.approve(
          (result) => options.checkpoint(job.id, result),
          job.providerId ?? job.result?.providerId,
          command.operationIndexes,
        )
      }
      if (options.pendingPlan()) throw new Error('请先确认或取消当前修改计划，再执行新任务。')
      if (job.kind === 'save') {
        const saved = await options.save()
        return saved
          ? { status: 'completed', message: '当前作品集已保存到 .qy 文件。' }
          : { status: 'failed', error: options.saveError() || '作品集保存失败。' }
      }
      if (job.kind === 'plan') {
        if (!job.response) throw new Error('缺少 Agent JSON 操作计划。')
        const result = await options.stage(job.response)
        requireLease(job.id, lease)
        return result
      }
      const result = await options.run(job.prompt, { mode: job.mode, providerId: job.providerId })
      requireLease(job.id, lease)
      return result
    } catch (error) {
      return {
        ...(job.result?.applied ? job.result : {}),
        status: 'failed',
        error: error instanceof Error ? error.message : '控制台任务执行失败。',
      }
    } finally {
      if (leases.get(job.id) === lease) leases.delete(job.id)
    }
  }

  return { execute }
}

export async function contentFingerprint(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export async function matchesFingerprint(expected: string | undefined, content: () => string): Promise<boolean> {
  if (!expected) return false
  const original = content()
  const matches = expected === original || expected === await contentFingerprint(original)
  // Do not accept edits made during the asynchronous digest operation.
  return matches && original === content()
}
