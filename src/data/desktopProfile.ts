import type {
  AgentConversation,
  AgentHistoryEntry,
  AgentMessage,
  AgentMode,
  Resource,
  Store,
} from '../types'
import type { PageKey } from './appConfig'
import type { ThemeSettings } from './theme'
import { cloneThemeSettings, defaultThemeSettings } from './theme.ts'
import type { StandardCreationPromptHints } from '../agent/resourceStructure'
import { defaultStandardCreationPromptHints } from '../agent/resourceStructure.ts'

/**
 * Local working-session metadata. The current contents of a work live only in
 * its `.qy` file; Agent undo snapshots are historical records, not a second
 * editable copy of the work.
 */
export type ProjectSession = {
  selectedChapterId: string
  selectedVolumeId: string
  selectedIds: Record<string, string>
  agentProviderId: string
  writerProviderId: string
  worldEngineProviderId: string
  agentMode: AgentMode
  agentHistory: AgentHistoryEntry[]
  agentMessages: AgentMessage[]
  agentConversations: AgentConversation[]
  activeAgentConversationId: string
}

export type DesktopProfileSettings = {
  autoSaveSeconds: number
  formatIndentSpaces: number
  qyBackupCount: number
  theme: ThemeSettings
  resourcePromptHints: StandardCreationPromptHints
}

/** Desktop settings and per-work sessions, deliberately without work content. */
export type DesktopProfile = {
  version: 1
  kind: 'desktop-profile'
  updatedAt: number
  providers: Resource[]
  modelOptions: Record<string, string[]>
  settings: DesktopProfileSettings
  agentHistoryLimit: number
  ui: {
    activePage: PageKey
    agentPosition: { x: number; y: number }
  }
  activePortfolio: { id: string; path: string } | null
  projectSessions: Record<string, ProjectSession>
}

type ProjectSessionSource = Partial<ProjectSession>

/**
 * Structural input accepted from the former all-in-one application state.
 * Extra source fields are never spread into the output. This also permits the
 * renderer to use the helper without depending on its private state type.
 */
export type DesktopProfileSource = ProjectSessionSource & {
  updatedAt?: number
  store?: Pick<Store, 'providers' | 'modelOptions'>
  providers?: Resource[]
  modelOptions?: Record<string, string[]>
  currentProjectId?: string
  projects?: Array<{ id: string; snapshot: ProjectSessionSource }>
  settings?: {
    autoSaveSeconds?: number
    formatIndentSpaces?: number
    qyBackupCount?: number
    theme?: ThemeSettings
    resourcePromptHints?: unknown
  }
  agentHistoryLimit?: number
  ui?: Partial<ProjectSession> & {
    activePage?: PageKey
    agentPosition?: { x: number; y: number }
  }
}

export type DesktopProfileOptions = {
  portfolioId?: string
  filePath?: string
  previousSessions?: Record<string, ProjectSession>
}

export class DesktopProfileValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`本机设置文件校验失败：${issues.join('；')}`)
    this.name = 'DesktopProfileValidationError'
    this.issues = issues
  }
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim()
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, issues: string[]) {
  const keys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) issues.push(`${label}.${key} 不属于本机设置结构`)
  }
}

const profileKeys = [
  'version', 'kind', 'updatedAt', 'providers', 'modelOptions', 'settings',
  'agentHistoryLimit', 'ui', 'activePortfolio', 'projectSessions',
] as const
const sessionKeys = [
  'selectedChapterId', 'selectedVolumeId', 'selectedIds',
  'agentProviderId', 'writerProviderId', 'worldEngineProviderId', 'agentMode',
  'agentHistory', 'agentMessages', 'agentConversations', 'activeAgentConversationId',
] as const
const sessionStringKeys = [
  'selectedChapterId', 'selectedVolumeId', 'agentProviderId',
  'writerProviderId', 'worldEngineProviderId', 'activeAgentConversationId',
] as const
const settingsKeys = [
  'autoSaveSeconds', 'formatIndentSpaces', 'qyBackupCount', 'theme', 'resourcePromptHints',
] as const
const pageKeys = [
  'writer', 'world', 'characters', 'items', 'skills', 'outline', 'worldEngine',
  'style', 'context', 'agent', 'console', 'api', 'json', 'custom', 'memes',
] as const
const themePaletteKeys = ['primary', 'secondary', 'button', 'font', 'success', 'danger', 'warning', 'info'] as const

function validateStringMap(value: unknown, label: string, issues: string[]) {
  if (!isRecord(value)) {
    issues.push(`${label} 必须是字符串映射`)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') issues.push(`${label}.${key} 必须是字符串`)
  }
}

