import type { Resource, ResourceTriggerStrategy, Store } from '../types'
import { formatAgentDataBlock } from '../agent/dataBoundary.ts'
import { estimateTextTokens } from '../api/contextBudget.ts'


/** The collection names that can participate in context retrieval. */
export type RetrievalCollection = 'world' | 'characters' | 'items' | 'skills' | 'outline' | 'style'

export type RetrievalSource = {
  collection: RetrievalCollection
  resource: Resource
  /** Stable order inside a collection, used to break injection-order ties. */
  sourceIndex: number
}

export type RetrievalMatch = RetrievalSource & {
  depth: number
  /** Keys that caused this resource to be included. */
  matchedKeys: string[]
  /** `direct` means a key was found in the query; `recursive` means it was found in another entry. */
  matchType: 'direct' | 'recursive'
  /** Local estimate for the formatted DATA block, populated after budget selection. */
  estimatedTokens?: number
}

export type RetrievalSkipReason = 'disabled' | 'max-results' | 'max-tokens'

export type RetrievalSkip = RetrievalMatch & {
  reason: RetrievalSkipReason
  estimatedTokens: number
}

export type RetrievalReport = {
  matches: RetrievalMatch[]
  skipped: RetrievalSkip[]
  estimatedTokens: number
  maxResults: number
  maxTokens: number
}

/**
 * Compact index entry for callers that already send the full formatted
 * resource data block. Keeping this projection separate from
 * `formatRetrievedContext` prevents the same fields from being serialized
 * twice in an Agent request while preserving the metadata needed to identify
 * and protect a resource.
 */
export type RetrievalIndexEntry = {
  collection: RetrievalCollection
  id: string
  title: string
  summary?: string
  depth: number
  matchedKeys: string[]
  matchType: RetrievalMatch['matchType']
  estimatedTokens?: number
  injectionOrder?: number
  lockedAll?: boolean
  lockedFields?: string[]
  holdingItems?: string[]
  holdingSkills?: string[]
  reviewStatus?: Resource['reviewStatus']
  reviewStatusLocked?: boolean
}

export type RetrievalOptions = {
  /** Maximum number of recursive hops after direct matches. Defaults to 2. */
  maxDepth?: number
  /** Total result count budget, including constant entries. */
  maxResults?: number
  /** Total estimated prompt-token budget for retrieved entries. */
  maxTokens?: number
  /** Include entries explicitly disabled in their fields. Defaults to false. */
  includeDisabled?: boolean
}

// World Engine state is injected by its caller. Story-planning context comes
// from the outline collection below, so the engine never reads a separate
// legacy collection.
const collections: RetrievalCollection[] = ['world', 'characters', 'items', 'skills', 'outline', 'style']
const triggerKeyFields = ['触发键', '触发词', '关键词', '关键字', 'triggerKeys', 'triggerKey', 'keywords', 'keyword', 'keys']
const triggerStrategyFields = ['触发策略', '触发方式', '触发模式', 'triggerStrategy', 'triggerMode', 'strategy', 'mode']

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
}

function splitKeys(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\s,，、;；|｜/]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function boolField(resource: Resource, names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const value = resource.fields[name]
    if (value === undefined) continue
    if (/^(false|no|0|否|关闭|禁用|不可)/i.test(value.trim())) return false
    if (/^(true|yes|1|是|开启|启用|可)/i.test(value.trim())) return true
  }
  return fallback
}

/**
 * Read the user-facing trigger strategy while accepting older/hand-authored
 * data. The editor stores the Chinese labels in fields, whereas prompt code
 * uses stable English values internally.
 */
export function triggerStrategyFor(resource: Resource): ResourceTriggerStrategy {
  const retrieval = resource.retrieval as (NonNullable<Resource['retrieval']> & {
    triggerMode?: unknown
    strategy?: unknown
    mode?: unknown
  }) | undefined
  const raw = retrieval?.triggerStrategy
    ?? retrieval?.triggerMode
    ?? retrieval?.strategy
    ?? retrieval?.mode
    ?? triggerStrategyFields.map((field) => resource.fields[field]).find((value) => value !== undefined)
  if (typeof raw === 'string' && /^(always|常驻|永久|始终|全局|固定)$/i.test(raw.trim())) return 'always'
  return 'keywords'
}

