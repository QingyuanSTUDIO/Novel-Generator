import type { Resource, ResourceTriggerStrategy, Store } from '../types'


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
}

export type RetrievalOptions = {
  /** Maximum number of recursive hops after direct matches. Defaults to 2. */
  maxDepth?: number
  /** Result budget; enabled constant entries are retained even when they exceed it. */
  maxResults?: number
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
  if (source.resource.retrieval?.enabled === false) return false
  return boolField(source.resource, ['启用', '启用检索', '允许注入'], true)
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
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 2))
  const maxResults = options.maxResults === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.maxResults))
  const includeDisabled = options.includeDisabled ?? false
  const normalizedQuery = normalize(query)
  if (maxResults === 0) return []

  const usable = sources.filter((source) => includeDisabled || isEnabled(source))
  // IDs are only unique inside a collection. Imported/manual data can legally
  // reuse the same id in different collections, so keep the collection in the
  // retrieval key or one card can silently overwrite another.
  const matches = new Map<string, RetrievalMatch>()
  const queue: Array<{ source: RetrievalSource; depth: number; haystack: string; matchType: 'direct' | 'recursive' }> = []

  for (const source of usable) {
    const matchedKeys = isAlwaysTriggered(source.resource)
      ? ['常驻']
      : keysFor(source.resource, source.collection).filter((key) => normalizedQuery.includes(key))
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
  const constantCount = ordered.filter((match) => isAlwaysTriggered(match.resource)).length
  let keywordBudget = Math.max(0, maxResults - constantCount)
  return ordered.filter((match) => {
    if (isAlwaysTriggered(match.resource)) return true
    if (keywordBudget <= 0) return false
    keywordBudget -= 1
    return true
  })
}

/** Build sources from a Store while preserving the Store's collection order. */
export function retrieveStoreContext(store: Pick<Store, RetrievalCollection>, query: string, options?: RetrievalOptions): RetrievalMatch[] {
  const sources: RetrievalSource[] = []
  for (const collection of collections) {
    const resources = store[collection] ?? []
    resources.forEach((resource, sourceIndex) => sources.push({ collection, resource, sourceIndex }))
  }
  return retrieveContext(sources, query, options)
}

/** Compact prompt-ready representation used by Agent and正文生成 callers. */
/** Compact prompt-ready representation used by Agent and正文生成 callers. */
export function formatRetrievedContext(matches: RetrievalMatch[]): string {
  return matches.map((match) => {
    const fields = Object.entries(match.resource.fields)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')
    return `[${match.collection}] ${match.resource.title} (depth=${match.depth}, order=${sourceOrder(match)})\n${match.resource.summary}${fields ? `\n${fields}` : ''}`
  }).join('\n\n')
}
