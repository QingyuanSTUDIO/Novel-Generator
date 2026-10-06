import { applyHistoryPatch, createInverseHistoryPatch } from './historyPatch.ts'
import type { AgentHistoryEntry, AgentHistoryPatchOperation, AgentSnapshot } from '../types.ts'

export type ManualHistoryRecordInput = {
  history: AgentHistoryEntry[]
  before: AgentSnapshot
  after: AgentSnapshot
  beforeFingerprint: string
  afterFingerprint: string
  summary: string
  historyLimit: number
  now?: number
  id?: string
}

/**
 * Add a manual edit to the shared history as a compact inverse patch.
 *
 * The patch is intentionally generated from the full in-memory snapshots but
 * only the field-level JSON operations are retained. Consecutive edits to the
 * same work state are coalesced when the previous entry still points at the
 * exact state that preceded this edit (for example, keystrokes in one input).
 */
export function appendManualHistory(input: ManualHistoryRecordInput): AgentHistoryEntry[] {
  const patch = createInverseHistoryPatch(input.before, input.after)
  if (!patch.length) return input.history

  const now = input.now ?? Date.now()
  const existing = input.history[0]
  if (existing?.source === 'manual'
    && existing.status === 'applied'
    && Array.isArray(existing.patch)
    && existing.patch.length > 0
    && existing.afterFingerprint === input.beforeFingerprint) {
    try {
      const originalBefore = applyHistoryPatch(input.before, existing.patch) as AgentSnapshot
      const mergedPatch = createInverseHistoryPatch(originalBefore, input.after)
      if (mergedPatch.length) {
        const merged: AgentHistoryEntry = {
          ...existing,
          summary: input.summary,
          changes: [input.summary],
          createdAt: now,
          patch: mergedPatch,
          afterFingerprint: input.afterFingerprint,
        }
        return [merged, ...input.history.slice(1)].slice(0, Math.max(0, input.historyLimit))
      }
    } catch {
      // A malformed/legacy patch must never prevent the current edit from
      // receiving its own history entry.
    }
  }

  const entry: AgentHistoryEntry = {
    id: input.id ?? `manual-${now}-${Math.random().toString(36).slice(2, 8)}`,
    summary: input.summary,
    changes: [input.summary],
    createdAt: now,
    status: 'applied',
    source: 'manual',
    patch: patch as AgentHistoryPatchOperation[],
    afterFingerprint: input.afterFingerprint,
  }
  return [entry, ...input.history].slice(0, Math.max(0, input.historyLimit))
}

export function manualHistorySummary(path: string[], before: unknown, after: unknown): string {
  const label = path.length ? path.join('.') : '作品资料'
  if (before === undefined) return `手动新增 ${label}`
  if (after === undefined) return `手动移除 ${label}`
  return `手动修改 ${label}`
}