/** Configured keywords, without the implicit character/item/skill name fallback. */
export function triggerKeysFor(resource: Resource): string[] {
  const retrieval = resource.retrieval as (NonNullable<Resource['retrieval']> & { triggerKeys?: unknown }) | undefined
  const configured = Array.isArray(resource.retrieval?.keys)
    ? resource.retrieval.keys
    : Array.isArray(retrieval?.triggerKeys)
      ? retrieval.triggerKeys.filter((key): key is string => typeof key === 'string')
      : []
  const fieldKeys = triggerKeyFields.flatMap((field) => splitKeys(resource.fields[field]))
  return [...new Set([...configured, ...fieldKeys]
    .filter((key): key is string => typeof key === 'string')
    .map((key) => key.trim()).filter(Boolean))]
}

export function canonicalTriggerField(field: string): string {
  if (triggerKeyFields.includes(field)) return '触发键'
  if (triggerStrategyFields.includes(field)) return '触发策略'
  return field
}

/** Keep the visible editor fields and structured prompt data in sync on every write. */
export function updateResourceTriggerField(resource: Resource, field: string, value: string): boolean {
  const canonical = canonicalTriggerField(field)
  if (canonical === '触发策略') {
    const strategy: ResourceTriggerStrategy = /^(always|常驻|永久|始终|全局|固定)$/i.test(value.trim()) ? 'always' : 'keywords'
    for (const alias of triggerStrategyFields) delete resource.fields[alias]
    resource.fields['触发策略'] = strategy === 'always' ? '常驻' : '关键词'
    resource.retrieval = { ...resource.retrieval, triggerStrategy: strategy }
    return true
  }
  if (canonical === '触发键') {
    const keys = [...new Set(splitKeys(value))]
    for (const alias of triggerKeyFields) delete resource.fields[alias]
    resource.fields['触发键'] = keys.join('、')
    resource.retrieval = { ...resource.retrieval, keys }
    return true
  }
  return false
}

export function normalizeResourceTriggers(resource: Resource): Resource {
  const strategy = triggerStrategyFor(resource)
  const keys = triggerKeysFor(resource)
  updateResourceTriggerField(resource, '触发策略', strategy)
  updateResourceTriggerField(resource, '触发键', keys.join('、'))
  if (Array.isArray(resource.lockedFields)) {
    resource.lockedFields = [...new Set(resource.lockedFields.filter((field) => typeof field === 'string').map(canonicalTriggerField))]
  }
  return resource
}

function keysFor(resource: Resource, collection: RetrievalCollection): string[] {
  const configured = triggerKeysFor(resource)
  const isCard = collection === 'characters' || collection === 'items' || collection === 'skills'
  const fallback = configured.length || collection === 'world' ? [] : [resource.title]
  const aliases = isCard || collection === 'world' ? [] : splitKeys(resource.tag)
  return [...new Set([...configured, ...fallback, ...aliases].map(normalize).filter(Boolean))]
}

function isAlwaysTriggered(resource: Resource): boolean {
  return triggerStrategyFor(resource) === 'always'
}

function searchableText(resource: Resource): string {
  return normalize([
    resource.title,
    resource.tag,
    resource.summary,
    ...Object.entries(resource.fields).map(([key, value]) => `${key} ${value}`),
  ].join(' '))
}

function sourceOrder(source: RetrievalSource): number {
  const configured = source.resource.retrieval?.injectionOrder ?? source.resource.injectionOrder
  if (typeof configured === 'number' && Number.isFinite(configured)) return configured
  const text = source.resource.fields['注入排序'] ?? source.resource.fields['注入顺序'] ?? source.resource.fields['注入位置'] ?? ''
  const match = text.match(/(?:顺序|priority|p)\s*[:：]?\s*(-?\d+)/i) ?? text.match(/\b(-?\d+)\b/)
  return match ? Number(match[1]) : 1000
}

function isEnabled(source: RetrievalSource): boolean {
  if (source.resource.enabled === false) return false
  if (source.resource.retrieval?.enabled === false) return false
  return boolField(source.resource, ['启用', '启用检索', '允许注入'], true)
}

function matchKeys(source: RetrievalSource, normalizedQuery: string): string[] {
  return isAlwaysTriggered(source.resource)
    ? ['常驻']
    : keysFor(source.resource, source.collection).filter((key) => normalizedQuery.includes(key))
}

function canStartRecursion(resource: Resource): boolean {
  return resource.retrieval?.allowRecursion
    ?? resource.allowRecursive
    ?? boolField(resource, ['是否允许递归', '允许递归', '递归'], false)
}

