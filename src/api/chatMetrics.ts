import type { ContextBudgetReport } from './contextBudget.ts'
import type { ChatUsage } from './chatUsage.ts'

export type ChatMetrics = {
  requestId: number
  startedAt: number
  providerId: string
  purpose: string
  model: string
  status: 'running' | 'done' | 'error'
  budget: ContextBudgetReport | null
  usage?: ChatUsage
}

let requestSequence = 0
const listeners = new Set<(metrics: ChatMetrics) => void>()

export function nextChatMetricsId() {
  return ++requestSequence
}

export function currentChatMetricsId() {
  return requestSequence
}

/** Observers receive counts and labels only, never prompts or credentials. */
export function publishChatMetrics(metrics: ChatMetrics) {
  for (const listener of listeners) {
    try {
      listener({
        ...metrics,
        budget: metrics.budget ? { ...metrics.budget } : null,
        ...(metrics.usage ? { usage: { ...metrics.usage } } : {}),
      })
    } catch {
      // A display failure must not turn a successful model reply into an error.
    }
  }
}

export function subscribeChatMetrics(listener: (metrics: ChatMetrics) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