function validateMessages(value: unknown, label: string, issues: string[]) {
  if (!Array.isArray(value)) {
    issues.push(`${label} 必须是数组`)
    return
  }
  const ids = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const messageLabel = `${label}[${index}]`
    if (!isRecord(raw)) {
      issues.push(`${messageLabel} 必须是对象`)
      continue
    }
    if (!isCanonicalId(raw.id)) issues.push(`${messageLabel}.id 必须是非空 ID`)
    else if (ids.has(raw.id)) issues.push(`${messageLabel}.id 重复`)
    else ids.add(raw.id)
    if (!['user', 'assistant', 'system'].includes(String(raw.role))) issues.push(`${messageLabel}.role 无效`)
    if (typeof raw.content !== 'string') issues.push(`${messageLabel}.content 必须是字符串`)
    if (!isFiniteNumber(raw.createdAt)) issues.push(`${messageLabel}.createdAt 必须是有限数字`)
    if (raw.activities !== undefined && !Array.isArray(raw.activities)) issues.push(`${messageLabel}.activities 必须是数组`)
  }
}

function validateSession(value: unknown, label: string, issues: string[]) {
  if (!isRecord(value)) {
    issues.push(`${label} 必须是对象`)
    return
  }
  checkKeys(value, sessionKeys, label, issues)
  for (const key of sessionStringKeys) {
    if (typeof value[key] !== 'string') issues.push(`${label}.${key} 必须是字符串`)
  }
  validateStringMap(value.selectedIds, `${label}.selectedIds`, issues)
  if (value.agentMode !== 'writing' && value.agentMode !== 'inspiration') issues.push(`${label}.agentMode 无效`)
  validateMessages(value.agentMessages, `${label}.agentMessages`, issues)
  if (!Array.isArray(value.agentHistory)) {
    issues.push(`${label}.agentHistory 必须是数组`)
  } else {
    for (const [index, raw] of value.agentHistory.entries()) {
      const historyLabel = `${label}.agentHistory[${index}]`
      if (!isRecord(raw)) {
        issues.push(`${historyLabel} 必须是对象`)
        continue
      }
      if (!isCanonicalId(raw.id)) issues.push(`${historyLabel}.id 必须是非空 ID`)
      if (typeof raw.summary !== 'string') issues.push(`${historyLabel}.summary 必须是字符串`)
      if (!Array.isArray(raw.changes) || raw.changes.some((item) => typeof item !== 'string')) issues.push(`${historyLabel}.changes 必须是字符串数组`)
      if (!isFiniteNumber(raw.createdAt)) issues.push(`${historyLabel}.createdAt 必须是有限数字`)
      if (raw.status !== 'applied' && raw.status !== 'undone') issues.push(`${historyLabel}.status 无效`)
      const hasSnapshot = isRecord(raw.snapshot) && Array.isArray(raw.snapshot.chapters)
      const patchOperations = Array.isArray(raw.patch) ? raw.patch : []
      const hasPatch = patchOperations.length > 0
      if (!hasSnapshot && !hasPatch) {
        issues.push(`${historyLabel} 必须包含有效的历史快照或增量 patch`)
      }
      if (hasPatch) {
        for (const [patchIndex, operation] of patchOperations.entries()) {
          const patchLabel = `${historyLabel}.patch[${patchIndex}]`
          if (!isRecord(operation)) {
            issues.push(`${patchLabel} 必须是对象`)
            continue
          }
          if (operation.op !== 'add' && operation.op !== 'remove' && operation.op !== 'replace') {
            issues.push(`${patchLabel}.op 无效`)
          }
          if (typeof operation.path !== 'string' || (!operation.path.startsWith('/') && operation.path !== '')) {
            issues.push(`${patchLabel}.path 必须是 JSON Pointer`)
          }
          if ((operation.op === 'add' || operation.op === 'replace') && operation.value === undefined) {
            issues.push(`${patchLabel}.value 不得缺失`)
          }
        }
      }
      if (raw.source !== undefined && raw.source !== 'agent' && raw.source !== 'console' && raw.source !== 'manual') {
        issues.push(`${historyLabel}.source 无效`)
      }
      if (raw.reviews !== undefined) {
        if (!Array.isArray(raw.reviews)) {
          issues.push(`${historyLabel}.reviews 必须是数组`)
        } else {
          for (const [reviewIndex, review] of raw.reviews.entries()) {
            const reviewLabel = `${historyLabel}.reviews[${reviewIndex}]`
            if (!isRecord(review)) {
              issues.push(`${reviewLabel} 必须是对象`)
              continue
            }
            if (!Number.isSafeInteger(review.operationIndex) || (review.operationIndex as number) < 0) issues.push(`${reviewLabel}.operationIndex 必须是非负整数`)
            if (typeof review.action !== 'string' || !review.action.trim()) issues.push(`${reviewLabel}.action 必须是字符串`)
            if (!['create', 'update', 'delete', 'move', 'append', 'search'].includes(String(review.kind))) issues.push(`${reviewLabel}.kind 无效`)
            if (typeof review.title !== 'string') issues.push(`${reviewLabel}.title 必须是字符串`)
            if (review.target !== undefined && typeof review.target !== 'string') issues.push(`${reviewLabel}.target 必须是字符串`)
            if (!Array.isArray(review.diffs)) {
              issues.push(`${reviewLabel}.diffs 必须是数组`)
            } else {
              for (const [diffIndex, diff] of review.diffs.entries()) {
                const diffLabel = `${reviewLabel}.diffs[${diffIndex}]`
                if (!isRecord(diff)) {
                  issues.push(`${diffLabel} 必须是对象`)
                  continue
                }
                if (typeof diff.field !== 'string') issues.push(`${diffLabel}.field 必须是字符串`)
                if (!['added', 'changed', 'cleared', 'removed', 'locked'].includes(String(diff.status))) issues.push(`${diffLabel}.status 无效`)
                if (diff.locked !== undefined && typeof diff.locked !== 'boolean') issues.push(`${diffLabel}.locked 必须是布尔值`)
              }
            }
          }
        }
      }
      if (raw.afterFingerprint !== undefined && typeof raw.afterFingerprint !== 'string') issues.push(`${historyLabel}.afterFingerprint 必须是字符串`)
    }
  }
  if (!Array.isArray(value.agentConversations)) {
    issues.push(`${label}.agentConversations 必须是数组`)
  } else {
    const ids = new Set<string>()
    for (const [index, raw] of value.agentConversations.entries()) {
      const conversationLabel = `${label}.agentConversations[${index}]`
      if (!isRecord(raw)) {
        issues.push(`${conversationLabel} 必须是对象`)
        continue
      }
      if (!isCanonicalId(raw.id)) issues.push(`${conversationLabel}.id 必须是非空 ID`)
      else if (ids.has(raw.id)) issues.push(`${conversationLabel}.id 重复`)
      else ids.add(raw.id)
      if (typeof raw.title !== 'string') issues.push(`${conversationLabel}.title 必须是字符串`)
      if (!isFiniteNumber(raw.createdAt) || !isFiniteNumber(raw.updatedAt)) issues.push(`${conversationLabel} 的时间必须是有限数字`)
      if (raw.archived !== undefined && typeof raw.archived !== 'boolean') issues.push(`${conversationLabel}.archived 必须是布尔值`)
      if (raw.archivedAt !== undefined && !isFiniteNumber(raw.archivedAt)) issues.push(`${conversationLabel}.archivedAt 必须是有限数字`)
      validateMessages(raw.messages, `${conversationLabel}.messages`, issues)
    }
    if (typeof value.activeAgentConversationId === 'string' && value.activeAgentConversationId
      && !ids.has(value.activeAgentConversationId)) {
      issues.push(`${label}.activeAgentConversationId 不存在`)
    }
  }
}

