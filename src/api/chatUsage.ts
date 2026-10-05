/** Real counts returned by a provider. Missing counts remain unknown. */
export type ChatUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Anthropic's raw input count excludes its separately reported cache reads/writes. */
  uncachedInputTokens?: number
}

const usageKeys: readonly (keyof ChatUsage)[] = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'uncachedInputTokens',
]

/**
 * Keep only real nonnegative integer counts. An explicit zero is useful data;
 * omitted, null, malformed or negative values do not become a fabricated zero.
 */
export function normalizeChatUsage(value: unknown): ChatUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const usage: ChatUsage = {}
  for (const key of usageKeys) {
    const count = record[key]
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[key] = count
  }
  return Object.keys(usage).length ? usage : undefined
}
