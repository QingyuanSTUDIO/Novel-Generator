import { defaultModelSettings, readModelSettings } from './modelSettings.ts'

export type QueriedModelLimits = {
  /**
   * An explicit context window, or an input-only limit that the caller has
   * clearly labelled and chosen to use as a conservative window. Never infer
   * this number by adding an upstream input and output limit together.
   */
  contextTokens: number
  /** A separate input-only constraint; never add it to the output capacity. */
  maxInputTokens?: number
  maxOutputTokens?: number
}

export type ModelLimitPatch = {
  '上下文长度': string
  '最大回复长度'?: string
}

export type AppliedModelLimits = {
  patch: ModelLimitPatch
  /** Effective conservative local budget, distinct from the upstream window. */
  contextTokens: number
  maxTokens: number
  replyReduced: boolean
  notices: string[]
}

function validateLimit(value: number, label: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}必须是 ${min}～${max} 范围内的整数。`)
  }
}

/**
 * Apply queried capacity without increasing the author's reply reservation.
 * The patch changes only capacity/reply budgets; it cannot change conversation
 * memory, sampling, credentials or the preset's verification state.
 */
export function applyModelLimits(
  fields: Readonly<Record<string, string>>,
  limits: QueriedModelLimits,
): AppliedModelLimits {
  validateLimit(limits.contextTokens, '服务器返回的上下文长度', 1024, 10000000)
  if (limits.maxInputTokens !== undefined) {
    validateLimit(limits.maxInputTokens, '服务器返回的输入上限', 1024, Number.MAX_SAFE_INTEGER)
  }
  if (limits.maxOutputTokens !== undefined) {
    validateLimit(limits.maxOutputTokens, '服务器返回的最大回复长度', 1, 1000000)
  }
  const contextTokens = Math.min(limits.contextTokens, limits.maxInputTokens ?? limits.contextTokens)

  const rawMaxTokens = fields['最大回复长度']?.trim()
  const currentMaxTokens = rawMaxTokens ? Number(rawMaxTokens) : defaultModelSettings.maxTokens
  validateLimit(currentMaxTokens, '当前最大回复长度', 1, 1000000)

  const safetyTokens = Math.max(32, Math.ceil(contextTokens * 0.05))
  const minimumInputTokens = Math.min(1024, Math.floor(contextTokens / 2))
  let maxTokens = Math.min(currentMaxTokens, limits.maxOutputTokens ?? currentMaxTokens)
  const notices: string[] = []

  if (contextTokens < limits.contextTokens) {
    notices.push(`服务器上下文总量为 ${limits.contextTokens.toLocaleString()} Token，独立输入上限为 ${limits.maxInputTokens!.toLocaleString()} Token；已取较小的输入上限作为保守本地预算，继续预留回复与安全空间。`)
  }
  if (maxTokens < currentMaxTokens) {
    notices.push(`服务器的最大回复上限为 ${limits.maxOutputTokens} Token，已下调回复预留。`)
  }
  if (contextTokens - maxTokens - safetyTokens < minimumInputTokens) {
    maxTokens = Math.min(
      maxTokens,
      Math.floor(contextTokens / 4),
      contextTokens - safetyTokens - minimumInputTokens,
    )
    notices.push(`上下文较小，已下调回复预留，为输入资料保留至少 ${minimumInputTokens} Token 和安全余量。`)
  }

  const replyReduced = maxTokens < currentMaxTokens
  const patch: ModelLimitPatch = { '上下文长度': String(contextTokens) }
  if (replyReduced) patch['最大回复长度'] = String(maxTokens)

  // Validate the resulting complete preset, not only the queried numbers.
  // Applying this patch never mutates the caller's fields, even on failure.
  readModelSettings({ fields: { ...fields, ...patch } })
  return { patch, contextTokens, maxTokens, replyReduced, notices }
}