function validateSettings(value: unknown, issues: string[]) {
  if (!isRecord(value)) {
    issues.push('settings 必须是对象')
    return
  }
  checkKeys(value, settingsKeys, 'settings', issues)
  for (const key of ['autoSaveSeconds', 'formatIndentSpaces', 'qyBackupCount'] as const) {
    if (!isFiniteNumber(value[key]) || !Number.isSafeInteger(value[key]) || value[key] < 0) issues.push(`settings.${key} 必须是非负整数`)
  }
  const theme = value.theme
  if (!isRecord(theme)) {
    issues.push('settings.theme 必须是对象')
  } else {
    checkKeys(theme, ['version', 'mode', 'light', 'dark'], 'settings.theme', issues)
    if (theme.version !== 2) issues.push('settings.theme.version 必须为 2')
    if (theme.mode !== 'light' && theme.mode !== 'dark') issues.push('settings.theme.mode 无效')
    for (const mode of ['light', 'dark'] as const) {
      const palette = theme[mode]
      if (!isRecord(palette)) {
        issues.push(`settings.theme.${mode} 必须是对象`)
        continue
      }
      checkKeys(palette, themePaletteKeys, `settings.theme.${mode}`, issues)
      for (const key of themePaletteKeys) {
        if (typeof palette[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(palette[key])) issues.push(`settings.theme.${mode}.${key} 必须是六位十六进制颜色`)
      }
    }
  }
  const hints = value.resourcePromptHints
  if (!isRecord(hints)) {
    issues.push('settings.resourcePromptHints 必须是对象')
  } else {
    checkKeys(hints, ['world', 'character', 'item', 'skill'], 'settings.resourcePromptHints', issues)
    for (const type of ['world', 'character', 'item', 'skill']) {
      validateStringMap(hints[type], `settings.resourcePromptHints.${type}`, issues)
    }
  }
}

export function validateDesktopProfile(value: unknown): string[] {
  const issues: string[] = []
  if (!isRecord(value)) return ['根节点必须是对象']
  checkKeys(value, profileKeys, '根节点', issues)
  if (value.version !== 1) issues.push('version 必须为 1')
  if (value.kind !== 'desktop-profile') issues.push('kind 必须为 "desktop-profile"')
  if (!isFiniteNumber(value.updatedAt) || value.updatedAt < 0) issues.push('updatedAt 必须是非负有限数字')
  if (!Number.isSafeInteger(value.agentHistoryLimit) || (value.agentHistoryLimit as number) < 0) issues.push('agentHistoryLimit 必须是非负整数')
  if (!Array.isArray(value.providers)) {
    issues.push('providers 必须是数组')
  } else {
    const ids = new Set<string>()
    for (const [index, raw] of value.providers.entries()) {
      const label = `providers[${index}]`
      if (!isRecord(raw)) {
        issues.push(`${label} 必须是对象`)
        continue
      }
      if (!isCanonicalId(raw.id)) issues.push(`${label}.id 必须是非空 ID`)
      else if (ids.has(raw.id)) issues.push(`${label}.id 重复`)
      else ids.add(raw.id)
      for (const key of ['title', 'tag', 'summary']) {
        if (typeof raw[key] !== 'string') issues.push(`${label}.${key} 必须是字符串`)
      }
      validateStringMap(raw.fields, `${label}.fields`, issues)
      if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') issues.push(`${label}.enabled 必须是布尔值`)
    }
  }
  if (!isRecord(value.modelOptions)) {
    issues.push('modelOptions 必须是对象')
  } else {
    for (const [key, models] of Object.entries(value.modelOptions)) {
      if (!Array.isArray(models) || models.some((model) => typeof model !== 'string')) issues.push(`modelOptions.${key} 必须是字符串数组`)
    }
  }
  validateSettings(value.settings, issues)
  if (!isRecord(value.ui)) {
    issues.push('ui 必须是对象')
  } else {
    checkKeys(value.ui, ['activePage', 'agentPosition'], 'ui', issues)
    if (!pageKeys.includes(value.ui.activePage as typeof pageKeys[number])) issues.push('ui.activePage 无效')
    const position = value.ui.agentPosition
    if (!isRecord(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
      issues.push('ui.agentPosition 必须含有限数值 x 和 y')
    } else {
      checkKeys(position, ['x', 'y'], 'ui.agentPosition', issues)
    }
  }
  if (value.activePortfolio !== null) {
    if (!isRecord(value.activePortfolio)) {
      issues.push('activePortfolio 必须是对象或 null')
    } else {
      checkKeys(value.activePortfolio, ['id', 'path'], 'activePortfolio', issues)
      if (!isCanonicalId(value.activePortfolio.id)) issues.push('activePortfolio.id 必须是非空 ID')
      if (typeof value.activePortfolio.path !== 'string' || !value.activePortfolio.path.trim()) issues.push('activePortfolio.path 必须是非空文件路径')
    }
  }
  if (!isRecord(value.projectSessions)) {
    issues.push('projectSessions 必须是对象')
  } else {
    for (const [key, session] of Object.entries(value.projectSessions)) {
      const separator = key.indexOf(':')
      if (separator <= 0 || separator === key.length - 1 || key !== key.trim()) issues.push(`projectSessions.${key} 的键必须为 portfolioId:projectId`)
      validateSession(session, `projectSessions.${key}`, issues)
    }
  }
  return issues
}

export function isDesktopProfile(value: unknown): value is DesktopProfile {
  return validateDesktopProfile(value).length === 0
}

export function parseDesktopProfile(value: unknown): DesktopProfile {
  const issues = validateDesktopProfile(value)
  if (issues.length) throw new DesktopProfileValidationError(issues)
  return clonePlain(value) as DesktopProfile
}

function projectSession(source: ProjectSessionSource): ProjectSession {
  return {
    selectedChapterId: source.selectedChapterId ?? '',
    selectedVolumeId: source.selectedVolumeId ?? '',
    selectedIds: clonePlain(source.selectedIds ?? {}),
    agentProviderId: source.agentProviderId ?? '',
    writerProviderId: source.writerProviderId ?? '',
    worldEngineProviderId: source.worldEngineProviderId ?? '',
    agentMode: source.agentMode ?? 'writing',
    agentHistory: clonePlain(source.agentHistory ?? []),
    agentMessages: clonePlain(source.agentMessages ?? []),
    agentConversations: clonePlain(source.agentConversations ?? []),
    activeAgentConversationId: source.activeAgentConversationId ?? '',
  }
}

export function createDesktopProfile(
  state: DesktopProfileSource,
  options: DesktopProfileOptions = {},
): DesktopProfile {
  const sessions: Record<string, ProjectSession> = {}
  for (const [key, previous] of Object.entries(options.previousSessions ?? {})) {
    sessions[key] = projectSession(previous)
  }
  const portfolioId = options.portfolioId
  if (portfolioId) {
    const snapshots = new Map((state.projects ?? []).map((project) => [project.id, project.snapshot]))
    for (const [projectId, snapshot] of snapshots) {
      sessions[`${portfolioId}:${projectId}`] = projectSession(snapshot)
    }
    if (state.currentProjectId) {
      const existing = snapshots.get(state.currentProjectId)
      sessions[`${portfolioId}:${state.currentProjectId}`] = projectSession({
        selectedChapterId: state.ui?.selectedChapterId ?? state.selectedChapterId ?? existing?.selectedChapterId,
        selectedVolumeId: state.ui?.selectedVolumeId ?? state.selectedVolumeId ?? existing?.selectedVolumeId,
        selectedIds: state.ui?.selectedIds ?? state.selectedIds ?? existing?.selectedIds,
        agentProviderId: state.ui?.agentProviderId ?? state.agentProviderId ?? existing?.agentProviderId,
        writerProviderId: state.ui?.writerProviderId ?? state.writerProviderId ?? existing?.writerProviderId,
        worldEngineProviderId: state.ui?.worldEngineProviderId ?? state.worldEngineProviderId ?? existing?.worldEngineProviderId,
        agentMode: state.agentMode ?? existing?.agentMode,
        agentHistory: state.agentHistory ?? existing?.agentHistory,
        agentMessages: state.agentMessages ?? existing?.agentMessages,
        agentConversations: state.agentConversations ?? existing?.agentConversations,
        activeAgentConversationId: state.activeAgentConversationId ?? existing?.activeAgentConversationId,
      })
    }
  }
  const sourceSettings = state.settings
  const profile: DesktopProfile = {
    version: 1,
    kind: 'desktop-profile',
    updatedAt: state.updatedAt ?? Date.now(),
    providers: clonePlain(state.store?.providers ?? state.providers ?? []),
    modelOptions: clonePlain(state.store?.modelOptions ?? state.modelOptions ?? {}),
    settings: {
      autoSaveSeconds: sourceSettings?.autoSaveSeconds ?? 10,
      formatIndentSpaces: sourceSettings?.formatIndentSpaces ?? 2,
      qyBackupCount: sourceSettings?.qyBackupCount ?? 10,
      theme: sourceSettings?.theme ? clonePlain(sourceSettings.theme) : cloneThemeSettings(defaultThemeSettings),
      resourcePromptHints: sourceSettings?.resourcePromptHints === undefined
        ? defaultStandardCreationPromptHints()
        : clonePlain(sourceSettings.resourcePromptHints) as StandardCreationPromptHints,
    },
    agentHistoryLimit: state.agentHistoryLimit ?? 20,
    ui: {
      activePage: state.ui?.activePage ?? 'writer',
      agentPosition: clonePlain(state.ui?.agentPosition ?? { x: 0, y: 0 }),
    },
    activePortfolio: portfolioId && options.filePath
      ? { id: portfolioId, path: options.filePath }
      : null,
    projectSessions: sessions,
  }
  return parseDesktopProfile(profile)
}

/** Exact composite-key lookup prevents same-named project IDs crossing files. */
export function profileProjectSession(
  profile: DesktopProfile,
  portfolioId: string,
  projectId: string,
): ProjectSession | undefined {
  const session = profile.projectSessions[`${portfolioId}:${projectId}`]
  return session ? clonePlain(session) : undefined
}