function canContinueRecursion(resource: Resource): boolean {
  return resource.retrieval?.allowFurtherRecursion
    ?? resource.allowFurtherRecursive
    ?? boolField(resource, ['是否允许进一步递归', '允许进一步递归', '进一步递归'], false)
}

/**
 * Retrieve resources related to a chapter prompt. Direct keyword hits are
 * expanded through entry content only when the source entry allows recursion.
 * Results are sorted by the configured injection order, then by match depth and
 * original collection order for deterministic prompts.
 */
export function retrieveContext(
  sources: RetrievalSource[],
  query: string,
  options: RetrievalOptions = {},
): RetrievalMatch[] {
  return retrieveContextReport(sources, query, options).matches
}

/**
 * Retrieve context together with the entries that were eligible but omitted
 * by an enable switch or a result/token budget. The report is intentionally a
 * separate API so existing callers can continue to consume a plain match list.
 */
export function retrieveContextReport(
  sources: RetrievalSource[],
  query: string,
  options: RetrievalOptions = {},
): RetrievalReport {
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 2))
  const maxResults = options.maxResults === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.maxResults))
  const maxTokens = options.maxTokens === undefined
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(options.maxTokens)
      ? Math.max(0, Math.floor(options.maxTokens))
      : Number.POSITIVE_INFINITY
  const includeDisabled = options.includeDisabled ?? false
  const normalizedQuery = normalize(query)
  if (maxResults === 0 || maxTokens === 0) {
    const skipped: RetrievalSkip[] = []
    for (const source of sources) {
      const matchedKeys = matchKeys(source, normalizedQuery)
      if (!matchedKeys.length) continue
      skipped.push({
        ...source,
        depth: 0,
        matchedKeys,
        matchType: 'direct',
        reason: maxResults === 0 ? 'max-results' : 'max-tokens',
        estimatedTokens: estimateRetrievedMatchTokens({ ...source, depth: 0, matchedKeys, matchType: 'direct' }),
      })
    }
    return { matches: [], skipped, estimatedTokens: 0, maxResults, maxTokens }
  }

  const usable = sources.filter((source) => includeDisabled || isEnabled(source))
  // IDs are only unique inside a collection. Imported/manual data can legally
  // reuse the same id in different collections, so keep the collection in the
  // retrieval key or one card can silently overwrite another.
  const matches = new Map<string, RetrievalMatch>()
  const queue: Array<{ source: RetrievalSource; depth: number; haystack: string; matchType: 'direct' | 'recursive' }> = []

  for (const source of usable) {
    const matchedKeys = matchKeys(source, normalizedQuery)
    if (!matchedKeys.length) continue
    matches.set(`${source.collection}:${source.resource.id}`, { ...source, depth: 0, matchedKeys, matchType: 'direct' })
    queue.push({ source, depth: 0, haystack: searchableText(source.resource), matchType: 'direct' })
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    if (current.depth >= maxDepth) continue
    const mayRecurse = current.depth === 0
      ? canStartRecursion(current.source.resource)
      : canContinueRecursion(current.source.resource)
    if (!mayRecurse) continue

    for (const candidate of usable) {
      if (candidate.collection === current.source.collection && candidate.resource.id === current.source.resource.id) continue
      // Constant entries are selected in the direct pass. They should not be
      // reintroduced as a recursive hit, which would make their depth/order
      // dependent on another entry's content.
      if (isAlwaysTriggered(candidate.resource)) continue
      const matchedKeys = keysFor(candidate.resource, candidate.collection).filter((key) => current.haystack.includes(key))
      if (!matchedKeys.length) continue
      const depth = current.depth + 1
      const candidateKey = `${candidate.collection}:${candidate.resource.id}`
      const previous = matches.get(candidateKey)
      if (!previous || depth < previous.depth) {
        matches.set(candidateKey, { ...candidate, depth, matchedKeys, matchType: 'recursive' })
        queue.push({ source: candidate, depth, haystack: searchableText(candidate.resource), matchType: 'recursive' })
      } else if (previous) {
        previous.matchedKeys = [...new Set([...previous.matchedKeys, ...matchedKeys])]
      }
    }
  }

  const ordered = [...matches.values()]
    .sort((left, right) => sourceOrder(left) - sourceOrder(right) || left.depth - right.depth || left.sourceIndex - right.sourceIndex)
  const skipped: RetrievalSkip[] = []
  // Disabled entries are reported only when they would have matched directly.
  // They never enter the recursion queue, preserving the previous safety
  // behavior while making the omission visible to the context preview.
  if (!includeDisabled) {
    for (const source of sources) {
      if (isEnabled(source)) continue
      const matchedKeys = matchKeys(source, normalizedQuery)
      if (!matchedKeys.length) continue
      skipped.push({
        ...source,
        depth: 0,
        matchedKeys,
        matchType: 'direct',
        reason: 'disabled',
        estimatedTokens: estimateRetrievedMatchTokens({ ...source, depth: 0, matchedKeys, matchType: 'direct' }),
      })
    }
  }
  const selected: RetrievalMatch[] = []
  let estimatedTokens = 0
  for (const match of ordered) {
    const matchTokens = estimateRetrievedMatchTokens(match)
    if (selected.length >= maxResults) {
      skipped.push({ ...match, reason: 'max-results', estimatedTokens: matchTokens })
      continue
    }
    if (estimatedTokens + matchTokens > maxTokens) {
      skipped.push({ ...match, reason: 'max-tokens', estimatedTokens: matchTokens })
      continue
    }
    selected.push({ ...match, estimatedTokens: matchTokens })
    estimatedTokens += matchTokens
  }
  return { matches: selected, skipped, estimatedTokens, maxResults, maxTokens }
}

