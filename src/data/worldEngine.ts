import type {
  Resource,
  WorldEngineCharacterAvailability,
  WorldEngineCharacterState,
  WorldEngineChangeKind,
  WorldEngineEvent,
  WorldEngineEventKind,
  WorldEngineEventStatus,
  WorldEngineLogEntry,
  WorldEngineProposal,
  WorldEngineProposalStatus,
  WorldEngineRelationship,
  WorldEngineState,
  WorldEngineTimeAdvanceMode,
  WorldEngineClock,
  WorldEngineTimelineEntry,
  WorldEngineWorkNote,
} from '../types'

export const worldEngineSchemaVersion = 3

export const WORLD_ENGINE_TIME_ADVANCE_MODES: readonly WorldEngineTimeAdvanceMode[] = [
  'current',
  'chapter',
  'day',
  'month',
  'custom',
]

export const WORLD_ENGINE_TIME_ADVANCE_MODE_LABELS: Record<WorldEngineTimeAdvanceMode, string> = {
  current: '保持当前时间',
  chapter: '推进一章',
  day: '推进一天',
  month: '推进一月',
  custom: '自定义天数',
}

export function worldEngineTimeAdvanceModeLabel(mode: WorldEngineTimeAdvanceMode | string | undefined): string {
  return mode && mode in WORLD_ENGINE_TIME_ADVANCE_MODE_LABELS
    ? WORLD_ENGINE_TIME_ADVANCE_MODE_LABELS[mode as WorldEngineTimeAdvanceMode]
    : WORLD_ENGINE_TIME_ADVANCE_MODE_LABELS.current
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const integer = Math.floor(value)
  return integer > 0 ? integer : undefined
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Relationships are only meaningful for named protagonists and supporting
 * characters. Keep unknown ids eligible so old engine snapshots that predate
 * role metadata are not silently destroyed during migration.
 */
export function relationshipParticipantAllowed(characterId: string, characters: Resource[] = []): boolean {
  if (!characters.length) return true
  const character = characters.find((item) => item.id === characterId || item.title === characterId)
  if (!character) return true
  const role = `${character.fields?.['角色身份'] ?? ''} ${character.tag ?? ''}`.trim()
  if (!role) return true
  return /(主角|配角)/.test(role) && !/路人/.test(role)
}

export function relationshipAllowed(fromCharacterId: string, toCharacterId: string, characters: Resource[] = []): boolean {
  return Boolean(fromCharacterId && toCharacterId)
    && relationshipParticipantAllowed(fromCharacterId, characters)
    && relationshipParticipantAllowed(toCharacterId, characters)
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback
}

export function createDefaultWorldEngineState(updatedAt = Date.now()): WorldEngineState {
  return {
    schemaVersion: worldEngineSchemaVersion,
    enabled: true,
    status: 'idle',
    clock: {
      label: '未设定',
      currentTime: '未设定',
      timeAdvanceMode: 'current',
      revision: 0,
      updatedAt,
    },
    characterStates: [],
    relationships: [],
    events: [],
    timeline: [],
    workNotes: [],
    pendingProposals: [],
    logs: [],
    updatedAt,
  }
}

/**
 * Normalize the clock independently from the rest of the engine state.
 *
 * `label` is retained as a compatibility/display alias, while `currentTime`
 * is the canonical value used by new code. The old string-only clock shape is
 * accepted so a project opened after an upgrade does not lose its story time.
 */
export function normalizeWorldEngineClock(value: unknown, updatedAt = Date.now()): WorldEngineClock {
  const source = record(value)
  const legacyLabel = stringValue(source.label)
  const currentTime = stringValue(source.currentTime, legacyLabel || '未设定')
  const label = stringValue(source.label, currentTime)
  const rawMode = source.timeAdvanceMode === 'none' ? 'current' : source.timeAdvanceMode
  const timeAdvanceMode = oneOf<WorldEngineTimeAdvanceMode>(
    rawMode,
    WORLD_ENGINE_TIME_ADVANCE_MODES,
    'current',
  )
  const targetTime = stringValue(source.targetTime) || undefined
  const customDays = positiveInteger(source.customDays)
  return {
    label: label || currentTime,
    calendar: stringValue(source.calendar) || undefined,
    previousTime: stringValue(source.previousTime) || undefined,
    currentTime: currentTime || '未设定',
    timeAdvanceMode,
    ...(targetTime ? { targetTime } : {}),
    ...(customDays ? { customDays } : {}),
    timeAdvanceReason: stringValue(source.timeAdvanceReason) || undefined,
    chapterId: stringValue(source.chapterId) || undefined,
    revision: Math.max(0, Math.floor(numberValue(source.revision, 0))),
    updatedAt: numberValue(source.updatedAt, updatedAt),
  }
}

export type WorldEngineTimeAdvanceInput = {
  mode?: WorldEngineTimeAdvanceMode | string
  /** A whole number of narrative days, only used by `custom` mode. */
  customDays?: number
  /** Optional textual target in a fictional calendar. */
  targetTime?: string
  /** Human-readable explanation for the proposed/confirmed advance. */
  reason?: string
  chapterId?: string
}

/**
 * Apply an author's confirmed narrative-time decision.
 *
 * The engine cannot safely add "one day" to arbitrary fictional labels, so
 * chapter/day/month modes record the chosen span while keeping the current
 * label unless the caller supplies `targetTime`. This makes the span explicit
 * without inventing a calendar conversion.
 */
export function advanceWorldEngineClock(
  value: WorldEngineClock | unknown,
  input: WorldEngineTimeAdvanceInput = {},
  updatedAt = Date.now(),
): WorldEngineClock {
  const previous = normalizeWorldEngineClock(value, updatedAt)
  const rawMode = input.mode === 'none' ? 'current' : input.mode
  const mode = oneOf<WorldEngineTimeAdvanceMode>(
    rawMode,
    WORLD_ENGINE_TIME_ADVANCE_MODES,
    'current',
  )
  /*
   * "current" is an explicit no-op for narrative time. A model must not be
   * able to smuggle a new clock label into a run whose selected span says to
   * keep the current time.
   */
  const targetTime = mode === 'current'
    ? undefined
    : typeof input.targetTime === 'string' && input.targetTime.trim()
      ? input.targetTime.trim()
      : undefined
  const customDays = mode === 'custom' ? positiveInteger(input.customDays) : undefined
  const nextTime = targetTime || previous.currentTime
  const changedTime = nextTime !== previous.currentTime
  const next: WorldEngineClock = {
    ...previous,
    label: nextTime,
    currentTime: nextTime,
    previousTime: changedTime ? previous.currentTime : previous.previousTime,
    timeAdvanceMode: mode,
    ...(targetTime ? { targetTime } : { targetTime: undefined }),
    ...(customDays ? { customDays } : { customDays: undefined }),
    timeAdvanceReason: typeof input.reason === 'string' && input.reason.trim()
      ? input.reason.trim()
      : undefined,
    chapterId: typeof input.chapterId === 'string' && input.chapterId.trim()
      ? input.chapterId.trim()
      : previous.chapterId,
    revision: previous.revision + 1,
    updatedAt,
  }
  return next
}

/** Alias used at persistence/controller boundaries. */
export const updateWorldEngineClock = advanceWorldEngineClock

function normalizeCharacterState(value: unknown, updatedAt: number): WorldEngineCharacterState | null {
  const item = record(value)
  const id = stringValue(item.id)
  const name = stringValue(item.name)
  if (!id || !name) return null
  return {
    id,
    characterId: stringValue(item.characterId) || undefined,
    name,
    availability: oneOf<WorldEngineCharacterAvailability>(item.availability, ['interaction', 'cooldown', 'unseen'], 'unseen'),
    location: stringValue(item.location),
    activity: stringValue(item.activity),
    mood: stringValue(item.mood),
    goals: stringArray(item.goals),
    knownFacts: stringArray(item.knownFacts),
    nextAction: stringValue(item.nextAction) || undefined,
    lastSeenChapterId: stringValue(item.lastSeenChapterId) || undefined,
    sceneProtected: booleanValue(item.sceneProtected, false),
    updatedAt: numberValue(item.updatedAt, updatedAt),
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : undefined,
    evidence: stringArray(item.evidence),
  }
}

function normalizeRelationship(value: unknown, updatedAt: number): WorldEngineRelationship | null {
  const item = record(value)
  const id = stringValue(item.id)
  const fromCharacterId = stringValue(item.fromCharacterId)
  const toCharacterId = stringValue(item.toCharacterId)
  const label = stringValue(item.label)
  if (!id || !fromCharacterId || !toCharacterId || !label) return null
  return {
    id,
    fromCharacterId,
    toCharacterId,
    label,
    detail: stringValue(item.detail) || undefined,
    confidence: oneOf(item.confidence, ['confirmed', 'inferred', 'uncertain'] as const, 'uncertain'),
    evidence: stringArray(item.evidence),
    updatedAt: numberValue(item.updatedAt, updatedAt),
  }
}

function normalizeEvent(value: unknown, updatedAt: number): WorldEngineEvent | null {
  const item = record(value)
  const id = stringValue(item.id)
  const title = stringValue(item.title)
  if (!id || !title) return null
  return {
    id,
    kind: oneOf<WorldEngineEventKind>(item.kind, ['trend', 'event', 'action', 'discovery', 'consequence'], 'event'),
    title,
    summary: stringValue(item.summary),
    status: oneOf<WorldEngineEventStatus>(item.status, ['planned', 'active', 'resolved', 'discarded'], 'planned'),
    actorIds: stringArray(item.actorIds),
    scheduledTime: stringValue(item.scheduledTime) || undefined,
    chapterId: stringValue(item.chapterId) || undefined,
    consequences: stringArray(item.consequences),
    evidence: stringArray(item.evidence),
    creationSource: oneOf(item.creationSource, ['agent', 'manual'] as const, 'manual'),
    reviewStatus: oneOf(item.reviewStatus, ['pending', 'complete'] as const, 'pending'),
    reviewStatusLocked: item.lockedAll === true || booleanValue(item.reviewStatusLocked, false),
    ...(typeof item.reviewStatusLockedBeforeAll === 'boolean'
      ? { reviewStatusLockedBeforeAll: item.reviewStatusLockedBeforeAll }
      : {}),
    lockedAll: booleanValue(item.lockedAll, false),
    updatedAt: numberValue(item.updatedAt, updatedAt),
  }
}

function normalizeTimelineEntry(value: unknown, createdAt: number): WorldEngineTimelineEntry | null {
  const item = record(value)
  const id = stringValue(item.id)
  const title = stringValue(item.title)
  if (!id || !title) return null
  return {
    id,
    title,
    summary: stringValue(item.summary),
    time: stringValue(item.time, '未设定'),
    chapterId: stringValue(item.chapterId) || undefined,
    source: oneOf(item.source, ['chapter', 'engine', 'author'] as const, 'engine'),
    eventIds: stringArray(item.eventIds),
    createdAt: numberValue(item.createdAt, createdAt),
  }
}

function normalizeWorkNote(value: unknown, createdAt: number): WorldEngineWorkNote | null {
  const item = record(value)
  const id = stringValue(item.id)
  const title = stringValue(item.title)
  if (!id || !title) return null
  return {
    id,
    title,
    content: stringValue(item.content),
    chapterId: stringValue(item.chapterId) || undefined,
    createdAt: numberValue(item.createdAt, createdAt),
  }
}

function normalizeProposal(value: unknown, createdAt: number): WorldEngineProposal | null {
  const item = record(value)
  const id = stringValue(item.id)
  if (!id) return null
  const changes = Array.isArray(item.changes)
    ? item.changes.map((change) => {
      const data = record(change)
      const targetId = stringValue(data.targetId)
      const kindValue = data.kind
      const allowedKinds: readonly WorldEngineChangeKind[] = ['clock', 'character', 'relationship', 'event', 'timeline', 'note']
      if (typeof kindValue !== 'string' || !allowedKinds.includes(kindValue as WorldEngineChangeKind)) return null
      const kind = kindValue as WorldEngineChangeKind
      if (!targetId) return null
      return {
        id: stringValue(data.id, `${id}-change-${targetId}`),
        kind,
        targetId,
        summary: stringValue(data.summary),
        patch: record(data.patch),
        evidence: stringArray(data.evidence),
      }
    }).filter((change): change is WorldEngineProposal['changes'][number] => change !== null)
    : []
  return {
    id,
    status: oneOf<WorldEngineProposalStatus>(item.status, ['pending', 'accepted', 'rejected'], 'pending'),
    sourceChapterId: stringValue(item.sourceChapterId) || undefined,
    reasoning: stringValue(item.reasoning),
    changes,
    createdAt: numberValue(item.createdAt, createdAt),
    decidedAt: typeof item.decidedAt === 'number' ? item.decidedAt : undefined,
  }
}

function normalizeLog(value: unknown, createdAt: number): WorldEngineLogEntry | null {
  const item = record(value)
  const id = stringValue(item.id)
  if (!id) return null
  return {
    id,
    chapterId: stringValue(item.chapterId) || undefined,
    prompt: stringValue(item.prompt),
    response: stringValue(item.response),
    status: oneOf(item.status, ['success', 'error'] as const, 'success'),
    error: stringValue(item.error) || undefined,
    createdAt: numberValue(item.createdAt, createdAt),
  }
}

/**
 * Normalize persisted World Engine state. Story outline entries are supplied
 * separately through context retrieval; the engine state only stores dynamic
 * observations and confirmed changes.
 */
export function normalizeWorldEngineState(
  value: unknown,
  updatedAt = Date.now(),
  characters: Resource[] = [],
): WorldEngineState {
  const source = record(value)
  const base = createDefaultWorldEngineState(updatedAt)
  const state: WorldEngineState = {
    ...base,
    schemaVersion: worldEngineSchemaVersion,
    enabled: booleanValue(source.enabled, true),
    status: oneOf(source.status, ['idle', 'running', 'awaiting-review', 'error'] as const, 'idle'),
    clock: normalizeWorldEngineClock(source.clock, updatedAt),
    characterStates: Array.isArray(source.characterStates)
      ? source.characterStates.map((item) => normalizeCharacterState(item, updatedAt)).filter((item): item is WorldEngineCharacterState => item !== null)
      : [],
    relationships: Array.isArray(source.relationships)
      ? source.relationships
        .map((item) => normalizeRelationship(item, updatedAt))
        .filter((item): item is WorldEngineRelationship => item !== null)
        .filter((item) => relationshipAllowed(item.fromCharacterId, item.toCharacterId, characters))
      : [],
    events: Array.isArray(source.events)
      ? source.events.map((item) => normalizeEvent(item, updatedAt)).filter((item): item is WorldEngineEvent => item !== null)
      : [],
    timeline: Array.isArray(source.timeline)
      ? source.timeline.map((item) => normalizeTimelineEntry(item, updatedAt)).filter((item): item is WorldEngineTimelineEntry => item !== null)
      : [],
    workNotes: Array.isArray(source.workNotes)
      ? source.workNotes.map((item) => normalizeWorkNote(item, updatedAt)).filter((item): item is WorldEngineWorkNote => item !== null)
      : [],
    pendingProposals: Array.isArray(source.pendingProposals)
      ? source.pendingProposals.map((item) => normalizeProposal(item, updatedAt)).filter((item): item is WorldEngineProposal => item !== null)
      : [],
    logs: Array.isArray(source.logs)
      ? source.logs.map((item) => normalizeLog(item, updatedAt)).filter((item): item is WorldEngineLogEntry => item !== null)
      : [],
    lastProcessedChapterId: stringValue(source.lastProcessedChapterId) || undefined,
    updatedAt: numberValue(source.updatedAt, updatedAt),
  }

  return state
}

/** Alias that reads clearly at persistence boundaries. */
export function migrateWorldEngineState(value: unknown, updatedAt = Date.now(), characters: Resource[] = []): WorldEngineState {
  return normalizeWorldEngineState(value, updatedAt, characters)
}

/**
 * Build a compact context block for Agent or正文 generation. Pending proposals
 * and raw logs are deliberately omitted; only confirmed state is exposed.
 */
export function formatWorldEngineContext(state: WorldEngineState | undefined, options: { maxCharacters?: number; maxEvents?: number; maxNotes?: number } = {}): string {
  if (!state || !state.enabled) return ''
  const maxCharacters = Math.max(0, Math.floor(options.maxCharacters ?? 12))
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? 12))
  const maxNotes = Math.max(0, Math.floor(options.maxNotes ?? 4))
  const currentTime = state.clock.currentTime || state.clock.label || '未设定'
  const timeLine = state.clock.calendar ? `世界时间（${state.clock.calendar}）：${currentTime}` : `世界时间：${currentTime}`
  const span = worldEngineTimeAdvanceModeLabel(state.clock.timeAdvanceMode)
  const custom = state.clock.timeAdvanceMode === 'custom' && state.clock.customDays ? `；${state.clock.customDays} 天` : ''
  const target = state.clock.targetTime ? `；目标：${state.clock.targetTime}` : ''
  const reason = state.clock.timeAdvanceReason ? `；原因：${state.clock.timeAdvanceReason}` : ''
  const lines = [
    timeLine,
    `本轮时间推进方式：${span}${custom}${target}${reason}`,
  ]
  if (state.clock.previousTime) lines.push(`上一次确认时间：${state.clock.previousTime}`)
  const characters = state.characterStates.slice(0, maxCharacters)
  if (characters.length) {
    lines.push('后台角色状态：')
    for (const character of characters) {
      const detail = [character.location, character.activity, character.mood].filter(Boolean).join('；')
      const action = character.nextAction ? `；下一步：${character.nextAction}` : ''
      lines.push(`- ${character.name} [${character.availability}] ${detail}${action}`)
    }
  }
  const events = state.events.filter((event) => event.status !== 'discarded' && event.status !== 'resolved').slice(0, maxEvents)
  if (events.length) {
    lines.push('天下大势与待发生事件：')
    for (const event of events) lines.push(`- [${event.kind}] ${event.title}：${event.summary}`)
  }
  const relationships = state.relationships.slice(0, maxEvents)
  if (relationships.length) {
    lines.push('主角与配角关系：')
    for (const relationship of relationships) {
      const detail = relationship.detail ? `；${relationship.detail}` : ''
      lines.push(`- ${relationship.fromCharacterId} -> ${relationship.toCharacterId} [${relationship.label}]${detail}`)
    }
  }
  const notes = state.workNotes.slice(0, maxNotes)
  if (notes.length) {
    lines.push('最近工作小结：')
    for (const note of notes) lines.push(`- ${note.title}：${note.content}`)
  }
  return lines.join('\n')
}

