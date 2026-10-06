import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { advanceWorldEngineClock, createDefaultWorldEngineState, formatWorldEngineContext, relationshipAllowed } from '../data/worldEngine.ts'
import { formatAgentDataBlock } from '../agent/dataBoundary.ts'
import { requestChat } from '../api/chat.ts'
import { readModelSettings } from '../api/modelSettings.ts'
import { prepareContextBudget } from '../api/contextBudget.ts'
import { withContextPreviewMessages, type ContextPreviewSnapshot } from '../context/contextPreview.ts'
import type { ChatMessage } from '../api/chat.ts'
import type {
  Chapter,
  Resource,
  Store,
  WorldEngineChangeKind,
  WorldEngineEvent,
  WorldEngineProposal,
  WorldEngineRelationship,
  WorldEngineState,
  WorldEngineTimeAdvanceMode,
  WorldEngineTimelineEntry,
  WorldEngineWorkNote,
} from '../types'

type WorldEngineModelChange = {
  kind: 'clock' | 'character' | 'relationship' | 'event' | 'timeline' | 'note'
  targetId?: string
  summary?: string
  patch?: Record<string, unknown>
  evidence?: string[]
}

type WorldEngineModelResponse = {
  reasoning?: string
  changes?: WorldEngineModelChange[]
}

const CHANGE_KINDS: readonly WorldEngineChangeKind[] = ['clock', 'character', 'relationship', 'event', 'timeline', 'note']
const MAX_PROPOSAL_CHANGES = 24
const MAX_PATCH_BYTES = 16_000
const MAX_TEXT_LENGTH = 2_000
const MAX_ARRAY_ITEMS = 32

function isChangeKind(value: unknown): value is WorldEngineChangeKind {
  return typeof value === 'string' && CHANGE_KINDS.includes(value as WorldEngineChangeKind)
}

function boundedString(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function boundedStringArray(value: unknown, maxItems = MAX_ARRAY_ITEMS, maxLength = 500): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
  return [...new Set(values)].slice(0, maxItems)
}

function patchRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Agent patches are deliberately allow-listed. This keeps model output from
 * changing ids, provenance, locks, timestamps, or fields added by a future
 * migration.
 */
function sanitizeChangePatch(kind: WorldEngineChangeKind, value: unknown): Record<string, unknown> {
  const source = patchRecord(value)
  const patch: Record<string, unknown> = {}
  const text = (key: string, max = MAX_TEXT_LENGTH) => {
    const result = boundedString(source[key], max)
    if (result !== undefined) patch[key] = result
  }
  const strings = (key: string, maxItems = MAX_ARRAY_ITEMS, maxLength = 500) => {
    const result = boundedStringArray(source[key], maxItems, maxLength)
    if (result !== undefined) patch[key] = result
  }
  const oneOf = (key: string, values: readonly string[]) => {
    if (typeof source[key] === 'string' && values.includes(source[key])) patch[key] = source[key]
  }

  if (kind === 'clock') {
    text('currentTime', 300)
    text('targetTime', 300)
    text('reason', 600)
    text('timeAdvanceReason', 600)
    text('label', 300)
    text('time', 300)
  } else if (kind === 'character') {
    text('characterId', 200)
    text('name', 200)
    oneOf('availability', ['interaction', 'cooldown', 'unseen'])
    text('location')
    text('activity')
    text('mood', 500)
    strings('goals')
    strings('knownFacts')
    text('nextAction')
    text('lastSeenChapterId', 200)
    if (typeof source.sceneProtected === 'boolean') patch.sceneProtected = source.sceneProtected
    strings('evidence')
  } else if (kind === 'relationship') {
    text('fromCharacterId', 200)
    text('toCharacterId', 200)
    text('label', 300)
    text('detail')
    oneOf('confidence', ['confirmed', 'inferred', 'uncertain'])
    strings('evidence')
  } else if (kind === 'event') {
    oneOf('kind', ['trend', 'event', 'action', 'discovery', 'consequence'])
    text('title', 300)
    text('summary')
    oneOf('status', ['planned', 'active', 'resolved', 'discarded'])
    strings('actorIds', 24, 200)
    text('scheduledTime', 300)
    text('chapterId', 200)
    strings('consequences')
    strings('evidence')
    oneOf('reviewStatus', ['pending', 'complete'])
  } else if (kind === 'timeline') {
    text('title', 300)
    text('summary')
    text('time', 300)
    text('chapterId', 200)
    strings('eventIds', 24, 200)
  } else if (kind === 'note') {
    text('title', 300)
    text('content')
    text('chapterId', 200)
  }
  return patch
}