/** Build sources from a Store while preserving the Store's collection order. */
export function retrieveStoreContext(store: Pick<Store, RetrievalCollection>, query: string, options?: RetrievalOptions): RetrievalMatch[] {
  return retrieveStoreContextReport(store, query, options).matches
}

export function retrieveStoreContextReport(
  store: Pick<Store, RetrievalCollection>,
  query: string,
  options?: RetrievalOptions,
): RetrievalReport {
  const sources: RetrievalSource[] = []
  for (const collection of collections) {
    const resources = store[collection] ?? []
    resources.forEach((resource, sourceIndex) => sources.push({ collection, resource, sourceIndex }))
  }
  return retrieveContextReport(sources, query, options)
}

function retrievedMatchText(match: RetrievalMatch): string {
  const fields = Object.entries(match.resource.fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `[${match.collection}] ${match.resource.title} (depth=${match.depth}, order=${sourceOrder(match)})\n${match.resource.summary}${fields ? `\n${fields}` : ''}`
}

function estimateRetrievedMatchTokens(match: RetrievalMatch): number {
  return estimateTextTokens(formatAgentDataBlock(`resource:${match.collection}:${match.resource.id}`, retrievedMatchText(match)))
}

/** Compact prompt-ready representation used by Agent and正文生成 callers. */
export function formatRetrievedContext(matches: RetrievalMatch[]): string {
  return matches.map((match) => formatAgentDataBlock(
    `resource:${match.collection}:${match.resource.id}`,
    retrievedMatchText(match),
  )).join('\n\n')
}

/**
 * Return the structured retrieval index without duplicating resource fields.
 *
 * The full prose/field payload remains in the DATA block produced by
 * `formatRetrievedContext`; this index is intentionally limited to identity,
 * match provenance and mutation-protection metadata.
 */
export function buildRetrievalIndex(matches: readonly RetrievalMatch[]): RetrievalIndexEntry[] {
  return matches.map((match) => {
    const resource = match.resource
    const index: RetrievalIndexEntry = {
      collection: match.collection,
      id: resource.id,
      title: resource.title,
      depth: match.depth,
      matchedKeys: [...match.matchedKeys],
      matchType: match.matchType,
      ...(match.estimatedTokens !== undefined ? { estimatedTokens: match.estimatedTokens } : {}),
    }
    const summary = resource.summary.trim()
    if (summary) index.summary = summary.slice(0, 240)
    const injectionOrder = resource.retrieval?.injectionOrder ?? resource.injectionOrder
    if (typeof injectionOrder === 'number' && Number.isFinite(injectionOrder)) index.injectionOrder = injectionOrder
    if (resource.lockedAll === true) index.lockedAll = true
    if (resource.lockedFields?.length) index.lockedFields = [...resource.lockedFields]
    if (resource.holdingItems?.length) index.holdingItems = [...resource.holdingItems]
    if (resource.holdingSkills?.length) index.holdingSkills = [...resource.holdingSkills]
    if (resource.reviewStatus) index.reviewStatus = resource.reviewStatus
    if (resource.reviewStatusLocked === true) index.reviewStatusLocked = true
    return index
  })
}
