export type MemeCreationSource = 'agent' | 'manual'
export type MemeReviewStatus = 'pending' | 'complete'

/** A network meme entry used as optional creative context for the Agent. */
export type Meme = {
  id: string
  /** Short name or phrase used to identify the meme. */
  name: string
  /** Meaning, origin, or explanation of the meme. */
  explanation: string
  /** Situations where the meme is appropriate. */
  usage: string
  /** One or more examples showing natural usage. */
  examples: string[]
  /** Human-readable source name or URL. */
  source: string
  /** Original result URL when the entry came from web search. */
  sourceUrl?: string
  /** Publication/observation date in YYYY-MM-DD when known. */
  date: string
  /** Extra search terms or variants for retrieval. */
  keywords: string[]
  /** Whether this entry may be included in Agent context. */
  enabled: boolean
  /** Prevents Agent edits to this entry. */
  locked: boolean
  creationSource: MemeCreationSource
  reviewStatus: MemeReviewStatus
  createdAt: number
  updatedAt: number
}

/** Persisted special table for user-managed and Agent-collected memes. */
export type MemeStore = {
  entries: Meme[]
  updatedAt: number
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
)

const asText = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const asStringArray = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
  : []

export function normalizeMeme(input: unknown, now = Date.now(), index = 0): Meme {
  const source = asRecord(input)
  const name = asText(source.name ?? source.title, '未命名热梗').trim() || '未命名热梗'
  const creationSource: MemeCreationSource = source.creationSource === 'agent' ? 'agent' : 'manual'
  const reviewStatus: MemeReviewStatus = source.reviewStatus === 'complete' ? 'complete' : 'pending'
  return {
    id: asText(source.id, `meme-${now}-${index}`).trim() || `meme-${now}-${index}`,
    name,
    explanation: asText(source.explanation ?? source.meaning),
    usage: asText(source.usage ?? source.scenario ?? source.applicableScene),
    examples: asStringArray(source.examples ?? source.example),
    source: asText(source.source ?? source.sourceUrl),
    sourceUrl: asText(source.sourceUrl) || undefined,
    date: asText(source.date ?? source.publishedAt),
    keywords: asStringArray(source.keywords ?? source.tags),
    enabled: source.enabled !== false,
    locked: source.locked === true,
    creationSource,
    reviewStatus,
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : now,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now,
  }
}

export function createMeme(values: Partial<Meme> = {}, now = Date.now()): Meme {
  return normalizeMeme({
    ...values,
    id: values.id ?? `meme-${now}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: values.createdAt ?? now,
    updatedAt: now,
  }, now)
}

/** Normalize old snapshots and tolerate a legacy bare-array shape. */
export function normalizeMemeStore(input: unknown, now = Date.now()): MemeStore {
  const source = Array.isArray(input) ? { entries: input } : asRecord(input)
  const rawEntries = Array.isArray(source.entries) ? source.entries : []
  return {
    entries: rawEntries.map((entry, index) => normalizeMeme(entry, now, index)),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now,
  }
}

/** New installations start with an empty table so stale internet slang is never injected by default. */
export function createDefaultMemeStore(now = Date.now()): MemeStore {
  return { entries: [], updatedAt: now }
}
