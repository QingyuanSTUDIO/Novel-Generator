import type {
  AgentConversation,
  AgentMessage,
  Chapter,
  CustomModuleEntry,
  CustomModuleSchema,
  Resource,
  Store,
  WorldEngineCharacterState,
  WorldEngineEvent,
  WorldEngineRelationship,
  WorldEngineTimelineEntry,
  WorldEngineWorkNote,
} from '../types'

export type GlobalSearchCollection =
  | 'chapters'
  | 'world'
  | 'characters'
  | 'items'
  | 'skills'
  | 'outline'
  | 'worldEngine'
  | 'custom'
  | 'memes'
  | 'style'
  | 'agent'

type SearchCollectionLabel = Record<GlobalSearchCollection, string>

export const globalSearchCollectionLabels: SearchCollectionLabel = {
  chapters: '章节',
  world: '世界书',
  characters: '角色卡',
  items: '道具卡',
  skills: '技能卡',
  outline: '大纲',
  worldEngine: '世界引擎',
  custom: '自定义模块',
  memes: '网络热梗',
  style: '文风规则',
  agent: 'Agent 对话',
}

export type GlobalSearchDocument = {
  id: string
  projectId: string
  projectTitle: string
  collection: GlobalSearchCollection
  collectionLabel: string
  title: string
  text: string
  targetId?: string
  page?: string
  /** Optional human-readable location, such as volume or module name. */
  location?: string
}

export type GlobalSearchResult = GlobalSearchDocument & {
  snippet: string
  score: number
  matchCount: number
}

const collectionPages: Partial<Record<GlobalSearchCollection, string>> = {
  world: 'world',
  characters: 'characters',
  items: 'items',
  skills: 'skills',
  outline: 'outline',
  worldEngine: 'worldEngine',
  style: 'style',
  custom: 'custom',
  memes: 'memes',
}