function patchByteLength(patch: Record<string, unknown>): number {
  try {
    return new TextEncoder().encode(JSON.stringify(patch)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function isLocked(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { lockedAll?: unknown }).lockedAll === true)
}

type WorldEngineControllerOptions = {
  store: Ref<Store>
  activeChapter: ComputedRef<Chapter | undefined>
  effectiveCast: ComputedRef<string[]>
  provider: ComputedRef<Resource | undefined>
  isApiConfigured: (resource: Resource) => boolean
  retrieveContextText: (query: string, cast: string[]) => string
  retrieveContextPreview?: (query: string, cast: string[], provider?: Resource) => ContextPreviewSnapshot | null
  localApiUrl: (path: string) => string
  persist: () => void
}

export function useWorldEngineController(options: WorldEngineControllerOptions) {
  const worldEngine = computed<WorldEngineState>(() => options.store.value.worldEngine ?? createDefaultWorldEngineState())
  const busy = ref(false)
  const error = ref('')
  const contextPreview = ref<ContextPreviewSnapshot | null>(null)
  const contextBudget = ref<ReturnType<typeof prepareContextBudget>['report'] | null>(null)

  function resolveCharacterId(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const candidate = value.trim()
    return options.store.value.characters.find((item) => item.id === candidate || item.title === candidate)?.id
  }

  function resolveChapterId(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const chapterId = value.trim()
    const chapters = Array.isArray(options.store.value.chapters) ? options.store.value.chapters : []
    return chapters.some((chapter) => chapter.id === chapterId) ? chapterId : undefined
  }

  function resolveCharacterIds(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return [...new Set(value
      .map((item) => resolveCharacterId(item))
      .filter((item): item is string => Boolean(item)))]
  }

  function resolveEventIds(value: unknown, engine: WorldEngineState): string[] {
    if (!Array.isArray(value)) return []
    const known = new Set(engine.events.map((event) => event.id))
    return [...new Set(value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => known.has(item)))]
  }

  function proposalFromResponse(raw: WorldEngineModelResponse, chapterId?: string): WorldEngineProposal {
    const changes = (Array.isArray(raw.changes) ? raw.changes : [])
      .slice(0, MAX_PROPOSAL_CHANGES)
      .map((change, index) => {
        if (!change || typeof change !== 'object' || !isChangeKind(change.kind)) return null
        const patch = sanitizeChangePatch(change.kind, change.patch)
        if (patchByteLength(patch) > MAX_PATCH_BYTES) return null
        const targetId = boundedString(change.targetId, 200) || `${change.kind}-new-${index}`
        const summary = boundedString(change.summary, 600) || '待确认的世界状态变化'
        const evidence = boundedStringArray(change.evidence, 8, 500) ?? []
        return {
          id: `engine-change-${Date.now()}-${index}`,
          kind: change.kind,
          targetId,
          summary,
          patch,
          evidence,
        }
      })
      .filter((change): change is NonNullable<typeof change> => change !== null)
    return {
      id: `engine-proposal-${Date.now()}`,
      status: 'pending',
      sourceChapterId: chapterId,
      reasoning: raw.reasoning?.trim() || '依据当前章节、已命中资料和既有世界状态生成的增量推演。',
      changes,
      createdAt: Date.now(),
    }
  }

  function localProposal(): WorldEngineProposal {
    const chapter = options.activeChapter.value
    const cast = options.effectiveCast.value
    const firstCharacter = cast.map((name) => options.store.value.characters.find((item) => item.title === name)).find(Boolean)
    const eventTitle = chapter?.taskGoal?.trim() || `${chapter?.title ?? '当前章节'}后的世界反应`
    const changes: WorldEngineModelChange[] = [{
      kind: 'event',
      targetId: `event-${Date.now()}`,
      summary: '根据本章任务生成一项待推进的世界事件。',
      patch: { kind: 'consequence', title: eventTitle, summary: `本章正文已推进，相关势力可能围绕“${eventTitle}”采取行动。`, status: 'planned', chapterId: chapter?.id, consequences: ['等待下一轮正文确认实际结果'] },
      evidence: [chapter?.title || '当前章节'],
    }]
    if (firstCharacter) changes.push({
      kind: 'character',
      targetId: firstCharacter.id,
      summary: `${firstCharacter.title}的后台状态等待下一章确认。`,
      patch: { name: firstCharacter.title, characterId: firstCharacter.id, availability: 'interaction', activity: '完成本章行动后的短暂观察期', nextAction: '根据下一章正文更新', lastSeenChapterId: chapter?.id, sceneProtected: true },
      evidence: [chapter?.title || '当前章节'],
    })
    return proposalFromResponse({ reasoning: '当前未配置可用模型，已生成一份保守的本地推演提案，仅供审阅。', changes }, chapter?.id)
  }

  async function requestProposal(): Promise<WorldEngineProposal> {
    const provider = options.provider.value
    if (!provider || !options.isApiConfigured(provider)) return localProposal()
    const chapter = options.activeChapter.value
    const contextText = options.retrieveContextText(`${chapter?.content ?? ''} ${chapter?.taskGoal ?? ''}`, options.effectiveCast.value)
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['reasoning', 'changes'],
      properties: {
        reasoning: { type: 'string' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'summary', 'patch', 'evidence'],
            properties: {
              kind: { enum: ['clock', 'character', 'relationship', 'event', 'timeline', 'note'] },
              targetId: { type: 'string' },
              summary: { type: 'string' },
              patch: {
                type: 'object',
                description: 'clock 变化可使用 currentTime 或 targetTime，以及 reason；其他类型只填写对应条目的允许字段。',
                properties: {
                  currentTime: { type: 'string' },
                  targetTime: { type: 'string' },
                  reason: { type: 'string' },
                  label: { type: 'string' },
                  time: { type: 'string' },
                },
              },
              evidence: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    }
    const engine = options.store.value.worldEngine ?? createDefaultWorldEngineState()
    const mode = engine.clock.timeAdvanceMode
    const modeLabel = mode === 'custom'
      ? `自定义推进 ${engine.clock.customDays ?? 0} 天`
      : mode === 'current'
        ? '保持当前时间，不推进'
        : mode === 'chapter'
          ? '推进一章'
          : mode === 'day'
            ? '推进一天'
            : '推进一月'
    const requestMessages: ChatMessage[] = [
      { role: 'system', content: `你是小说世界引擎。根据当前章节正文、智能检索资料（其中包含与当前章节相关的大纲条目）和已确认的世界状态，推演正文之外的后台角色行动、天下大势、事件后果、关系变化，以及大纲目标的推进或偏离。大纲是剧情计划来源；不要把大纲复制成新的世界引擎条目，也不要新建协议中没有定义的资源。关系变化只记录主角与配角之间，路人角色不建立关系。当前正文出现的角色受现场保护，不要重复编造他们正在现场做的事。不要新写角色卡、道具卡、世界书或大纲事实；所有猜测都返回为待确认变化提案。只返回 JSON，不要 Markdown。JSON 必须符合：${JSON.stringify(schema)}\n\n本轮叙事时间推进方式由作者预先选择：${modeLabel}。当前模式为“保持当前时间”时，绝对不要提出改变时间的 clock 变化；其他模式不要按现实钟表换算推进，也不要自行改写 customDays。按章表示推演到下一章结束后的叙事时间，按天表示一天，按月表示一个月，自定义天数表示系统给出的天数。若能根据小说自定义历法可靠推导目标时间，可在 clock.patch.targetTime 返回目标时间；无法可靠计算时省略 targetTime，由系统保留推进跨度。clock.patch.reason 用一句话说明时间推进原因。` },
      { role: 'user', content: `当前章节：\n${formatAgentDataBlock('world-engine-current-chapter', chapter ? { id: chapter.id, title: chapter.title, taskGoal: chapter.taskGoal, cast: chapter.cast, content: chapter.content } : null)}\n\n已确认世界引擎状态：\n${formatAgentDataBlock('world-engine-confirmed-state', formatWorldEngineContext(options.store.value.worldEngine) || '暂无')}\n\n本轮智能检索资料（大纲由这里提供）：\n${contextText || '暂无'}\n\n请只返回有依据的增量变化；没有把握的内容不要提出。` },
    ]
    const preview = options.retrieveContextPreview?.(`${chapter?.content ?? ''} ${chapter?.taskGoal ?? ''}`, options.effectiveCast.value, provider)
    if (preview) {
      try {
        contextBudget.value = prepareContextBudget(requestMessages, readModelSettings(provider)).report
      } catch {
        contextBudget.value = null
      }
      contextPreview.value = withContextPreviewMessages(preview, requestMessages, contextBudget.value)
    } else {
      contextPreview.value = null
      contextBudget.value = null
    }
    const text = await requestChat(options.localApiUrl, {
        ...readModelSettings(provider),
        providerId: provider.id,
        purpose: 'worldEngine',
        baseUrl: provider.fields['接口地址'], apiKey: provider.fields['API Key'], protocol: provider.fields['协议'] ?? 'OpenAI Compatible', model: provider.fields['模型'], responseFormat: 'json_object',
        useProxy: provider.fields['使用代理'] === 'true', proxyHost: provider.fields['代理地址'] ?? '', proxyPort: provider.fields['代理端口'] ?? '',
        stream: provider.fields['流式输出'] !== 'false',
        messages: requestMessages,
      })
    // Streaming is transport-only: fragments never become world state or a
    // proposal. Wait for a successful completion and validate the full JSON.
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    let raw: unknown
    try { raw = JSON.parse(clean) } catch { throw new Error('世界引擎返回的内容不是有效 JSON') }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof (raw as WorldEngineModelResponse).reasoning !== 'string'
      || !Array.isArray((raw as WorldEngineModelResponse).changes)) {
      throw new Error('世界引擎 JSON 结构无效，需要 reasoning 文字和 changes 数组')
    }
    const result = raw as WorldEngineModelResponse
    return proposalFromResponse(result, chapter?.id)
  }

  async function run() {
    if (busy.value) return
    const engine = options.store.value.worldEngine ?? (options.store.value.worldEngine = createDefaultWorldEngineState())
    busy.value = true
    error.value = ''
    engine.status = 'running'
    try {
      const proposal = await requestProposal()
      if (!proposal.changes.length) throw new Error('本轮没有发现可供审阅的世界变化')
      engine.pendingProposals = [proposal, ...engine.pendingProposals.filter((item) => item.status === 'pending')]
      engine.status = 'awaiting-review'
      engine.logs.unshift({ id: `engine-log-${Date.now()}`, chapterId: options.activeChapter.value?.id, prompt: options.activeChapter.value?.content ?? '', response: JSON.stringify(proposal), status: 'success', createdAt: Date.now() })
      engine.logs = engine.logs.slice(0, 30)
      engine.updatedAt = Date.now()
      options.persist()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '世界引擎推演失败'
      error.value = message
      engine.status = 'error'
      engine.logs.unshift({ id: `engine-log-${Date.now()}`, chapterId: options.activeChapter.value?.id, prompt: options.activeChapter.value?.content ?? '', response: '', status: 'error', error: message, createdAt: Date.now() })
      engine.logs = engine.logs.slice(0, 30)
      engine.updatedAt = Date.now()
      options.persist()
    } finally {
      busy.value = false
    }
  }

  function updateClock(value: string) {
    const engine = options.store.value.worldEngine ?? (options.store.value.worldEngine = createDefaultWorldEngineState())
    const label = value.trim()
    if (!label) return
    const updatedAt = Date.now()
    /*
     * Keep the legacy `label` alias and the canonical `currentTime` in sync.
     * This is a manual clock edit, so it must not silently change the selected
     * progression mode.
     */
    engine.clock = {
      ...engine.clock,
      label,
      currentTime: label,
      chapterId: options.activeChapter.value?.id,
      revision: engine.clock.revision + 1,
      updatedAt,
    }
    engine.updatedAt = updatedAt
    options.persist()
  }

  function updateTimeSpan(mode: WorldEngineTimeAdvanceMode, customDays?: number) {
    const engine = options.store.value.worldEngine ?? (options.store.value.worldEngine = createDefaultWorldEngineState())
    const validModes: WorldEngineTimeAdvanceMode[] = ['current', 'chapter', 'day', 'month', 'custom']
    const normalizedMode = validModes.includes(mode) ? mode : 'current'
    const normalizedDays = typeof customDays === 'number' && Number.isFinite(customDays) && customDays > 0
      ? Math.floor(customDays)
      : undefined
    if (normalizedMode === 'custom' && !normalizedDays) return
    const updatedAt = Date.now()
    /*
     * Selecting a span configures the next confirmed run. It must not advance
     * the story clock or create a timeline revision before the proposal is
     * actually approved.
     */
    engine.clock = {
      ...engine.clock,
      timeAdvanceMode: normalizedMode,
      ...(normalizedMode === 'custom' && normalizedDays
        ? { customDays: normalizedDays }
        : { customDays: undefined }),
      /*
       * These fields describe the most recently confirmed run. Once the
       * author chooses a new span they are no longer a valid estimate for the
       * next run, so clear them until a proposal is approved.
       */
      targetTime: undefined,
      timeAdvanceReason: undefined,
      updatedAt,
    }
    engine.updatedAt = updatedAt
    options.persist()
  }

  function addEvent(title: string) {
    const engine = options.store.value.worldEngine ?? (options.store.value.worldEngine = createDefaultWorldEngineState())
    const event: WorldEngineEvent = { id: `engine-event-${Date.now()}`, kind: 'event', title: title.trim(), summary: '作者手动添加的待推进事件。', status: 'planned', actorIds: [], chapterId: options.activeChapter.value?.id, consequences: [], evidence: [], creationSource: 'manual', reviewStatus: 'pending', reviewStatusLocked: false, lockedAll: false, updatedAt: Date.now() }
    if (!event.title) return
    engine.events.unshift(event)
    engine.updatedAt = Date.now()
    options.persist()
  }

  function updateEventReviewStatus(id: string, status: 'pending' | 'complete') {
    const engine = options.store.value.worldEngine
    const event = engine?.events.find((item) => item.id === id)
    if (!engine || !event) return
    event.reviewStatus = status
    event.updatedAt = Date.now()
    engine.updatedAt = Date.now()
    options.persist()
  }

  function toggleEventReviewStatusLock(id: string, locked: boolean) {
    const engine = options.store.value.worldEngine
    const event = engine?.events.find((item) => item.id === id)
    if (!engine || !event || event.lockedAll) return
    event.reviewStatusLocked = locked
    event.updatedAt = Date.now()
    engine.updatedAt = Date.now()
    options.persist()
  }

  function toggleEventLockAll(id: string, locked: boolean) {
    const engine = options.store.value.worldEngine
    const event = engine?.events.find((item) => item.id === id)
    if (!engine || !event) return
    if (locked) {
      if (event.lockedAll !== true) event.reviewStatusLockedBeforeAll = event.reviewStatusLocked === true
      event.lockedAll = true
      event.reviewStatusLocked = true
    } else {
      event.lockedAll = false
      event.reviewStatusLocked = event.reviewStatusLockedBeforeAll === true
      delete event.reviewStatusLockedBeforeAll
    }
    event.updatedAt = Date.now()
    engine.updatedAt = Date.now()
    options.persist()
  }

  function applyClockChange(patchValue?: Record<string, unknown>) {
    const engine = options.store.value.worldEngine ?? (options.store.value.worldEngine = createDefaultWorldEngineState())
    const patch = sanitizeChangePatch('clock', patchValue)
    const selectedMode = engine.clock.timeAdvanceMode
    const targetTime = typeof patch.targetTime === 'string'
      ? patch.targetTime
      : typeof patch.currentTime === 'string'
        ? patch.currentTime
        : typeof patch.label === 'string'
          ? patch.label
          : typeof patch.time === 'string'
            ? patch.time
            : undefined
    const reason = typeof patch.reason === 'string'
      ? patch.reason
      : typeof patch.timeAdvanceReason === 'string'
        ? patch.timeAdvanceReason
        : undefined
    const updatedAt = Date.now()
    engine.clock = advanceWorldEngineClock(engine.clock, {
      mode: selectedMode,
      customDays: engine.clock.customDays,
      targetTime,
      reason,
      chapterId: options.activeChapter.value?.id,
    }, updatedAt)
    engine.updatedAt = updatedAt
  }

  function applyChange(change: WorldEngineProposal['changes'][number]) {
    const engine = options.store.value.worldEngine ?? (options.store.value.worldEngine = createDefaultWorldEngineState())
    const patch = sanitizeChangePatch(change.kind, change.patch)
    if (patchByteLength(patch) > MAX_PATCH_BYTES) return
    if (change.kind === 'clock') {
      applyClockChange(patch)
      return
    }
    const updatedAt = Date.now()
    if (change.kind === 'character') {
      const current = engine.characterStates.find((item) => item.id === change.targetId || item.characterId === change.targetId || item.name === change.targetId)
      if (current) {
        if (isLocked(current)) return
        if (Object.prototype.hasOwnProperty.call(patch, 'characterId')) {
          patch.characterId = resolveCharacterId(patch.characterId)
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastSeenChapterId')) {
          patch.lastSeenChapterId = resolveChapterId(patch.lastSeenChapterId)
        }
        Object.assign(current, patch, { id: current.id, updatedAt })
      } else {
        const availability = ['interaction', 'cooldown', 'unseen'].includes(String(patch.availability))
          ? patch.availability as WorldEngineState['characterStates'][number]['availability']
          : 'unseen'
        engine.characterStates.unshift({
          id: change.targetId,
          characterId: resolveCharacterId(patch.characterId),
          name: String(patch.name ?? '未命名角色'),
          availability,
          location: String(patch.location ?? ''),
          activity: String(patch.activity ?? ''),
          mood: String(patch.mood ?? ''),
          goals: Array.isArray(patch.goals) ? patch.goals as string[] : [],
          knownFacts: Array.isArray(patch.knownFacts) ? patch.knownFacts as string[] : [],
          nextAction: typeof patch.nextAction === 'string' ? patch.nextAction : undefined,
          lastSeenChapterId: resolveChapterId(patch.lastSeenChapterId) ?? options.activeChapter.value?.id,
          sceneProtected: patch.sceneProtected === true,
          updatedAt,
          evidence: Array.isArray(patch.evidence) ? patch.evidence as string[] : change.evidence,
        })
      }
      return
    }
    if (change.kind === 'relationship') {
      const existingRelationship = engine.relationships.find((item) => item.id === change.targetId)
      const fromCharacterId = resolveCharacterId(patch.fromCharacterId ?? existingRelationship?.fromCharacterId)
        ?? (existingRelationship?.fromCharacterId && options.store.value.characters.length === 0 ? existingRelationship.fromCharacterId : '')
      const toCharacterId = resolveCharacterId(patch.toCharacterId ?? existingRelationship?.toCharacterId)
        ?? (existingRelationship?.toCharacterId && options.store.value.characters.length === 0 ? existingRelationship.toCharacterId : '')
      if (!relationshipAllowed(fromCharacterId, toCharacterId, options.store.value.characters)) return
      if (existingRelationship) {
        if (isLocked(existingRelationship)) return
        Object.assign(existingRelationship, patch, {
          id: existingRelationship.id,
          fromCharacterId,
          toCharacterId,
          updatedAt,
        })
        return
      }
      const label = String(patch.label ?? change.summary).trim()
      if (!label) return
      engine.relationships.unshift({
        id: change.targetId,
        fromCharacterId,
        toCharacterId,
        label,
        detail: typeof patch.detail === 'string' ? patch.detail : undefined,
        confidence: ['confirmed', 'inferred', 'uncertain'].includes(String(patch.confidence))
          ? patch.confidence as WorldEngineRelationship['confidence']
          : 'uncertain',
        evidence: Array.isArray(patch.evidence) ? patch.evidence as string[] : change.evidence,
        updatedAt,
      })
      return
    }
    if (change.kind === 'event') {
      const currentEvent = engine.events.find((item) => item.id === change.targetId)
      if (currentEvent?.lockedAll) return
      if (currentEvent) {
        const editablePatch = { ...patch }
        if (Object.prototype.hasOwnProperty.call(editablePatch, 'actorIds')) {
          editablePatch.actorIds = resolveCharacterIds(editablePatch.actorIds)
        }
        if (Object.prototype.hasOwnProperty.call(editablePatch, 'chapterId')) {
          editablePatch.chapterId = resolveChapterId(editablePatch.chapterId)
        }
        const proposedReviewStatus = editablePatch.reviewStatus
        if (currentEvent.reviewStatusLocked) delete editablePatch.reviewStatus
        if (!currentEvent.reviewStatusLocked && (proposedReviewStatus === 'pending' || proposedReviewStatus === 'complete')) {
          editablePatch.reviewStatus = proposedReviewStatus
        }
        Object.assign(currentEvent, editablePatch, {
          id: currentEvent.id,
          creationSource: currentEvent.creationSource ?? 'manual',
          reviewStatus: currentEvent.reviewStatus ?? 'pending',
          reviewStatusLocked: currentEvent.reviewStatusLocked ?? false,
          lockedAll: currentEvent.lockedAll ?? false,
          updatedAt,
        })
        return
      }
      const kind = ['trend', 'event', 'action', 'discovery', 'consequence'].includes(String(patch.kind)) ? patch.kind as WorldEngineEvent['kind'] : 'event'
      engine.events.unshift({
        id: change.targetId,
        kind,
        title: String(patch.title ?? change.summary),
        summary: String(patch.summary ?? change.summary),
        status: ['planned', 'active', 'resolved', 'discarded'].includes(String(patch.status)) ? patch.status as WorldEngineEvent['status'] : 'planned',
        actorIds: resolveCharacterIds(patch.actorIds),
        scheduledTime: typeof patch.scheduledTime === 'string' ? patch.scheduledTime : undefined,
        chapterId: resolveChapterId(patch.chapterId) ?? options.activeChapter.value?.id,
        consequences: Array.isArray(patch.consequences) ? patch.consequences.filter((item): item is string => typeof item === 'string') : [],
        evidence: Array.isArray(patch.evidence) ? patch.evidence as string[] : change.evidence,
        creationSource: 'agent',
        reviewStatus: 'pending',
        reviewStatusLocked: false,
        lockedAll: false,
        updatedAt,
      })
      return
    }
    if (change.kind === 'timeline') {
      const current = engine.timeline.find((item) => item.id === change.targetId)
      if (current) {
        if (isLocked(current)) return
        if (Object.prototype.hasOwnProperty.call(patch, 'chapterId')) {
          patch.chapterId = resolveChapterId(patch.chapterId)
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'eventIds')) {
          patch.eventIds = resolveEventIds(patch.eventIds, engine)
        }
        Object.assign(current, patch, { id: current.id, source: current.source, createdAt: current.createdAt, updatedAt })
      } else {
        engine.timeline.unshift({
          id: change.targetId,
          title: String(patch.title ?? change.summary),
          summary: String(patch.summary ?? change.summary),
          time: String(patch.time ?? engine.clock.label),
          chapterId: resolveChapterId(patch.chapterId) ?? options.activeChapter.value?.id,
          source: 'engine',
          eventIds: resolveEventIds(patch.eventIds, engine),
          createdAt: updatedAt,
        })
      }
      return
    }
    if (change.kind === 'note') {
      const current = engine.workNotes.find((item) => item.id === change.targetId)
      if (current) {
        if (isLocked(current)) return
        Object.assign(current, patch, { id: current.id, createdAt: current.createdAt })
      } else {
        engine.workNotes.unshift({
          id: change.targetId,
          title: String(patch.title ?? '世界引擎工作小结'),
          content: String(patch.content ?? change.summary),
          chapterId: options.activeChapter.value?.id,
          createdAt: updatedAt,
        })
      }
    }
  }

  function approveProposal(id: string, selectedChangeIds?: string[]) {
    const engine = options.store.value.worldEngine
    const proposal = engine?.pendingProposals.find((item) => item.id === id && item.status === 'pending')
    if (!engine || !proposal) return
    const selected = selectedChangeIds === undefined
      ? [...proposal.changes]
      : proposal.changes.filter((change) => selectedChangeIds.includes(change.id))
    // The panel disables the action when no change is selected, but keep the
    // controller safe for CLI and older callers that may pass an empty list.
    if (!selected.length) return
    const selectedSet = new Set(selected.map((change) => change.id))
    const clockChange = selected.find((change) => change.kind === 'clock')
    selected.filter((change) => change.kind !== 'clock').forEach(applyChange)
    /*
     * Narrative time is an explicit proposal change. Approving an event,
     * character update, or note must not silently advance the clock merely
     * because the author selected a default span for a future run. The clock
     * is updated only when this proposal contains its own reviewed `clock`
     * change; a missing clock change leaves both the time label and revision
     * untouched.
     */
    if (clockChange) applyClockChange(clockChange.patch)
    const remaining = proposal.changes.filter((change) => !selectedSet.has(change.id))
    const decidedAt = Date.now()
    engine.timeline.unshift({
      id: `engine-timeline-${decidedAt}`,
      title: options.activeChapter.value?.title ?? '当前章节',
      summary: proposal.reasoning,
      time: engine.clock.label,
      chapterId: proposal.sourceChapterId,
      source: 'engine',
      eventIds: selected.filter((change) => change.kind === 'event').map((change) => change.targetId),
      createdAt: decidedAt,
    })
    if (remaining.length) {
      // Partial approval keeps the unselected changes available for a later
      // review instead of silently discarding them.
      proposal.changes = remaining
      proposal.decidedAt = undefined
      engine.status = 'awaiting-review'
    } else {
      proposal.status = 'accepted'
      proposal.decidedAt = decidedAt
      engine.lastProcessedChapterId = proposal.sourceChapterId
      engine.status = 'idle'
    }
    engine.updatedAt = Date.now()
    options.persist()
  }

  function rejectProposal(id: string) {
    const engine = options.store.value.worldEngine
    const proposal = engine?.pendingProposals.find((item) => item.id === id && item.status === 'pending')
    if (!engine || !proposal) return
    proposal.status = 'rejected'
    proposal.decidedAt = Date.now()
    engine.status = 'idle'
    engine.updatedAt = Date.now()
    options.persist()
  }

  return { worldEngine, busy, error, contextPreview, contextBudget, run, updateClock, updateTimeSpan, addEvent, updateEventReviewStatus, toggleEventReviewStatusLock, toggleEventLockAll, approveProposal, rejectProposal }
}
