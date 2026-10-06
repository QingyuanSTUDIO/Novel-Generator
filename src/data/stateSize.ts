/**
 * Small, dependency-free helpers used before persistence writes.
 *
 * These estimates intentionally measure the UTF-8 JSON payload that will be
 * sent to the storage boundary. They are not a filesystem allocation report;
 * indentation, JSON punctuation and UTF-8 encoding are included so warnings
 * are useful before a profile or `.qy` write starts.
 */

export const DEFAULT_STATE_SIZE_LIMITS = {
  /** Show a non-blocking warning once the local profile becomes unusually large. */
  profileWarningBytes: 6 * 1024 * 1024,
  /** Match the local profile request boundary enforced by server/index.mjs. */
  profileMaxBytes: 8 * 1024 * 1024,
  /** Show a non-blocking warning for a large portable portfolio. */
  portfolioWarningBytes: 64 * 1024 * 1024,
  /** The .qy writer remains unbounded by default; callers may opt into a cap. */
  portfolioMaxBytes: Number.POSITIVE_INFINITY,
} as const

export type StateSizeLevel = 'ok' | 'warning' | 'error'

export type StateSizeBreakdown = {
  key: string
  bytes: number
}

export type StateSizeReport = {
  bytes: number
  level: StateSizeLevel
  warningBytes: number
  maxBytes: number
  breakdown: StateSizeBreakdown[]
}

export type StateSizeOptions = {
  warningBytes?: number
  maxBytes?: number
  /** JSON indentation used by the eventual write. Defaults to two spaces. */
  space?: string | number
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Return the UTF-8 byte count without exposing the serialized payload. */
export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength
  // TextEncoder is available in supported browsers and current Node. This is
  // a conservative fallback for tests or embedded runtimes that lack it.
  return unescape(encodeURIComponent(text)).length
}

/** Serialize a JSON value and return its UTF-8 size in bytes. */
export function estimateJsonByteSize(value: unknown, space: string | number = 2): number {
  const serialized = JSON.stringify(value, null, space)
  return serialized === undefined ? 0 : utf8ByteLength(serialized)
}

function levelFor(bytes: number, warningBytes: number, maxBytes: number): StateSizeLevel {
  if (bytes > maxBytes) return 'error'
  if (bytes > warningBytes) return 'warning'
  return 'ok'
}

/**
 * Estimate a JSON state payload and identify which top-level sections consume
 * the most space. The breakdown is intentionally shallow and stable, making it
 * suitable for a concise save warning without traversing every nested field.
 */
export function estimateStateSize(value: unknown, options: StateSizeOptions = {}): StateSizeReport {
  const maxBytes = finiteNonNegative(options.maxBytes, Number.POSITIVE_INFINITY)
  const warningBytes = Math.min(
    finiteNonNegative(options.warningBytes, Number.POSITIVE_INFINITY),
    maxBytes,
  )
  const space = options.space ?? 2
  const bytes = estimateJsonByteSize(value, space)
  const breakdown = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => ({ key, bytes: estimateJsonByteSize(child, space) }))
      .sort((a, b) => b.bytes - a.bytes)
    : []
  return { bytes, level: levelFor(bytes, warningBytes, maxBytes), warningBytes, maxBytes, breakdown }
}

export function formatByteSize(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(2)} GiB`
}

export function describeStateSize(label: string, report: StateSizeReport, limit = 3): string {
  const top = report.breakdown
    .filter((item) => item.bytes > 0)
    .slice(0, Math.max(1, Math.floor(limit)))
    .map((item) => `${item.key} ${formatByteSize(item.bytes)}`)
    .join('、')
  return `${label}约 ${formatByteSize(report.bytes)}${top ? `；主要占用：${top}` : ''}`
}

export function stateSizeLimitMessage(label: string, report: StateSizeReport): string {
  const source = describeStateSize(label, report)
  return `${source}，超过保存上限 ${formatByteSize(report.maxBytes)}，已停止写入。`
}