function safeString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(safeString).filter(Boolean).join('、')
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${key}：${safeString(nested)}`)
      .filter((item) => item.trim() !== '')
      .join('；')
  }
  return ''
}

function resourceText(resource: Resource): string {
  return [
    resource.title,
    resource.tag,
    resource.summary,
    safeString(resource.fields),
    safeString(resource.holdingItems),
    safeString(resource.holdingSkills),
    safeString(resource.outlineType),
  ].filter(Boolean).join('\n')
}

function chapterText(chapter: Chapter, volumeTitle?: string): string {
  return [
    chapter.title,
    chapter.status,
    volumeTitle,
    chapter.taskGoal,
    safeString(chapter.cast),
    chapter.content,
  ].filter(Boolean).join('\n')
}

function addDocument(
  documents: GlobalSearchDocument[],
  projectId: string,
  projectTitle: string,
  collection: GlobalSearchCollection,
  title: string,
  text: string,
  options: Pick<GlobalSearchDocument, 'targetId' | 'page' | 'location'> = {},
) {
  const normalizedTitle = title.trim() || '未命名条目'
  const normalizedText = text.trim()
  if (!normalizedText) return
  documents.push({
    id: `${projectId}:${collection}:${options.targetId ?? normalizedTitle}:${documents.length}`,
    projectId,
    projectTitle,
    collection,
    collectionLabel: globalSearchCollectionLabels[collection],
    title: normalizedTitle,
    text: normalizedText,
    page: options.page ?? collectionPages[collection],
    targetId: options.targetId,
    location: options.location,
  })
}

function addResourceCollection(
  documents: GlobalSearchDocument[],
  projectId: string,
  projectTitle: string,
  collection: 'world' | 'characters' | 'items' | 'skills' | 'outline' | 'style',
  resources: readonly Resource[] | undefined,
) {
  for (const resource of resources ?? []) {
    addDocument(documents, projectId, projectTitle, collection, resource.title, resourceText(resource), { targetId: resource.id })
  }
}

function addWorldEngineDocuments(
  documents: GlobalSearchDocument[],
  projectId: string,
  projectTitle: string,
  store: Store,
) {
  const engine = store.worldEngine
  if (!engine) return
  const clock = engine.clock
  if (clock) {
    addDocument(documents, projectId, projectTitle, 'worldEngine', '世界时间', safeString(clock), { targetId: 'clock', location: '时钟' })
  }
  for (const character of engine.characterStates ?? [] as WorldEngineCharacterState[]) {
    addDocument(documents, projectId, projectTitle, 'worldEngine', character.name || character.id, safeString(character), { targetId: character.id, location: '后台角色' })
  }
  for (const relationship of engine.relationships ?? [] as WorldEngineRelationship[]) {
    addDocument(documents, projectId, projectTitle, 'worldEngine', relationship.label || relationship.id, safeString(relationship), { targetId: relationship.id, location: '角色关系' })
  }
  for (const event of engine.events ?? [] as WorldEngineEvent[]) {
    addDocument(documents, projectId, projectTitle, 'worldEngine', event.title || event.id, safeString(event), { targetId: event.id, location: '事件' })
  }
  for (const timeline of engine.timeline ?? [] as WorldEngineTimelineEntry[]) {
    addDocument(documents, projectId, projectTitle, 'worldEngine', timeline.title || timeline.id, safeString(timeline), { targetId: timeline.id, location: '时间线' })
  }
  for (const note of engine.workNotes ?? [] as WorldEngineWorkNote[]) {
    addDocument(documents, projectId, projectTitle, 'worldEngine', note.title || note.id, safeString(note), { targetId: note.id, location: '工作笔记' })
  }
  for (const log of engine.logs ?? []) {
    addDocument(documents, projectId, projectTitle, 'worldEngine', `推演记录 ${new Date(log.createdAt).toLocaleString()}`, safeString(log), { targetId: log.id, location: '推演记录' })
  }
}

function addCustomModuleDocuments(
  documents: GlobalSearchDocument[],
  projectId: string,
  projectTitle: string,
  schemas: readonly CustomModuleSchema[] | undefined,
  entries: readonly CustomModuleEntry[] | undefined,
) {
  const schemaById = new Map((schemas ?? []).map((schema) => [schema.id, schema]))
  for (const schema of schemas ?? []) {
    addDocument(documents, projectId, projectTitle, 'custom', schema.title, [schema.description, safeString(schema.fields)].filter(Boolean).join('\n'), { targetId: schema.id, location: '模块定义' })
  }
  for (const entry of entries ?? []) {
    const schema = schemaById.get(entry.schemaId)
    const title = entry.title || String(entry.data[schema?.titleField ?? ''] ?? `未命名${schema?.title ?? '条目'}`)
    addDocument(documents, projectId, projectTitle, 'custom', title, safeString(entry.data), { targetId: entry.id, location: schema?.title || '自定义条目' })
  }
}

function addMemeDocuments(documents: GlobalSearchDocument[], projectId: string, projectTitle: string, entries: Store['memes']['entries'] | undefined) {
  for (const meme of entries ?? []) {
    addDocument(documents, projectId, projectTitle, 'memes', meme.name, [meme.name, meme.explanation, meme.usage, safeString(meme.keywords), meme.source].filter(Boolean).join('\n'), { targetId: meme.id })
  }
}

function addAgentDocuments(documents: GlobalSearchDocument[], projectId: string, projectTitle: string, conversations?: readonly AgentConversation[], legacyMessages?: readonly AgentMessage[]) {
  const items = conversations?.length
    ? conversations
    : [{ id: 'legacy', title: 'Agent 历史对话', messages: legacyMessages ?? [], createdAt: 0, updatedAt: 0 }]
  for (const conversation of items) {
    const messages = (conversation.messages ?? []).map((message) => `${message.role}：${message.content}`).join('\n')
    addDocument(documents, projectId, projectTitle, 'agent', conversation.title, messages, { targetId: conversation.id, location: '对话' })
  }
}

/** Build a searchable, human-readable index from one project store. */
export function buildGlobalSearchDocuments(
  projectId: string,
  projectTitle: string,
  store: Store,
  options: { agentConversations?: readonly AgentConversation[]; agentMessages?: readonly AgentMessage[] } = {},
): GlobalSearchDocument[] {
  const documents: GlobalSearchDocument[] = []
  const volumeById = new Map((store.volumes ?? []).map((volume) => [volume.id, volume.title]))
  for (const chapter of store.chapters ?? []) {
    addDocument(documents, projectId, projectTitle, 'chapters', chapter.title, chapterText(chapter, volumeById.get(chapter.volumeId)), { targetId: chapter.id, page: 'writer', location: volumeById.get(chapter.volumeId) || '未分卷' })
  }
  addResourceCollection(documents, projectId, projectTitle, 'world', store.world)
  addResourceCollection(documents, projectId, projectTitle, 'characters', store.characters)
  addResourceCollection(documents, projectId, projectTitle, 'items', store.items)
  addResourceCollection(documents, projectId, projectTitle, 'skills', store.skills)
  addResourceCollection(documents, projectId, projectTitle, 'outline', store.outline)
  addResourceCollection(documents, projectId, projectTitle, 'style', store.style)
  addWorldEngineDocuments(documents, projectId, projectTitle, store)
  addCustomModuleDocuments(documents, projectId, projectTitle, store.customModules?.schemas, store.customModules?.entries)
  addMemeDocuments(documents, projectId, projectTitle, store.memes?.entries)
  addAgentDocuments(documents, projectId, projectTitle, options.agentConversations, options.agentMessages)
  return documents
}

function normalizeQuery(value: string): string[] {
  return value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
}

function snippetFor(text: string, terms: string[], maxLength = 180): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  if (!compact) return ''
  const lower = compact.toLocaleLowerCase()
  const hit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, Math.min(hit - 46, compact.length - maxLength))
  const snippet = compact.slice(start, start + maxLength)
  return `${start > 0 ? '…' : ''}${snippet}${start + maxLength < compact.length ? '…' : ''}`
}

/** Search all indexed fields and return stable relevance-sorted results. */
export function searchGlobalDocuments(documents: readonly GlobalSearchDocument[], query: string, limit = 80): GlobalSearchResult[] {
  const terms = normalizeQuery(query)
  if (!terms.length) return []
  return documents.map((document) => {
    const title = document.title.toLocaleLowerCase()
    const haystack = document.text.toLocaleLowerCase()
    let score = 0
    let matchCount = 0
    for (const term of terms) {
      const titleIndex = title.indexOf(term)
      const bodyIndex = haystack.indexOf(term)
      if (titleIndex < 0 && bodyIndex < 0) continue
      matchCount += 1
      score += titleIndex >= 0 ? 50 : 0
      score += bodyIndex >= 0 ? 10 : 0
      score += term.length * 0.2
    }
    return score > 0 ? { ...document, snippet: snippetFor(document.text, terms), score, matchCount } : null
  }).filter((result): result is GlobalSearchResult => Boolean(result))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-Hans'))
    .slice(0, Math.max(1, limit))
}
