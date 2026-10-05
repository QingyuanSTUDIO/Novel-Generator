<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AlignLeft,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  Clipboard,
  ChevronDown,
  Cloud,
  Copy,
  FolderPlus,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LockKeyholeOpen,
  MoreHorizontal,
  PanelRight,
  PenLine,
  Plus,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-vue-next'
import SidebarNav from './components/SidebarNav.vue'
import DesktopTitleBar from './components/DesktopTitleBar.vue'
import QyLogo from './components/QyLogo.vue'
import ResourceCollectionView from './components/ResourceCollectionView.vue'
import CustomModulesPanel from './components/CustomModulesPanel.vue'
import InternetMemesPanel from './components/InternetMemesPanel.vue'
import AgentPanel from './components/AgentPanel.vue'
import AiActivityStrip from './components/AiActivityStrip.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ApiManagementPanel from './components/ApiManagementPanel.vue'
import JsonStructureViewer from './components/JsonStructureViewer.vue'
import TopBar from './components/TopBar.vue'
import ParagraphEditor from './components/ParagraphEditor.vue'
import WorldEnginePanel from './components/WorldEnginePanel.vue'
import ContextOrchestrationPanel from './components/ContextOrchestrationPanel.vue'
import { useWorldEngineController } from './composables/useWorldEngineController'
import { parseLocalAgentPrompt } from './agent/localParser'
import { agentResponseSchema } from './agent/schema'
import type { AgentResponse, AgentResourceType, GroupedResourceCollection } from './agent/schema'
import { collectAgentConversation, normalizeAgentMessages, normalizeAgentActivities, agentPersistedMessageLimit } from './agent/chatHistory'
import { extractAgentMessagePreview } from './agent/responsePreview'
import { useParagraphEditing } from './composables/useParagraphEditing'
import { useChapterController } from './composables/useChapterController'
import { useWritingGeneration } from './composables/useWritingGeneration'
import { createAgentOperations, legacyStyleMetadataFields, type AgentResourcePage } from './agent/operations'
import { validateAgentResponse } from './agent/validation'
import { groupedResourcePages, isGroupedResourcePage, jsonStructures, navItems, pageConfig } from './data/appConfig'
import type { GroupedResourcePage, PageKey } from './data/appConfig'
import { contextResourceOrder, ensureContextLayout, normalizeContextGroups, normalizeOutlineHierarchy, readStore, seed, storageKey, syncContextResourceItems } from './data/seed'
import { createQyDocument, mergeQyContent, parseQyDocument } from './data/qy'
import type { QyDocument } from './data/qy'
import { normalizeResourceReviewMetadata, setResourceLockAll } from './data/resourceReviewMetadata'
import { createDefaultWorldEngineState, formatWorldEngineContext, migrateWorldEngineState } from './data/worldEngine'
import { customModuleExamplePayload, customModulePromptContract, normalizeCustomModuleData, normalizeCustomModuleEntry, normalizeCustomModuleSchema, normalizeCustomModuleStore } from './data/customModules'
import { cleanupDeletedResourceReferences } from './data/integrity'
import { normalizeOutlineNodes } from './data/outline'
import { createMeme, normalizeMeme } from './data/memes'
import type { Meme } from './data/memes'
import { requestChat, type ChatMessage } from './api/chat'
import { defaultModelSettings, readModelSettings } from './api/modelSettings'
import { estimateTextTokens, prepareContextBudget } from './api/contextBudget'
import { useContextMetrics } from './composables/useContextMetrics'
import { useModelLimits } from './composables/useModelLimits'
import { currentChatMetricsId, subscribeChatMetrics, type ChatMetrics } from './api/chatMetrics'
import ContextUsageIndicator from './components/ContextUsageIndicator.vue'
import { cloneThemeSettings, defaultThemeSettings, normalizeThemeSettings } from './data/theme'
import type { ThemeColorKey, ThemeMode, ThemeSettings } from './data/theme'
import { canonicalTriggerField, formatRetrievedContext, normalizeResourceTriggers, retrieveStoreContext, updateResourceTriggerField } from './context/retrieval'
import { defaultStandardCreationPromptHints, normalizeStandardCreationPromptHints, type StandardCreationPromptHints, type StandardResourceType } from './agent/resourceStructure'
import type { RetrievalMatch } from './context/retrieval'
import type { AgentActivityEvent, AgentConversation, AgentHistoryEntry, AgentMessage, AgentMode, AgentPlan, AgentQuickAction, AgentSnapshot, AgentTask, Chapter, ContextBlock, CustomModuleFieldType, CustomModuleStore, Resource, ResourceGroup, Store, Volume } from './types'

const store = ref<Store>(readStore())
const agentHistoryStorageKey = `${storageKey}-agent-history`
const agentSettingsStorageKey = `${storageKey}-agent-settings`
const globalSettingsStorageKey = `${storageKey}-global-settings`
const persistenceUpdatedAtKey = `${storageKey}-updated-at`
const projectsStorageKey = `${storageKey}-projects`
const requestedDesktopApiPort = Number(new URLSearchParams(window.location.search).get('desktopApiPort'))
const desktopApiPort = Number.isInteger(requestedDesktopApiPort) && requestedDesktopApiPort > 0 && requestedDesktopApiPort <= 65535
  ? requestedDesktopApiPort
  : null
const isDesktopRuntime = desktopApiPort !== null
const desktopStorageHydrated = ref(!isDesktopRuntime)
const desktopStorageError = ref('')
const desktopStorageFlushing = ref(false)
const remotePersistenceReady = ref(false)
const remotePersistenceError = ref('')
let remotePersistenceTimer: number | undefined
let remotePersistenceQueue = Promise.resolve()
let remoteRevision = 0
let allowProjectDeletionUntilSaved = false
let hydrationInProgress = false
let desktopFlushSucceeded = false
let desktopFlushAbandoned = false
let removeDesktopFlushListener: (() => void) | undefined
let removeDesktopFlushCancelledListener: (() => void) | undefined
let removeDesktopFlushAbandonedListener: (() => void) | undefined
let desktopHydrationController: AbortController | undefined
let desktopHydrationTimeout: number | undefined
let autoSaveTimer: number | undefined
const activePage = ref<PageKey>('writer')
const settingsOpen = ref(false)
const projectMenuOpen = ref(false)
const projectDeleteOpen = ref(false)
const projectRenameOpen = ref(false)
const renameTitle = ref('')
const editorToolsOpen = ref(false)
const chapterDeleteOpen = ref(false)
const formatIndentSpaces = ref(2)
const copyFeedback = ref<'copied' | 'error' | ''>('')
const currentWorkTitle = ref('')
const currentProjectId = ref('')
const currentQyPath = ref('')
const recentQyFiles = ref<{ path: string; title: string; updatedAt: number }[]>([])
const qyFileBusy = ref(false)
const qyFileError = ref('')
const qyBackupCount = ref(10)
let qyAutosaveSuppressed = false
let qyAutosaveInProgress = false
let qyStartupRestoreAttempted = false
type ProjectSnapshot = {
  store: Store
  selectedChapterId: string
  selectedVolumeId: string
  selectedIds: Record<string, string>
  agentProviderId: string
  writerProviderId: string
  worldEngineProviderId: string
  agentMode?: AgentMode
  agentHistory: AgentHistoryEntry[]
  /** Conversation transcript for this work. Optional for older project files. */
  agentMessages?: AgentMessage[]
  /** Named Agent conversations for newer project files. */
  agentConversations?: AgentConversation[]
  /** Active conversation id for newer project files. */
  activeAgentConversationId?: string
}
type ProjectRecord = { id: string; title: string; updatedAt: number; snapshot: ProjectSnapshot }
const projects = ref<ProjectRecord[]>([])
const selectedChapterId = ref('ch-8')
const selectedVolumeId = ref('')
const selectedIds = ref<Record<string, string>>({ world: 'world-curfew', characters: 'char-shen', items: 'item-key', skills: 'skill-tide', outline: 'outline-8', worldEngine: '', style: 'style-action', api: 'provider-main' })
/** API preset used by Agent. Empty means follow the enabled/default preset. */
const agentProviderId = ref('')
const agentMode = ref<AgentMode>('writing')
/** API preset used for chapter generation. Empty means follow the enabled/default preset. */
const writerProviderId = ref('')
/** API preset used for World Engine simulation. Empty means follow the enabled/default preset. */
const worldEngineProviderId = ref('')
const castDraft = ref('')
const generationError = ref('')
const assistantTab = ref<'task' | 'context' | 'checks'>('task')
const saveState = ref('已保存')
const autoSaveSeconds = ref(10)
const autoSaveOptions = [0, 5, 10, 30, 60, 300] as const
const themeSettings = ref<ThemeSettings>(cloneThemeSettings(defaultThemeSettings))
// These are author-wide schema instructions for Agent-created standard cards.
// They are deliberately kept outside Store resources and are only sent as
// guidance for create_resource operations.
const standardCreationPromptHints = ref<StandardCreationPromptHints>(defaultStandardCreationPromptHints())
let autoSaveDirty = false
const isGenerating = ref(false)
const candidate = ref('')
const focusMode = ref(false)
const providerTest = ref('')
const apiError = ref('')
const protocolOptions = ['OpenAI Compatible', 'Anthropic', 'Google Gemini', '自定义 HTTP']
const roleOptions = ['主角', '配角', '路人']
const agentOpen = ref(false)
const agentBusy = ref(false)
let agentRunEpoch = 0
let agentAbortController: AbortController | undefined
const agentLiveResponse = ref<{ message: string; receivedChars: number; streaming: boolean } | null>(null)
const agentWelcomeContent = '我可以创建和整理作品资料，也可以协助修改章节正文。告诉我具体要做什么即可。'
const agentMessages = ref<AgentMessage[]>([
  { id: 'agent-welcome', role: 'assistant', content: agentWelcomeContent, createdAt: Date.now() },
])
const agentConversations = ref<AgentConversation[]>([])
const activeAgentConversationId = ref('')
const agentTasks = ref<AgentTask[]>([
  { id: 'agent-ready', label: '等待任务', state: 'done', detail: 'Agent 已就绪' },
])
/** Ephemeral, human-readable activity log for the open Agent surface. */
const agentActivities = ref<AgentActivityEvent[]>([])
const agentPendingPlan = ref<AgentPlan | null>(null)
const agentHistory = ref<AgentHistoryEntry[]>([])
const agentHistoryLimit = ref(20)
const agentQuickActions: AgentQuickAction[] = [
  { id: 'character', label: '创建角色', prompt: '创建一个角色卡' },
  { id: 'item', label: '创建道具', prompt: '创建一个道具卡' },
  { id: 'skill', label: '创建技能', prompt: '创建一个技能卡' },
  { id: 'world', label: '创建世界书条目', prompt: '创建一个世界书条目' },
  { id: 'group', label: '创建折叠栏', prompt: '在当前分类创建一个折叠栏' },
  { id: 'outline', label: '创建大纲条目', prompt: '创建一个大纲条目' },
  { id: 'world-event', label: '生成世界事件', prompt: '为当前作品生成一个世界引擎事件或后台行动' },
  { id: 'style', label: '创建文风规则', prompt: '创建一条文风规则' },
]

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createAgentConversation(title = '新对话', messages?: AgentMessage[], id?: string): AgentConversation {
  const now = Date.now()
  const normalizedMessages = normalizeAgentMessages(messages, agentPersistedMessageLimit)
  return {
    id: id || `agent-conversation-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: title.trim() || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: normalizedMessages.length
      ? normalizedMessages
      : [{ id: `agent-welcome-${now}`, role: 'assistant', content: agentWelcomeContent, createdAt: now }],
  }
}

function normalizeAgentConversation(value: unknown, index: number): AgentConversation | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<AgentConversation>
  if (typeof item.id !== 'string' || !item.id.trim()) return null
  const messages = normalizeAgentMessages(item.messages, agentPersistedMessageLimit)
  const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
  const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt
  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : (index === 0 ? '历史对话' : '新对话'),
    createdAt,
    updatedAt,
    archived: item.archived === true,
    archivedAt: typeof item.archivedAt === 'number' && Number.isFinite(item.archivedAt) ? item.archivedAt : undefined,
    messages: messages.length
      ? messages
      : [{ id: `agent-welcome-${item.id}`, role: 'assistant', content: agentWelcomeContent, createdAt: createdAt || Date.now() }],
  }
}

function normalizeAgentConversations(value: unknown, legacyMessages?: unknown): AgentConversation[] {
  const seen = new Set<string>()
  const conversations = Array.isArray(value)
    ? value.map(normalizeAgentConversation).filter((conversation): conversation is AgentConversation => {
      if (!conversation || seen.has(conversation.id)) return false
      seen.add(conversation.id)
      return true
    })
    : []
  if (conversations.length) return conversations
  const legacy = normalizeAgentMessages(legacyMessages, agentPersistedMessageLimit)
  return [createAgentConversation(legacy.length ? '历史对话' : '新对话', legacy)]
}

function restoreAgentConversationState(value: unknown, activeId?: unknown, legacyMessages?: unknown) {
  let conversations = normalizeAgentConversations(value, legacyMessages)
  let selected = typeof activeId === 'string'
    ? conversations.find((conversation) => conversation.id === activeId && conversation.archived !== true)
    : undefined
  const firstActive = conversations.find((conversation) => conversation.archived !== true)
  if (!selected) selected = firstActive
  if (!selected) {
    const fresh = createAgentConversation()
    conversations = [fresh, ...conversations]
    selected = fresh
  }
  const current = selected
  agentConversations.value = conversations
  activeAgentConversationId.value = current.id
  agentMessages.value = normalizeAgentMessages(current.messages, agentPersistedMessageLimit)
  if (!agentMessages.value.length) {
    agentMessages.value = [{ id: `agent-welcome-${Date.now()}`, role: 'assistant', content: agentWelcomeContent, createdAt: Date.now() }]
  }
}

function syncActiveAgentConversation() {
  if (!agentConversations.value.length || !activeAgentConversationId.value) {
    restoreAgentConversationState(undefined, undefined, agentMessages.value)
    return
  }
  const current = agentConversations.value.find((conversation) => conversation.id === activeAgentConversationId.value)
  if (!current) {
    restoreAgentConversationState(agentConversations.value, undefined, agentMessages.value)
    return
  }
  current.messages = cloneSerializable(normalizeAgentMessages(agentMessages.value, agentPersistedMessageLimit))
  const lastMessage = current.messages[current.messages.length - 1]
  current.updatedAt = Math.max(current.updatedAt, lastMessage?.createdAt ?? Date.now())
}

function agentConversationTitle(prompt: string) {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  if (!compact) return '新对话'
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact
}

const agentConversationList = computed(() => [...agentConversations.value].filter((conversation) => conversation.archived !== true).sort((a, b) => b.updatedAt - a.updatedAt))
const archivedAgentConversationList = computed(() => [...agentConversations.value].filter((conversation) => conversation.archived === true).sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt)))

restoreAgentConversationState(undefined, undefined, agentMessages.value)

function readLocalCache(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}

function readableTextColor(hexColor: string) {
  const values = hexColor.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16) / 255) ?? [0, 0, 0]
  const linear = values.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  return luminance > 0.42 ? '#18231c' : '#ffffff'
}

function applyThemeToDocument() {
  const root = document.documentElement
  const mode = themeSettings.value.mode
  const palette = themeSettings.value[mode]
  const buttonHover = `color-mix(in srgb, ${palette.button} 82%, ${palette.font} 18%)`
  root.dataset.themeMode = mode
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.secondary)
  // The user-facing primary color is the writing surface. Keep the
  // internal primary variable as the accent color so buttons, focus rings,
  // and selected states remain readable when the writing surface is dark.
  root.style.setProperty('--theme-workspace', palette.primary)
  root.style.setProperty('--theme-primary', palette.button)
  root.style.setProperty('--theme-secondary', palette.secondary)
  // All supporting surfaces, controls and borders derive from the user's
  // secondary palette so color choices apply consistently across every page.
  root.style.setProperty('--theme-body-bg', palette.secondary)
  root.style.setProperty('--theme-page-bg', palette.secondary)
  root.style.setProperty('--theme-surface', palette.secondary)
  root.style.setProperty('--theme-surface-muted', palette.secondary)
  root.style.setProperty('--theme-surface-soft', palette.secondary)
  root.style.setProperty('--theme-input-bg', palette.secondary)
  root.style.setProperty('--theme-border', `color-mix(in srgb, ${palette.secondary} 78%, ${palette.font} 22%)`)
  root.style.setProperty('--theme-border-soft', `color-mix(in srgb, ${palette.secondary} 88%, ${palette.font} 12%)`)
  root.style.setProperty('--theme-hover', `color-mix(in srgb, ${palette.secondary} 82%, ${palette.button} 18%)`)
  root.style.setProperty('--theme-button', palette.button)
  root.style.setProperty('--theme-button-hover', buttonHover)
  root.style.setProperty('--theme-button-text', readableTextColor(palette.button))
  root.style.setProperty('--theme-font', palette.font)
  root.style.setProperty('--theme-success', palette.success)
  root.style.setProperty('--theme-danger', palette.danger)
  root.style.setProperty('--theme-danger-text', readableTextColor(palette.danger))
  root.style.setProperty('--theme-warning', palette.warning)
  root.style.setProperty('--theme-info', palette.info)
  root.style.setProperty('--theme-muted', `color-mix(in srgb, ${palette.font} 68%, ${palette.secondary})`)
  root.style.setProperty('--theme-accent-soft', `color-mix(in srgb, ${palette.secondary} 86%, ${palette.button} 14%)`)
  root.style.setProperty('--theme-accent-strong', `color-mix(in srgb, ${palette.secondary} 72%, ${palette.button} 28%)`)
  root.style.setProperty('--theme-neutral-soft', `color-mix(in srgb, ${palette.secondary} 88%, ${palette.font} 12%)`)
  root.style.setProperty('--theme-focus-ring', `color-mix(in srgb, ${palette.button} 22%, transparent)`)
}

function toggleThemeMode() {
  themeSettings.value.mode = themeSettings.value.mode === 'dark' ? 'light' : 'dark'
  applyThemeToDocument()
  persist()
}

function updateThemeColor(mode: ThemeMode, key: ThemeColorKey, value: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value.trim())) return
  themeSettings.value[mode][key] = value.trim().toLowerCase()
  applyThemeToDocument()
  persist()
}

function resetThemeSettings() {
  const mode = themeSettings.value.mode
  themeSettings.value = {
    ...cloneThemeSettings(defaultThemeSettings),
    mode,
  }
  applyThemeToDocument()
  persist()
}

watch(themeSettings, applyThemeToDocument, { deep: true })
applyThemeToDocument()

const viewport = ref({ width: window.innerWidth, height: window.innerHeight })
const agentPosition = ref({ x: Math.max(16, window.innerWidth - 74), y: Math.max(16, window.innerHeight - 74) })
const agentDragging = ref(false)
const agentDragOffset = ref({ x: 0, y: 0 })
const suppressAgentClick = ref(false)
let agentPointerId: number | null = null

type ResourceGroupSection = ResourceGroup & { resources: Resource[] }

const chapterSearch = ref('')
const {
  activeChapter,
  visibleVolumes,
  normalizedChapterSearch,
  filteredChapters,
  chapterCountByVolume,
  cancelDeleteChapter,
  requestDeleteChapter,
  confirmDeleteChapter,
  formatChapterContent,
  toggleEditorTools,
  copyChapterAsPlainText,
  volumeForChapter,
  chaptersForVolume,
  toggleVolume,
  updateVolumeTitle,
  updateChapterTitle,
  chapterDisplayTitle,
  jumpToLastChapter,
  createChapter,
  createVolume,
  selectChapter,
  updateChapterContent,
  updateChapterTaskGoal,
  addChapterCast,
  commitChapterCast,
  removeChapterCast,
} = useChapterController({
  store,
  selectedChapterId,
  selectedVolumeId,
  chapterSearch,
  candidate,
  chapterDeleteOpen,
  editorToolsOpen,
  formatIndentSpaces,
  copyFeedback,
  castDraft,
  closeParagraphEdit: () => closeParagraphEdit(),
  persist: () => persist(),
})
const currentConfig = computed(() => activePage.value === 'writer' || activePage.value === 'context' || activePage.value === 'agent' || activePage.value === 'json' || activePage.value === 'custom' || activePage.value === 'memes' || activePage.value === 'worldEngine' ? null : pageConfig[activePage.value])
const pageTitle = computed(() => activePage.value === 'writer'
  ? activeChapter.value.title
  : activePage.value === 'agent'
    ? 'AI Agent'
    : activePage.value === 'json'
      ? 'JSON 结构查看器'
      : activePage.value === 'custom'
        ? '自定义模块'
        : activePage.value === 'memes'
          ? '网络热梗'
    : activePage.value === 'worldEngine'
      ? '世界引擎'
      : (currentConfig.value?.title ?? '上下文编排'))
const activeCollection = computed<Resource[]>(() => currentConfig.value ? (store.value[currentConfig.value.collection] as Resource[]) : [])
const selectedResource = computed(() => activeCollection.value.find((item) => item.id === selectedIds.value[activePage.value]) ?? activeCollection.value[0])
type CustomModulePanelFieldType = 'string' | 'text' | 'longText' | 'number' | 'enum' | 'boolean' | 'tags' | 'characterIndex' | 'itemIndex' | 'skillIndex'
type CustomModulePanelField = {
  id: string
  key: string
  label: string
  type: CustomModulePanelFieldType
  description?: string
  placeholder?: string
  defaultValue?: unknown
  options?: string[]
  locked?: boolean
}
type CustomModulePanelEntry = { id: string; title: string; data: Record<string, unknown>; lockedAll?: boolean; lockedFields?: string[] }
type CustomModulePanelDefinition = { id: string; name: string; description?: string; titleField?: string; fields: CustomModulePanelField[]; entries: CustomModulePanelEntry[]; lockedAll?: boolean }
const customModulePanelData = computed<CustomModulePanelDefinition[]>(() => {
  const customStore = store.value.customModules
  if (!customStore) return []
  return customStore.schemas.map((schema) => ({
    id: schema.id,
    name: schema.title,
    description: schema.description,
    titleField: schema.titleField,
    lockedAll: schema.lockedAll === true,
    fields: schema.fields.map((field) => ({ ...field, type: field.type as CustomModulePanelFieldType })),
    entries: customStore.entries
      .filter((entry) => entry.schemaId === schema.id)
      .map((entry) => ({
        id: entry.id,
        title: entry.title ?? String(entry.data[schema.titleField ?? ''] ?? `未命名${schema.title}`),
        data: { ...entry.data },
        lockedAll: entry.lockedAll === true,
        lockedFields: entry.lockedFields ?? [],
      })),
  }))
})
const customSelectedModuleId = computed(() => selectedIds.value.custom ?? customModulePanelData.value[0]?.id ?? '')
type MemePanelEntry = { id?: string; name: string; content: string; explanation?: string; source?: string; sourceUrl?: string; date?: string; tags?: string[]; createdBy?: 'agent' | 'manual'; enabled?: boolean }
type WebMemeResult = { title?: string; url?: string; snippet?: string; publishedAt?: string; source?: string }
const memeCandidates = ref<MemePanelEntry[]>([])
const memeSearchBusy = ref(false)
const memePanelEntries = computed(() => (store.value.memes?.entries ?? []).map((meme) => ({
  id: meme.id,
  name: meme.name,
  content: meme.usage || meme.explanation || meme.name,
  explanation: meme.explanation,
  source: meme.source,
  sourceUrl: meme.sourceUrl || (meme.source.startsWith('http') ? meme.source : undefined),
  date: meme.date,
  tags: meme.keywords,
  createdBy: meme.creationSource,
  enabled: meme.enabled,
})))
const selectedProvider = computed(() => store.value.providers.find((item) => item.id === selectedIds.value.api) ?? store.value.providers[0])
const defaultProvider = computed(() => store.value.providers.find((item) => item.enabled === true) ?? store.value.providers[0])
const agentProvider = computed(() => store.value.providers.find((item) => item.id === agentProviderId.value) ?? defaultProvider.value)
const agentProviderSelectionId = computed(() => agentProvider.value?.id ?? '')
const writerProvider = computed(() => store.value.providers.find((item) => item.id === writerProviderId.value) ?? defaultProvider.value)
const writerProviderSelectionId = computed(() => writerProvider.value?.id ?? '')
const worldEngineProvider = computed(() => store.value.providers.find((item) => item.id === worldEngineProviderId.value) ?? defaultProvider.value)
const worldEngineProviderSelectionId = computed(() => worldEngineProvider.value?.id ?? '')
const inferredCast = computed(() => {
  const text = `${activeChapter.value?.taskGoal ?? ''} ${activeChapter.value?.content ?? ''}`
  return store.value.characters.filter((character) => character.title.trim() && text.includes(character.title.trim())).map((character) => character.title)
})
const effectiveCast = computed(() => activeChapter.value?.cast?.length ? activeChapter.value.cast : inferredCast.value)
const writerRetrievalTerms = computed(() => [
  '正文续写 章节目标 场景 人物 道具 技能 世界设定',
  activeChapter.value?.taskGoal ?? '',
  ...(activeChapter.value?.cast?.length ? activeChapter.value.cast : inferredCast.value),
].filter(Boolean).join(' '))
const agentModelLabel = computed(() => {
  const provider = agentProvider.value
  const model = provider?.fields['模型']?.trim()
  return model ? `${provider.title} · ${model}` : '本地执行模式 · 尚未绑定模型'
})
const canSwitchAgentConversation = computed(() => !agentBusy.value && !agentPendingPlan.value)
const latestUndoableHistoryId = computed(() => agentHistory.value.find((entry) => entry.status === 'applied')?.id ?? '')
const agentFabStyle = computed(() => ({ left: `${agentPosition.value.x}px`, top: `${agentPosition.value.y}px` }))
const agentDrawerStyle = computed(() => {
  const width = Math.min(900, Math.max(280, viewport.value.width - 40))
  const height = Math.min(760, Math.max(360, viewport.value.height - 40))
  const maxLeft = Math.max(10, viewport.value.width - width - 10)
  const maxTop = Math.max(10, viewport.value.height - height - 10)
  let left = agentPosition.value.x - width + 50
  let top = agentPosition.value.y - height - 12
  if (left < 10) left = Math.min(agentPosition.value.x, maxLeft)
  if (top < 10) top = Math.min(agentPosition.value.y + 60, maxTop)
  return { left: `${Math.max(10, Math.min(left, maxLeft))}px`, top: `${Math.max(10, Math.min(top, maxTop))}px` }
})
const contextLayout = computed(() => ensureContextLayout(store.value))
const contextTokens = computed(() => contextLayout.value
  .filter((block) => block.enabled)
  .reduce((sum, block) => {
    const items = block.items ?? []
    const enabledItems = items.filter((item) => item.enabled !== false)
    return sum + (enabledItems.length ? enabledItems.reduce((itemSum, item) => itemSum + item.tokens, 0) : block.tokens)
  }, 0))

/**
 * Keep non-card prompt blocks live as well. Card and custom-module items are
 * recalculated by syncContextResourceItems; these blocks come from the current
 * chapter/runtime prompt and therefore need a small runtime estimator.
 * The value remains a local estimate, never a provider tokenizer count.
 */
function refreshLiveContextTokens() {
  const groups = ensureContextLayout(store.value)
  const chapter = activeChapter.value
  const cast = effectiveCast.value
  const liveText: Record<string, string> = {
    system: '系统约束：遵守作品资料、锁定字段、结构化响应和当前应用规则。',
    chapter: [
      `当前章节：${chapter?.title ?? ''}`,
      `本章任务：${chapter?.taskGoal ?? '未指定'}`,
      `出场人物：${cast.length ? cast.join('、') : '未指定'}`,
      ...store.value.outline
        .filter((node) => node.outlineStartChapterId === chapter?.id || node.outlineEndChapterId === chapter?.id)
        .map((node) => `${node.title}\n${node.summary}\n${Object.entries(node.fields ?? {}).map(([key, value]) => `${key}：${value}`).join('\n')}`),
    ].filter(Boolean).join('\n'),
    recent: `当前章节正文：
${chapter?.content || '（空）'}`,
    output: '输出要求：只输出可接在正文后的中文小说正文，不要标题、说明或 Markdown。',
    worldEngine: formatWorldEngineContext(store.value.worldEngine),
  }
  for (const group of groups) {
    const text = liveText[group.collection ?? '']
    if (!text) continue
    const staticItems = (group.items ?? []).filter((item) => !item.resourceId && !item.resourceIds?.length && !item.customModuleId)
    if (!staticItems.length) {
      // A resource block with no cards is intentionally shown as zero. For
      // static blocks, keep the aggregate live even if an old snapshot had no
      // nested item.
      if (['system', 'chapter', 'recent', 'output', 'worldEngine'].includes(group.collection ?? '')) {
        group.tokens = Math.max(16, estimateTextTokens(text))
      }
      continue
    }
    const tokens = Math.max(16, estimateTextTokens(text))
    staticItems[0].tokens = tokens
    group.tokens = tokens + staticItems.slice(1).reduce((sum, item) => sum + item.tokens, 0)
  }
}
const retrievedContextPreview = computed(() => retrievedContext(writerRetrievalTerms.value, effectiveCast.value).matches)
const activeGroupPage = computed<GroupedResourcePage | null>(() => isGroupedResourcePage(activePage.value) ? activePage.value : null)
const {
  paragraphEdit,
  openParagraphEdit,
  closeParagraphEdit,
  updateParagraphInstruction,
  requestParagraphEdit,
  applyParagraphEdit,
} = useParagraphEditing({
  activeChapter,
  writerProvider,
  effectiveCast,
  getChapter: (id) => store.value.chapters.find((chapter) => chapter.id === id),
  isApiConfigured,
  retrievedContext: (extra, cast) => retrievedContext(extra, cast),
  formatStyleRulesContext,
  localApiUrl,
  updateChapterContent,
})
const activeGroups = computed(() => activeGroupPage.value ? store.value.resourceGroups[activeGroupPage.value] : [])
const selectedGroupIds = ref<Record<GroupedResourcePage, string>>({ world: '', characters: '', items: '', skills: '', style: '' })
const ungroupedCollapsed = ref<Record<GroupedResourcePage, boolean>>({ world: false, characters: false, items: false, skills: false, style: false })
const selectedGroupId = computed(() => activeGroupPage.value ? selectedGroupIds.value[activeGroupPage.value] : '')
const resourceGroupSections = computed<ResourceGroupSection[]>(() => {
  if (!activeGroupPage.value || !activeGroups.value.length) return []
  const page = activeGroupPage.value
  const sections = activeGroups.value.map((group) => ({
    ...group,
    resources: activeCollection.value.filter((item) => item.groupId === group.id),
  }))
  const ungrouped = activeCollection.value.filter((item) => !item.groupId)
  if (ungrouped.length) sections.unshift({ id: '__ungrouped__', title: '未分组', collapsed: ungroupedCollapsed.value[page], resources: ungrouped })
  return sections
})

const outlineChildMap = computed<Record<string, Resource[]>>(() => {
  const nodes = activePage.value === 'outline' ? activeCollection.value : store.value.outline
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const result: Record<string, Resource[]> = {}
  const createsCycle = (nodeId: string, parentId: string) => {
    const seen = new Set<string>()
    let cursor: string | undefined = parentId
    while (cursor && !seen.has(cursor)) {
      if (cursor === nodeId) return true
      seen.add(cursor)
      cursor = byId.get(cursor)?.outlineParentId
    }
    return false
  }
  for (const node of nodes) {
    const parentId = node.outlineParentId
    if (!parentId || !byId.has(parentId) || parentId === node.id || createsCycle(node.id, parentId)) continue
    ;(result[parentId] ??= []).push(node)
  }
  for (const children of Object.values(result)) {
    children.sort((a, b) => (a.injectionOrder ?? 100) - (b.injectionOrder ?? 100))
  }
  return result
})
const outlineRoots = computed(() => {
  if (activePage.value !== 'outline') return []
  const childIds = new Set(Object.values(outlineChildMap.value).flat().map((node) => node.id))
  const typeRank: Record<string, number> = { book: 0, volume: 1, chapterRange: 2, scene: 3 }
  return activeCollection.value
    .filter((node) => !childIds.has(node.id))
    .sort((a, b) => (typeRank[a.outlineType ?? 'chapterRange'] ?? 2) - (typeRank[b.outlineType ?? 'chapterRange'] ?? 2))
})

watch(() => activeChapter.value?.id, () => {
  castDraft.value = ''
  closeParagraphEdit()
})
const resourceGroupDialogOpen = ref(false)
const resourceGroupTitle = ref('')
const resourceGroupEditingId = ref<string | null>(null)
const draggedResourceId = ref<string | null>(null)
const draggedResourceGroupId = ref<string | null>(null)
const dropTargetGroupId = ref<string | null>(null)
const modalPointerDownTarget = ref<EventTarget | null>(null)

type HoldingType = 'items' | 'skills'
type HoldingPickerState = { type: HoldingType; characterId: string }
type CardDetailState = { type: HoldingType; id: string }
const holdingPicker = ref<HoldingPickerState | null>(null)
const cardDetail = ref<CardDetailState | null>(null)
const holdingPickerResources = computed(() => holdingPicker.value?.type === 'skills' ? store.value.skills : store.value.items)
const cardDetailResource = computed(() => {
  if (!cardDetail.value) return undefined
  const collection = cardDetail.value.type === 'skills' ? store.value.skills : store.value.items
  return collection.find((item) => item.id === cardDetail.value?.id)
})

/** Style rules are author-wide settings and survive project resets. */
const globalStyleRules = ref<Resource[] | null>(null)
const globalStyleGroups = ref<ResourceGroup[] | null>(null)

type PersistedAppState = {
  version: 2
  updatedAt: number
  store: Store
  ui: {
    activePage: PageKey
    selectedChapterId: string
    selectedVolumeId?: string
    selectedIds: Record<string, string>
    agentProviderId?: string
    writerProviderId?: string
    worldEngineProviderId?: string
    currentWorkTitle: string
    agentPosition: { x: number; y: number }
  }
  agentHistory: AgentHistoryEntry[]
  agentHistoryLimit: number
  /** Conversation transcript for the active work and older single-project saves. */
  agentMessages?: AgentMessage[]
  /** Named Agent conversations for newer desktop/browser saves. */
  agentConversations?: AgentConversation[]
  /** Active Agent conversation id for newer desktop/browser saves. */
  activeAgentConversationId?: string
  currentProjectId?: string
  projects?: ProjectRecord[]
  settings?: {
    autoSaveSeconds?: number
    formatIndentSpaces?: number
    qyBackupCount?: number
    theme?: ThemeSettings
    resourcePromptHints?: unknown
  }
}

function projectDataStore(sourceStore: Store) {
  const snapshot = cloneSerializable(sourceStore)
  snapshot.providers = []
  snapshot.modelOptions = {}
  snapshot.style = []
  snapshot.resourceGroups.style = []
  return snapshot
}

function captureProjectSnapshot(sourceStore = store.value): ProjectSnapshot {
  syncActiveAgentConversation()
  return {
    store: projectDataStore(sourceStore),
    selectedChapterId: selectedChapterId.value,
    selectedVolumeId: selectedVolumeId.value,
    selectedIds: cloneSerializable(selectedIds.value),
    agentProviderId: agentProviderId.value,
    writerProviderId: writerProviderId.value,
    worldEngineProviderId: worldEngineProviderId.value,
    agentMode: agentMode.value,
    agentHistory: cloneSerializable(agentHistory.value),
    agentMessages: cloneSerializable(normalizeAgentMessages(agentMessages.value, agentPersistedMessageLimit)),
    agentConversations: cloneSerializable(agentConversations.value),
    activeAgentConversationId: activeAgentConversationId.value,
  }
}

function syncCurrentProjectRecord() {
  if (!currentProjectId.value) return
  const index = projects.value.findIndex((project) => project.id === currentProjectId.value)
  if (index < 0) return
  const existing = projects.value[index]
  projects.value[index] = {
    ...existing,
    title: currentWorkTitle.value,
    updatedAt: Date.now(),
    snapshot: captureProjectSnapshot(),
  }
}

function saveProjectRegistry() {
  syncCurrentProjectRecord()
  localStorage.setItem(projectsStorageKey, JSON.stringify({ currentProjectId: currentProjectId.value, projects: projects.value }))
}

function restoreProjectRecord(project: ProjectRecord) {
  // Any in-flight Agent request belongs to the previous project. Invalidate
  // it before swapping the store so a late response cannot write into the new
  // work.
  agentRunEpoch += 1
  agentAbortController?.abort()
  agentAbortController = undefined
  agentBusy.value = false
  agentLiveResponse.value = null
  agentActivities.value = []
  memeSearchBusy.value = false
  memeCandidates.value = []
  const savedStore = cloneSerializable(project.snapshot.store)
  savedStore.providers = cloneSerializable(store.value.providers)
  savedStore.modelOptions = cloneSerializable(store.value.modelOptions)
  savedStore.style = cloneSerializable(globalStyleRules.value ?? store.value.style)
  savedStore.resourceGroups.style = cloneSerializable(globalStyleGroups.value ?? store.value.resourceGroups.style)
  ensureVolumeData(savedStore)
  currentProjectId.value = project.id
  currentWorkTitle.value = project.title
  store.value = savedStore
  selectedChapterId.value = savedStore.chapters.some((chapter) => chapter.id === project.snapshot.selectedChapterId)
    ? project.snapshot.selectedChapterId
    : savedStore.chapters[0]?.id ?? ''
  selectedVolumeId.value = savedStore.volumes.some((volume) => volume.id === project.snapshot.selectedVolumeId)
    ? project.snapshot.selectedVolumeId
    : savedStore.chapters.find((chapter) => chapter.id === selectedChapterId.value)?.volumeId ?? savedStore.volumes[0]?.id ?? ''
  selectedIds.value = { ...project.snapshot.selectedIds }
  agentProviderId.value = project.snapshot.agentProviderId ?? ''
  writerProviderId.value = project.snapshot.writerProviderId ?? ''
  worldEngineProviderId.value = project.snapshot.worldEngineProviderId ?? ''
  agentMode.value = project.snapshot.agentMode === 'inspiration' ? 'inspiration' : 'writing'
  agentHistory.value = cloneSerializable(project.snapshot.agentHistory ?? []).slice(0, agentHistoryLimit.value)
  const projectHasConversationData = Object.prototype.hasOwnProperty.call(project.snapshot, 'agentConversations')
    || Object.prototype.hasOwnProperty.call(project.snapshot, 'agentMessages')
  if (projectHasConversationData || !agentConversations.value.length) {
    restoreAgentConversationState(project.snapshot.agentConversations, project.snapshot.activeAgentConversationId, project.snapshot.agentMessages)
  } else {
    syncActiveAgentConversation()
  }
  activePage.value = 'writer'
  agentPendingPlan.value = null
  candidate.value = ''
  generationError.value = ''
  providerTest.value = ''
  apiError.value = ''
}

async function refreshRecentQyFiles() {
  if (!isDesktopRuntime || !window.desktopFile) return
  try {
    recentQyFiles.value = await window.desktopFile.recent()
  } catch {
    recentQyFiles.value = []
  }
}

async function restoreLastQyFile() {
  if (qyStartupRestoreAttempted || !isDesktopRuntime || !window.desktopFile) return
  qyStartupRestoreAttempted = true
  await refreshRecentQyFiles()
  const latest = recentQyFiles.value[0]
  if (latest) await openRecentQyFile(latest.path)
}

function resetWorkRuntimeAfterFileOpen() {
  agentRunEpoch += 1
  agentAbortController?.abort()
  agentAbortController = undefined
  agentBusy.value = false
  agentLiveResponse.value = null
  agentActivities.value = []
  memeSearchBusy.value = false
  memeCandidates.value = []
  candidate.value = ''
  generationError.value = ''
  providerTest.value = ''
  apiError.value = ''
  agentOpen.value = false
  activePage.value = 'writer'
  restoreAgentConversationState(undefined, undefined, undefined)
}

function upsertCurrentProjectRecord() {
  const id = currentProjectId.value || `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  currentProjectId.value = id
  const record: ProjectRecord = {
    id,
    title: currentWorkTitle.value,
    updatedAt: Date.now(),
    snapshot: captureProjectSnapshot(),
  }
  const index = projects.value.findIndex((project) => project.id === id)
  if (index >= 0) projects.value[index] = record
  else projects.value.unshift(record)
}

function applyQyDocument(document: QyDocument, filePath: string) {
  qyAutosaveSuppressed = true
  const imported = mergeQyContent(document, store.value)
  ensureVolumeData(imported)
  syncContextResourceItems(imported)
  store.value = imported
  globalStyleRules.value = cloneSerializable(imported.style)
  globalStyleGroups.value = cloneSerializable(imported.resourceGroups.style)
  currentQyPath.value = filePath
  currentWorkTitle.value = document.title.trim()
  selectedChapterId.value = imported.chapters[0]?.id ?? ''
  selectedVolumeId.value = imported.chapters.find((chapter) => chapter.id === selectedChapterId.value)?.volumeId ?? imported.volumes[0]?.id ?? ''
  selectedIds.value = {
    world: imported.world[0]?.id ?? '',
    characters: imported.characters[0]?.id ?? '',
    items: imported.items[0]?.id ?? '',
    skills: imported.skills[0]?.id ?? '',
    outline: imported.outline[0]?.id ?? '',
    worldEngine: '',
    style: imported.style[0]?.id ?? '',
    api: store.value.providers[0]?.id ?? '',
  }
  resetWorkRuntimeAfterFileOpen()
  upsertCurrentProjectRecord()
  qyFileError.value = ''
  persist()
  qyAutosaveSuppressed = false
}

async function openQyFile() {
  if (!isDesktopRuntime || !window.desktopFile || qyFileBusy.value) return
  qyFileBusy.value = true
  qyFileError.value = ''
  try {
    const result = await window.desktopFile.open()
    if (result.canceled) return
    if (result.error || !result.document || !result.path) throw new Error(result.error || '读取作品文件失败')
    applyQyDocument(parseQyDocument(result.document), result.path)
    await refreshRecentQyFiles()
  } catch (error) {
    qyFileError.value = error instanceof Error ? error.message : '读取作品文件失败'
  } finally {
    qyFileBusy.value = false
  }
}

async function openRecentQyFile(filePath: string) {
  if (!isDesktopRuntime || !window.desktopFile || qyFileBusy.value) return
  qyFileBusy.value = true
  qyFileError.value = ''
  try {
    const result = await window.desktopFile.openPath(filePath)
    if (result.error || !result.document || !result.path) throw new Error(result.error || '读取作品文件失败')
    applyQyDocument(parseQyDocument(result.document), result.path)
    await refreshRecentQyFiles()
  } catch (error) {
    qyFileError.value = error instanceof Error ? error.message : '读取作品文件失败'
    await refreshRecentQyFiles()
  } finally {
    qyFileBusy.value = false
  }
}

async function removeRecentQyFile(filePath: string) {
  await window.desktopFile?.removeRecent(filePath)
  await refreshRecentQyFiles()
}

async function saveQyFile(saveAs = false) {
  if (!isDesktopRuntime || !window.desktopFile || qyFileBusy.value) return
  qyFileBusy.value = true
  qyFileError.value = ''
  try {
    const document = createQyDocument(store.value, currentWorkTitle.value)
    const result = await window.desktopFile.save(document, currentQyPath.value || undefined, { saveAs, backupCount: qyBackupCount.value })
    if (result.canceled) return
    if (result.error || !result.path) throw new Error(result.error || '保存作品文件失败')
    currentQyPath.value = result.path
    if (result.title && !currentWorkTitle.value.trim()) currentWorkTitle.value = result.title
    saveState.value = '已保存'
    await refreshRecentQyFiles()
  } catch (error) {
    qyFileError.value = error instanceof Error ? error.message : '保存作品文件失败'
  } finally {
    qyFileBusy.value = false
  }
}

async function saveCurrentQyFileSilently() {
  if (!isDesktopRuntime || !window.desktopFile || !currentQyPath.value || qyFileBusy.value || qyAutosaveInProgress) return
  qyAutosaveInProgress = true
  try {
    const result = await window.desktopFile.save(createQyDocument(store.value, currentWorkTitle.value), currentQyPath.value, { backupCount: qyBackupCount.value })
    if (result.error) qyFileError.value = result.error
    else if (result.path) currentQyPath.value = result.path
  } catch (error) {
    qyFileError.value = error instanceof Error ? error.message : '自动保存作品文件失败'
  } finally {
    qyAutosaveInProgress = false
  }
}

function createNewQyFile() {
  if (saveState.value === '未保存' && !window.confirm('当前作品有未保存修改，确定新建空白作品文件吗？')) return
  createNewProject()
  currentQyPath.value = ''
  qyFileError.value = ''
}

function validProjectRecords(value: unknown): value is ProjectRecord[] {
  return Array.isArray(value) && value.every((project) => Boolean(
    project && typeof project === 'object'
    && typeof project.id === 'string'
    && typeof project.title === 'string'
    && project.snapshot && typeof project.snapshot === 'object'
    && project.snapshot.store && Array.isArray(project.snapshot.store.chapters),
  ))
}

function normalizeBlankProjectDefaults(project: ProjectRecord): ProjectRecord {
  const normalized = cloneSerializable(project)
  const snapshotStore = normalized.snapshot.store
  const hasContent = snapshotStore.chapters.some((chapter) => Boolean(
    (chapter.content ?? '').trim()
    || chapter.taskGoal?.trim()
    || chapter.cast?.length,
  ))
  const hasWorkResources = Boolean(
    snapshotStore.world?.length
    || snapshotStore.characters?.length
    || snapshotStore.items?.length
    || snapshotStore.skills?.length
    || snapshotStore.outline?.length
    || snapshotStore.worldEngine?.events?.length
    || snapshotStore.worldEngine?.characterStates?.length
    || snapshotStore.customModules?.entries?.length,
  )
  if (hasContent || hasWorkResources) return normalized

  if (normalized.title === '新作品' || normalized.title === '雾港来信') normalized.title = ''
  snapshotStore.volumes = (snapshotStore.volumes ?? []).map((volume) => ({
    ...volume,
    title: /^(?:第一卷(?:\s*[·•]\s*失踪船)?|未命名分卷)$/.test(volume.title.trim()) ? '' : volume.title,
  }))
  snapshotStore.chapters = (snapshotStore.chapters ?? []).map((chapter) => ({
    ...chapter,
    title: chapter.title.replace(/^(\d+)\s+未命名章节$/, '$1'),
  }))
  return normalized
}

function restoreProjectRegistry(records: ProjectRecord[], activeId?: string) {
  if (!validProjectRecords(records) || !records.length) return false
  projects.value = records.map((project) => normalizeBlankProjectDefaults(project))
  const active = projects.value.find((project) => project.id === activeId) ?? projects.value[0]
  restoreProjectRecord(active)
  return true
}

function migrateCurrentProject() {
  const id = `project-${Date.now()}`
  const currentProject = normalizeBlankProjectDefaults({
    id,
    title: currentWorkTitle.value,
    updatedAt: Date.now(),
    snapshot: captureProjectSnapshot(),
  })
  const record: ProjectRecord = currentProject
  projects.value = [record]
  currentProjectId.value = id
}

function persistGlobalSettings() {
  if (isDesktopRuntime) return
  try {
    localStorage.setItem(globalSettingsStorageKey, JSON.stringify({
      providers: store.value.providers,
      modelOptions: store.value.modelOptions,
      style: cloneSerializable(store.value.style),
      styleGroups: cloneSerializable(store.value.resourceGroups.style),
      autoSaveSeconds: autoSaveSeconds.value,
      formatIndentSpaces: formatIndentSpaces.value,
      theme: cloneThemeSettings(themeSettings.value),
      resourcePromptHints: cloneSerializable(standardCreationPromptHints.value),
    }))
  } catch { /* local storage remains the fallback */ }
}

function restoreGlobalSettings() {
  const raw = readLocalCache(globalSettingsStorageKey)
  if (!raw) {
    persistGlobalSettings()
    return
  }
  try {
    const saved = JSON.parse(raw) as Partial<Pick<Store, 'providers' | 'modelOptions' | 'style'>> & { styleGroups?: unknown; autoSaveSeconds?: unknown; formatIndentSpaces?: unknown; theme?: unknown; resourcePromptHints?: unknown }
    if (Array.isArray(saved.providers)) store.value.providers = normalizeProviderDefaults(saved.providers)
    if (saved.modelOptions && typeof saved.modelOptions === 'object') store.value.modelOptions = saved.modelOptions
    if (Array.isArray(saved.style)) {
      globalStyleRules.value = saved.style.map((style) => ({ ...style, enabled: style.enabled !== false }))
      store.value.style = cloneSerializable(globalStyleRules.value)
    } else {
      globalStyleRules.value = cloneSerializable(store.value.style)
    }
    if (Array.isArray(saved.styleGroups)) {
      globalStyleGroups.value = saved.styleGroups.filter((group): group is ResourceGroup => Boolean(group && typeof group === 'object' && typeof (group as ResourceGroup).id === 'string' && typeof (group as ResourceGroup).title === 'string')).map((group) => ({ ...group, collapsed: group.collapsed === true }))
      store.value.resourceGroups.style = cloneSerializable(globalStyleGroups.value)
    } else {
      globalStyleGroups.value = cloneSerializable(store.value.resourceGroups.style)
    }
    if (typeof saved.autoSaveSeconds === 'number' && autoSaveOptions.includes(saved.autoSaveSeconds as typeof autoSaveOptions[number])) autoSaveSeconds.value = saved.autoSaveSeconds
    if (typeof saved.formatIndentSpaces === 'number' && [0, 1, 2, 4].includes(saved.formatIndentSpaces)) formatIndentSpaces.value = saved.formatIndentSpaces
    if (saved.theme) themeSettings.value = normalizeThemeSettings(saved.theme)
    if (saved.resourcePromptHints && typeof saved.resourcePromptHints === 'object') {
      standardCreationPromptHints.value = normalizeStandardCreationPromptHints(saved.resourcePromptHints)
    }
    applyThemeToDocument()
  } catch { /* use the main store */ }
}

function persistedAppState(): PersistedAppState {
  syncActiveAgentConversation()
  syncCurrentProjectRecord()
  return {
    version: 2,
    updatedAt: Math.max(Date.now(), remoteRevision + 1),
    currentProjectId: currentProjectId.value,
    projects: cloneSerializable(projects.value),
    store: cloneSerializable(store.value),
    ui: {
      activePage: activePage.value,
      selectedChapterId: selectedChapterId.value,
      selectedVolumeId: selectedVolumeId.value,
      selectedIds: cloneSerializable(selectedIds.value),
      agentProviderId: agentProviderId.value,
      writerProviderId: writerProviderId.value,
      worldEngineProviderId: worldEngineProviderId.value,
      currentWorkTitle: currentWorkTitle.value,
      agentPosition: cloneSerializable(agentPosition.value),
    },
    agentHistory: cloneSerializable(agentHistory.value),
    agentHistoryLimit: agentHistoryLimit.value,
    agentMessages: cloneSerializable(normalizeAgentMessages(agentMessages.value, agentPersistedMessageLimit)),
    agentConversations: cloneSerializable(agentConversations.value),
    activeAgentConversationId: activeAgentConversationId.value,
    settings: {
      autoSaveSeconds: autoSaveSeconds.value,
      formatIndentSpaces: formatIndentSpaces.value,
      qyBackupCount: qyBackupCount.value,
      theme: cloneThemeSettings(themeSettings.value),
      resourcePromptHints: cloneSerializable(standardCreationPromptHints.value),
    },
  }
}

function enqueueRemotePersistence(state: PersistedAppState, allowProjectDeletion: boolean, keepalive = false) {
  const write = remotePersistenceQueue.then(async () => {
    if (!remotePersistenceReady.value) throw new Error(remotePersistenceError.value || '本机存储服务不可用')
    const response = await fetch(localApiUrl('/api/storage'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, expectedUpdatedAt: remoteRevision, allowProjectDeletion }),
      keepalive,
      signal: keepalive ? undefined : AbortSignal.timeout(15000),
    })
    const result = await response.json().catch(() => null) as { ok?: boolean; conflict?: boolean; updatedAt?: number; error?: string } | null
    if (response.status === 409) {
      remotePersistenceReady.value = false
      remotePersistenceError.value = result?.error || '本地作品已在其他窗口更新。为避免覆盖，已暂停保存，请重新启动桌面版。'
      saveState.value = '保存冲突'
      throw new Error(remotePersistenceError.value)
    }
    if (!response.ok || !result?.ok) throw new Error(result?.error || '写入本机存储失败')
    remoteRevision = Number(result.updatedAt ?? state.updatedAt)
    allowProjectDeletionUntilSaved = false
    remotePersistenceError.value = ''
    saveState.value = '已保存'
  })
  remotePersistenceQueue = write.then(() => undefined, () => undefined)
  return write
}

function scheduleRemotePersistence() {
  if (!remotePersistenceReady.value) return
  if (remotePersistenceTimer) window.clearTimeout(remotePersistenceTimer)
  remotePersistenceTimer = window.setTimeout(() => {
    remotePersistenceTimer = undefined
    const state = persistedAppState()
    if (!isDesktopRuntime) {
      try { localStorage.setItem(persistenceUpdatedAtKey, String(state.updatedAt)) } catch { /* remote persistence is authoritative */ }
    }
    void enqueueRemotePersistence(state, allowProjectDeletionUntilSaved).catch((error) => {
      if (saveState.value === '保存冲突') return
      // Keep the dirty flag after a transient write failure. Otherwise an
      // automatic save can fail once, report the error, and never retry until
      // the author edits the work again.
      autoSaveDirty = true
      remotePersistenceError.value = `写入本机文件失败：${error instanceof Error ? error.message : '未知错误'}。当前改动暂未同步到桌面存储。`
      saveState.value = '保存失败'
      scheduleAutoSave()
    })
  }, 250)
}

function ensureVolumeData(target: Store) {
  const legacy = target as Store & { volumes?: Volume[] }
  if (!Array.isArray(legacy.volumes) || !legacy.volumes.length) legacy.volumes = [{ id: 'volume-1', title: '', collapsed: false }]
  const savedGroups = target.resourceGroups ?? seed.resourceGroups
  target.resourceGroups = {
    world: savedGroups.world ?? [],
    characters: savedGroups.characters ?? [],
    items: savedGroups.items ?? [],
    skills: savedGroups.skills ?? [],
    style: savedGroups.style ?? [],
  }
  const validIds = new Set(legacy.volumes.map((volume) => volume.id))
  const fallbackId = legacy.volumes[0]?.id ?? seed.volumes[0].id
  target.chapters = (target.chapters ?? []).map((chapter, index) => ({
    ...chapter,
    id: chapter.id || `chapter-${index + 1}`,
    volumeId: typeof chapter.volumeId === 'string' && validIds.has(chapter.volumeId) ? chapter.volumeId : fallbackId,
  }))
  target.providers = normalizeProviderDefaults(target.providers ?? [])
  target.worldEngine = migrateWorldEngineState(target.worldEngine, Date.now(), target.characters ?? [])
  target.customModules = normalizeCustomModuleStore(target.customModules ?? seed.customModules)
  ensureContextLayout(target)
  for (const collection of ['world', 'characters', 'items', 'skills'] as const) {
    target[collection] = (target[collection] ?? []).map((resource) => normalizeResourceTriggers({
      ...resource,
      fields: (() => {
        const fields = { ...(resource.fields ?? {}) }
        if (fields['说明'] !== undefined && fields['内容'] === undefined) fields['内容'] = fields['说明']
        delete fields['说明']
        if (collection === 'characters') {
          if (fields['性别'] === undefined) fields['性别'] = ''
          if (fields['种族'] === undefined) fields['种族'] = ''
          if (fields['外貌'] === undefined) fields['外貌'] = ''
          const gender = fields['性别']
          const race = fields['种族']
          const appearance = fields['外貌']
          delete fields['性别']
          delete fields['种族']
          delete fields['外貌']
          return { '性别': gender, '种族': race, '外貌': appearance, ...fields }
        }
        return fields
      })(),
      allowRecursive: typeof resource.allowRecursive === 'boolean' ? resource.allowRecursive : false,
      allowFurtherRecursive: typeof resource.allowFurtherRecursive === 'boolean' ? resource.allowFurtherRecursive : false,
      injectionOrder: Number.isFinite(resource.injectionOrder) ? Math.max(0, resource.injectionOrder as number) : 100,
      lockedFields: Array.isArray(resource.lockedFields) ? [...new Set(resource.lockedFields.filter((field): field is string => typeof field === 'string' && field.trim().length > 0))] : [],
    }))
  }
  target.style = (target.style ?? []).map((resource) => ({ ...resource, fields: { ...(resource.fields ?? {}) }, enabled: resource.enabled !== false }))
  for (const collection of ['world', 'characters', 'items', 'skills', 'outline', 'style'] as const) {
    target[collection] = (target[collection] ?? []).map(normalizeResourceReviewMetadata)
  }
  normalizeOutlineHierarchy(target)
  // Outline nodes are ordinary resources, but their parent/chapter links form
  // a tree. Repair dangling links and cycles after legacy migration and
  // hierarchy defaults have been applied.
  target.outline = normalizeOutlineNodes(target.outline ?? [], target.chapters ?? [])
  syncContextResourceItems(target)
}

function normalizeProviderDefaults(providers: Resource[]) {
  const normalized = providers.map((provider) => ({
    ...provider,
    enabled: provider.enabled === true,
    fields: { '流式输出': 'true', ...(provider.fields ?? {}) },
  }))
  let defaultFound = false
  for (const provider of normalized) {
    if (!provider.enabled) continue
    if (defaultFound) provider.enabled = false
    else defaultFound = true
  }
  if (!defaultFound && normalized[0]) normalized[0].enabled = true
  return normalized
}

function applyPersistedAppState(state: PersistedAppState) {
  if (state.store && typeof state.store === 'object') {
    const nextStore = cloneSerializable(state.store)
    ensureVolumeData(nextStore)
    syncContextResourceItems(nextStore)
    store.value = nextStore
    globalStyleRules.value = cloneSerializable(nextStore.style)
    globalStyleGroups.value = cloneSerializable(nextStore.resourceGroups.style)
  }
  if (state.ui && typeof state.ui === 'object') {
    // API configuration lives in the global settings drawer now. Older
    // persisted UI state may still point at the removed API page, so restore
    // the writing surface and open the drawer instead of rendering a second
    // API editor.
    if (state.ui.activePage === 'api') {
      activePage.value = 'writer'
      settingsOpen.value = true
    } else if (state.ui.activePage) {
      activePage.value = state.ui.activePage
    }
    if (state.ui.selectedChapterId) selectedChapterId.value = state.ui.selectedChapterId
    if (state.ui.selectedVolumeId) selectedVolumeId.value = state.ui.selectedVolumeId
    if (state.ui.selectedIds && typeof state.ui.selectedIds === 'object') selectedIds.value = { ...selectedIds.value, ...state.ui.selectedIds }
    if (typeof state.ui.agentProviderId === 'string') agentProviderId.value = state.ui.agentProviderId
    if (typeof state.ui.writerProviderId === 'string') writerProviderId.value = state.ui.writerProviderId
    if (typeof state.ui.worldEngineProviderId === 'string') worldEngineProviderId.value = state.ui.worldEngineProviderId
    if (state.ui.currentWorkTitle) currentWorkTitle.value = state.ui.currentWorkTitle
    if (state.ui.agentPosition && typeof state.ui.agentPosition.x === 'number' && typeof state.ui.agentPosition.y === 'number') agentPosition.value = clampAgentPosition(state.ui.agentPosition.x, state.ui.agentPosition.y)
  }
  if ([10, 20, 50, 100].includes(state.agentHistoryLimit)) agentHistoryLimit.value = state.agentHistoryLimit
  if (Array.isArray(state.agentHistory)) agentHistory.value = state.agentHistory.slice(0, agentHistoryLimit.value)
  restoreAgentConversationState(state.agentConversations, state.activeAgentConversationId, state.agentMessages)
  const remoteAutoSaveSeconds = state.settings?.autoSaveSeconds
  if (typeof remoteAutoSaveSeconds === 'number' && autoSaveOptions.includes(remoteAutoSaveSeconds as typeof autoSaveOptions[number])) autoSaveSeconds.value = remoteAutoSaveSeconds
  const remoteFormatIndentSpaces = state.settings?.formatIndentSpaces
  if (typeof remoteFormatIndentSpaces === 'number' && [0, 1, 2, 4].includes(remoteFormatIndentSpaces)) formatIndentSpaces.value = remoteFormatIndentSpaces
  const remoteQyBackupCount = state.settings?.qyBackupCount
  if (typeof remoteQyBackupCount === 'number' && [0, 3, 5, 10, 20, 50].includes(remoteQyBackupCount)) qyBackupCount.value = remoteQyBackupCount
  if (state.settings?.theme) themeSettings.value = normalizeThemeSettings(state.settings.theme)
  if (state.settings?.resourcePromptHints && typeof state.settings.resourcePromptHints === 'object') {
    standardCreationPromptHints.value = normalizeStandardCreationPromptHints(state.settings.resourcePromptHints)
  }
  applyThemeToDocument()
}

async function hydrateRemotePersistence() {
  if (hydrationInProgress) return
  hydrationInProgress = true
  desktopStorageError.value = ''
  desktopHydrationController?.abort()
  desktopHydrationController = new AbortController()
  if (desktopHydrationTimeout) window.clearTimeout(desktopHydrationTimeout)
  // Never leave a desktop window behind an indefinite loading mask when a
  // stale port or system proxy prevents the local request from settling.
  // Keeping the gate in its error state is deliberate: persistence stays
  // disabled until a successful retry, so seed data cannot overwrite a work.
  desktopHydrationTimeout = window.setTimeout(() => {
    if (!hydrationInProgress) return
    desktopHydrationController?.abort()
    hydrationInProgress = false
    desktopStorageError.value = '读取本机存储超时。请确认应用没有被系统代理拦截，然后重试。'
    saveState.value = '存储不可用'
  }, 10000)
  let localRegistry: { currentProjectId?: string; projects?: ProjectRecord[] } | null = null
  const rawLocalRegistry = readLocalCache(projectsStorageKey)
  let localRegistryInvalid = false
  try {
    if (rawLocalRegistry) localRegistry = JSON.parse(rawLocalRegistry) as { currentProjectId?: string; projects?: ProjectRecord[] }
  } catch { localRegistryInvalid = true }
  try {
    const response = await fetch(localApiUrl('/api/storage'), { signal: desktopHydrationController.signal })
    if (!response.ok) throw new Error(`读取本机存储失败（HTTP ${response.status}）`)
    const body = await response.json().catch(() => null) as { ok?: boolean; state?: PersistedAppState | null } | null
    if (!body?.ok || !Object.prototype.hasOwnProperty.call(body, 'state')) throw new Error('本机存储返回的数据格式无效')
    const remoteState = body.state ?? null

    if (remoteState) {
      if (!remoteState.store || !Array.isArray(remoteState.store.chapters)) throw new Error('本机作品文件结构异常，已停止加载以保护数据')
      if (remoteState.projects !== undefined && !validProjectRecords(remoteState.projects)) throw new Error('本机作品列表结构异常，已停止加载以保护数据')
      remoteRevision = Number(remoteState.updatedAt || 0)
      applyPersistedAppState(remoteState)
      if (Array.isArray(remoteState.projects) && remoteState.projects.length) {
        if (!restoreProjectRegistry(remoteState.projects, remoteState.currentProjectId)) throw new Error('本机作品列表无法恢复，已停止加载以保护数据')
      } else {
        migrateCurrentProject()
      }
    } else {
      remoteRevision = 0
      restoreGlobalSettings()
      if (localRegistryInvalid) throw new Error('浏览器本地作品列表损坏，已停止迁移以保护数据')
      if (localRegistry?.projects?.length) {
        if (!restoreProjectRegistry(localRegistry.projects, localRegistry.currentProjectId)) throw new Error('浏览器本地作品无法恢复，已停止迁移以保护数据')
      } else if (readLocalCache(storageKey)) {
        migrateCurrentProject()
      } else {
        initializeBlankProject()
      }
    }

    remotePersistenceReady.value = true
    remotePersistenceError.value = ''
    desktopStorageHydrated.value = true
    hydrationInProgress = false
    // Allow Vue to paint the restored project before serializing it again.
    // This keeps a large first load from looking like an endless read.
    window.setTimeout(() => {
      persist()
      void restoreLastQyFile()
    }, 0)
  } catch (error) {
    hydrationInProgress = false
    const message = error instanceof Error ? error.message : '本机存储不可用'
    if (isDesktopRuntime) {
      desktopStorageError.value = `${message}。当前作品尚未加载，也不会写入默认内容。`
      saveState.value = '存储不可用'
      return
    }

    remotePersistenceReady.value = false
    remotePersistenceError.value = '服务端存储不可用；当前更改只保存在此浏览器。'
    restoreGlobalSettings()
    if (!localRegistryInvalid && localRegistry?.projects?.length && restoreProjectRegistry(localRegistry.projects, localRegistry.currentProjectId)) {
      desktopStorageHydrated.value = true
    } else if (readLocalCache(storageKey)) {
      migrateCurrentProject()
      desktopStorageHydrated.value = true
    } else {
      initializeBlankProject()
      desktopStorageHydrated.value = true
    }
    saveState.value = '仅保存在此浏览器'
    persist()
  } finally {
    if (desktopHydrationTimeout) {
      window.clearTimeout(desktopHydrationTimeout)
      desktopHydrationTimeout = undefined
    }
    desktopHydrationController = undefined
  }
}

function initializeBlankProject() {
  projects.value = []
  const project = createBlankProjectRecord('')
  projects.value = [project]
  restoreProjectRecord(project)
}

function retryDesktopStorage() {
  void hydrateRemotePersistence()
}

function reloadDesktopStorage() {
  if (!isDesktopRuntime || hydrationInProgress) return
  if (!window.confirm('本机文件中有更新版本。重新加载会放弃当前尚未同步的修改，确定继续吗？')) return
  void hydrateRemotePersistence()
}

function scheduleAutoSave() {
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  autoSaveTimer = undefined
  if (!autoSaveDirty || autoSaveSeconds.value <= 0 || (isDesktopRuntime && !desktopStorageHydrated.value)) return
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = undefined
    if (autoSaveDirty) persist()
  }, autoSaveSeconds.value * 1000)
}

function markDirty() {
  autoSaveDirty = true
  saveState.value = autoSaveSeconds.value > 0 ? '待自动保存' : '未保存'
  scheduleAutoSave()
}

function updateAutoSaveSeconds(value: number) {
  if (!autoSaveOptions.includes(value as typeof autoSaveOptions[number])) return
  autoSaveSeconds.value = value
  persist()
}

function updateQyBackupCount(value: number) {
  if (![0, 3, 5, 10, 20, 50].includes(value)) return
  qyBackupCount.value = value
  persist()
}

function persist(options: { allowProjectDeletion?: boolean } = {}) {
  if (isDesktopRuntime && !desktopStorageHydrated.value) return
  if (options.allowProjectDeletion) allowProjectDeletionUntilSaved = true
  const shouldAutoSaveQy = isDesktopRuntime && Boolean(currentQyPath.value) && !qyAutosaveSuppressed && autoSaveSeconds.value > 0
  autoSaveDirty = false
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  autoSaveTimer = undefined
  saveState.value = '保存中'
  if (!isDesktopRuntime) {
    try {
      saveProjectRegistry()
      localStorage.setItem(storageKey, JSON.stringify(store.value))
      localStorage.setItem(persistenceUpdatedAtKey, String(Date.now()))
      persistGlobalSettings()
    } catch (error) {
      remotePersistenceError.value = `浏览器本地缓存写入失败：${error instanceof Error ? error.message : '存储空间不足'}`
      saveState.value = '缓存失败'
    }
  }
  scheduleRemotePersistence()
  if (shouldAutoSaveQy) void saveCurrentQyFileSilently()
  if (!remotePersistenceReady.value) saveState.value = isDesktopRuntime ? '存储不可用' : '仅保存在此浏览器'
}

async function flushPersistence(keepalive = false): Promise<boolean> {
  if (isDesktopRuntime && !desktopStorageHydrated.value) return false
  autoSaveDirty = false
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  autoSaveTimer = undefined
  if (remotePersistenceTimer) window.clearTimeout(remotePersistenceTimer)
  remotePersistenceTimer = undefined
  if (!isDesktopRuntime) {
    const state = persistedAppState()
    try {
      localStorage.setItem(projectsStorageKey, JSON.stringify({ currentProjectId: currentProjectId.value, projects: projects.value }))
      localStorage.setItem(storageKey, JSON.stringify(state.store))
      localStorage.setItem(persistenceUpdatedAtKey, String(state.updatedAt))
      localStorage.setItem(`${storageKey}-ui`, JSON.stringify(state.ui))
      persistGlobalSettings()
      localStorage.setItem(agentHistoryStorageKey, JSON.stringify(state.agentHistory))
      localStorage.setItem(agentSettingsStorageKey, JSON.stringify({ historyLimit: state.agentHistoryLimit }))
    } catch { /* localStorage is an optional browser cache */ }
  }
  if (!remotePersistenceReady.value) return !isDesktopRuntime
  if (isDesktopRuntime) await remotePersistenceQueue
  if (!remotePersistenceReady.value) return false
  const state = persistedAppState()
  try {
    await enqueueRemotePersistence(state, allowProjectDeletionUntilSaved, keepalive)
    return true
  } catch (error) {
    if (saveState.value !== '保存冲突') {
      remotePersistenceError.value = `关窗保存失败：${error instanceof Error ? error.message : '未知错误'}`
      saveState.value = '保存失败'
    }
    return false
  }
}

function handleBeforeUnload() {
  if (isDesktopRuntime && (desktopFlushSucceeded || desktopFlushAbandoned)) return
  void flushPersistence(true)
}

watch(store, () => markDirty(), { deep: true })
// Keep the prompt-manager token display tied to live card/module content.
// Deliberately exclude contextGroups from this source: syncContextResourceItems
// updates that layout, and including it here would make a deep watcher loop.
watch(
  () => [
    store.value.world,
    store.value.characters,
    store.value.items,
    store.value.skills,
    store.value.customModules,
    store.value.outline,
    store.value.chapters,
    store.value.worldEngine,
  ],
  () => {
    syncContextResourceItems(store.value)
    refreshLiveContextTokens()
  },
  { deep: true },
)
watch(() => store.value.style, (styles) => {
  globalStyleRules.value = cloneSerializable(styles)
  syncContextResourceItems(store.value)
  refreshLiveContextTokens()
  persistGlobalSettings()
}, { deep: true })
watch(() => activeChapter.value, () => {
  refreshLiveContextTokens()
}, { deep: true })
watch(() => store.value.resourceGroups.style, (groups) => {
  globalStyleGroups.value = cloneSerializable(groups)
  persistGlobalSettings()
}, { deep: true })
watch(formatIndentSpaces, () => {
  persistGlobalSettings()
  markDirty()
})
onMounted(() => {
  window.addEventListener('resize', updateViewport)
  window.addEventListener('beforeunload', handleBeforeUnload)
  document.addEventListener('pointerdown', closeProjectMenuOnOutside)
  window.addEventListener('dragover', allowInternalResourceDragOver, true)
  window.addEventListener('dragend', endResourceDrag, true)
  removeDesktopFlushListener = window.desktopStorage?.onFlushRequest(async (requestId) => {
    desktopStorageFlushing.value = true
    desktopFlushSucceeded = false
    desktopFlushAbandoned = false
    const saved = await flushPersistence()
    desktopFlushSucceeded = saved
    desktopStorageFlushing.value = false
    window.desktopStorage?.completeFlush(requestId, { saved, error: remotePersistenceError.value || undefined })
  })
  removeDesktopFlushCancelledListener = window.desktopStorage?.onFlushCancelled(() => {
    desktopStorageFlushing.value = false
    desktopFlushSucceeded = false
  })
  removeDesktopFlushAbandonedListener = window.desktopStorage?.onFlushAbandoned(() => {
    desktopStorageFlushing.value = false
    desktopFlushSucceeded = false
    desktopFlushAbandoned = true
  })
  syncContextResourceItems(store.value)
  refreshLiveContextTokens()
  const savedAgentSettings = readLocalCache(agentSettingsStorageKey)
  if (savedAgentSettings) {
    try {
      const settings = JSON.parse(savedAgentSettings) as { historyLimit?: unknown }
      if (typeof settings.historyLimit === 'number' && [10, 20, 50, 100].includes(settings.historyLimit)) agentHistoryLimit.value = settings.historyLimit
    } catch { /* use defaults */ }
  }
  const savedAgentHistory = readLocalCache(agentHistoryStorageKey)
  if (savedAgentHistory) {
    try {
      const entries = JSON.parse(savedAgentHistory) as unknown
      if (Array.isArray(entries)) {
        agentHistory.value = entries.filter((entry): entry is AgentHistoryEntry => {
          if (!entry || typeof entry !== 'object') return false
          const item = entry as Partial<AgentHistoryEntry>
          return typeof item.id === 'string' && typeof item.summary === 'string' && typeof item.createdAt === 'number' && (item.status === 'applied' || item.status === 'undone') && Boolean(item.snapshot && Array.isArray(item.snapshot.chapters))
        }).slice(0, agentHistoryLimit.value)
      }
    } catch { /* use empty history */ }
  }
  const saved = readLocalCache(`${storageKey}-ui`)
  if (saved) {
    try {
      const ui = JSON.parse(saved)
      if (ui.activePage === 'api') {
        activePage.value = 'writer'
        settingsOpen.value = true
      } else {
        activePage.value = ui.activePage ?? 'writer'
      }
      selectedChapterId.value = ui.selectedChapterId ?? 'ch-8'
      selectedVolumeId.value = ui.selectedVolumeId ?? selectedVolumeId.value
      selectedIds.value = { ...selectedIds.value, ...(ui.selectedIds ?? {}) }
      if (typeof ui.agentProviderId === 'string') agentProviderId.value = ui.agentProviderId
      if (typeof ui.writerProviderId === 'string') writerProviderId.value = ui.writerProviderId
      if (typeof ui.worldEngineProviderId === 'string') worldEngineProviderId.value = ui.worldEngineProviderId
      currentWorkTitle.value = ui.currentWorkTitle ?? ''
      if (ui.agentPosition && typeof ui.agentPosition.x === 'number' && typeof ui.agentPosition.y === 'number') {
        agentPosition.value = clampAgentPosition(ui.agentPosition.x, ui.agentPosition.y)
      }
    } catch { /* use defaults */ }
  }
  void hydrateRemotePersistence()
  void refreshRecentQyFiles()
})

watch([activePage, selectedChapterId, selectedVolumeId, selectedIds, agentProviderId, writerProviderId, worldEngineProviderId, currentWorkTitle, agentPosition], () => {
  if (!isDesktopRuntime) {
    try { localStorage.setItem(`${storageKey}-ui`, JSON.stringify({ activePage: activePage.value, selectedChapterId: selectedChapterId.value, selectedVolumeId: selectedVolumeId.value, selectedIds: selectedIds.value, agentProviderId: agentProviderId.value, writerProviderId: writerProviderId.value, worldEngineProviderId: worldEngineProviderId.value, currentWorkTitle: currentWorkTitle.value, agentPosition: agentPosition.value })) } catch { /* use in-memory browser state */ }
  }
  markDirty()
}, { deep: true })

watch(agentMessages, () => {
  // The transcript belongs to the active project and is included in both the
  // project snapshot and the desktop/browser persistence payload.
  syncActiveAgentConversation()
  markDirty()
}, { deep: true })

watch([agentConversations, activeAgentConversationId], () => {
  markDirty()
}, { deep: true })

watch([agentHistory, agentHistoryLimit], () => {
  if (agentHistory.value.length > agentHistoryLimit.value) agentHistory.value.splice(agentHistoryLimit.value)
  if (!isDesktopRuntime) {
    try {
      localStorage.setItem(agentHistoryStorageKey, JSON.stringify(agentHistory.value))
      localStorage.setItem(agentSettingsStorageKey, JSON.stringify({ historyLimit: agentHistoryLimit.value }))
    } catch { /* use the main persistence store */ }
  }
  markDirty()
}, { deep: true })

function updateViewport() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  agentPosition.value = clampAgentPosition(agentPosition.value.x, agentPosition.value.y)
}

function clampAgentPosition(x: number, y: number) {
  return {
    x: Math.max(8, Math.min(x, Math.max(8, viewport.value.width - 58))),
    y: Math.max(8, Math.min(y, Math.max(8, viewport.value.height - 58))),
  }
}

function startAgentDrag(event: PointerEvent) {
  if (event.button !== 0) return
  agentPointerId = event.pointerId
  agentDragging.value = true
  suppressAgentClick.value = false
  agentDragOffset.value = { x: event.clientX - agentPosition.value.x, y: event.clientY - agentPosition.value.y }
  window.addEventListener('pointermove', moveAgentDrag)
  window.addEventListener('pointerup', endAgentDrag)
  window.addEventListener('pointercancel', endAgentDrag)
  event.preventDefault()
}

function moveAgentDrag(event: PointerEvent) {
  if (!agentDragging.value || event.pointerId !== agentPointerId) return
  const nextX = event.clientX - agentDragOffset.value.x
  const nextY = event.clientY - agentDragOffset.value.y
  if (Math.abs(nextX - agentPosition.value.x) > 3 || Math.abs(nextY - agentPosition.value.y) > 3) suppressAgentClick.value = true
  agentPosition.value = clampAgentPosition(nextX, nextY)
}

function endAgentDrag(event: PointerEvent) {
  if (agentPointerId !== null && event.pointerId !== agentPointerId) return
  agentDragging.value = false
  agentPointerId = null
  window.removeEventListener('pointermove', moveAgentDrag)
  window.removeEventListener('pointerup', endAgentDrag)
  window.removeEventListener('pointercancel', endAgentDrag)
  if (suppressAgentClick.value) window.setTimeout(() => { suppressAgentClick.value = false }, 0)
}

function toggleAgentSurface() {
  if (suppressAgentClick.value) return
  agentOpen.value = !agentOpen.value
}

function closeAgentSurface() {
  agentOpen.value = false
  if (activePage.value === 'agent') activePage.value = 'writer'
}

onBeforeUnmount(() => {
  agentAbortController?.abort()
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  window.removeEventListener('resize', updateViewport)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  document.removeEventListener('pointerdown', closeProjectMenuOnOutside)
  window.removeEventListener('dragover', allowInternalResourceDragOver, true)
  window.removeEventListener('dragend', endResourceDrag, true)
  removeDesktopFlushListener?.()
  removeDesktopFlushCancelledListener?.()
  removeDesktopFlushAbandonedListener?.()
  window.removeEventListener('pointermove', moveAgentDrag)
  window.removeEventListener('pointerup', endAgentDrag)
  window.removeEventListener('pointercancel', endAgentDrag)
})

function setPage(page: PageKey) {
  if (page === 'api') {
    settingsOpen.value = true
    return
  }
  if (page === 'agent') {
    agentOpen.value = false
    activePage.value = page
    focusMode.value = false
    return
  }
  activePage.value = page
  focusMode.value = false
}

function updateAgentHistoryLimit(value: number) {
  if (![10, 20, 50, 100].includes(value)) return
  agentHistoryLimit.value = value
  if (agentHistory.value.length > value) agentHistory.value.splice(value)
}

function toggleProjectMenu() {
  projectMenuOpen.value = !projectMenuOpen.value
}

function closeProjectMenuOnOutside(event: PointerEvent) {
  if (!projectMenuOpen.value) return
  const target = event.target
  if (target instanceof Element && target.closest('.project-selector')) return
  projectMenuOpen.value = false
}

function createBlankProjectStore() {
  const providers = store.value.providers
  const modelOptions = store.value.modelOptions
  const styleRules = cloneSerializable(store.value.style)
  const styleGroups = cloneSerializable(store.value.resourceGroups.style)
  const blank = cloneSerializable(seed)
  blank.volumes = [{ id: 'volume-1', title: '', collapsed: false }]
  blank.chapters = [{ id: 'ch-new-1', title: '01', status: '草稿', content: '', wordCount: 0, volumeId: blank.volumes[0]?.id ?? 'volume-1' }]
  blank.world = []
  blank.characters = []
  blank.items = []
  blank.skills = []
  blank.outline = []
  blank.worldEngine = createDefaultWorldEngineState()
  // A new work starts with an empty work-specific data space. The seed
  // contains an example custom module and meme records for the first launch,
  // but carrying those examples into every new work makes them look like
  // author data and can leak them into Agent context.
  blank.customModules = { schemas: [], entries: [] }
  blank.memes = { entries: [], updatedAt: Date.now() }
  blank.style = styleRules
  blank.resourceGroups.style = styleGroups
  blank.contextBlocks = cloneSerializable(seed.contextBlocks)
  blank.contextGroups = cloneSerializable(seed.contextGroups ?? [])
  blank.providers = providers
  blank.modelOptions = modelOptions
  syncContextResourceItems(blank)
  return blank
}

function nextProjectTitle(base = '') {
  if (!base.trim()) return ''
  const titles = new Set(projects.value.map((project) => project.title))
  if (!titles.has(base)) return base
  let index = 2
  while (titles.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}

function createBlankProjectRecord(title: string): ProjectRecord {
  const blank = createBlankProjectStore()
  const providers = blank.providers
  return {
    id: `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    updatedAt: Date.now(),
    snapshot: {
      store: projectDataStore(blank),
      selectedChapterId: 'ch-new-1',
      selectedVolumeId: blank.chapters[0]?.volumeId ?? 'volume-1',
      selectedIds: { world: '', characters: '', items: '', skills: '', outline: '', worldEngine: '', style: '', api: providers[0]?.id ?? '' },
      agentProviderId: '',
      writerProviderId: '',
      worldEngineProviderId: '',
      agentMode: 'writing',
      agentHistory: [],
      agentMessages: [],
      agentConversations: [],
      activeAgentConversationId: '',
    },
  }
}

function switchProject(id: string) {
  if (id === currentProjectId.value) {
    projectMenuOpen.value = false
    return
  }
  const target = projects.value.find((project) => project.id === id)
  if (!target) return
  syncCurrentProjectRecord()
  restoreProjectRecord(target)
  selectedGroupIds.value = { world: '', characters: '', items: '', skills: '', style: '' }
  ungroupedCollapsed.value = { world: false, characters: false, items: false, skills: false, style: false }
  projectMenuOpen.value = false
  projectDeleteOpen.value = false
  projectRenameOpen.value = false
  agentOpen.value = false
  agentTasks.value = [{ id: 'agent-ready', label: '等待任务', state: 'done', detail: 'Agent 已就绪' }]
  candidate.value = ''
  providerTest.value = ''
  apiError.value = ''
  persist()
}

function createNewProject() {
  syncCurrentProjectRecord()
  const project = createBlankProjectRecord(nextProjectTitle())
  projects.value.unshift(project)
  restoreProjectRecord(project)
  selectedGroupIds.value = { world: '', characters: '', items: '', skills: '', style: '' }
  ungroupedCollapsed.value = { world: false, characters: false, items: false, skills: false, style: false }
  projectMenuOpen.value = false
  agentOpen.value = false
  agentTasks.value = [{ id: 'agent-ready', label: '等待任务', state: 'done', detail: 'Agent 已就绪' }]
  persist()
}

function requestDeleteProject() {
  projectMenuOpen.value = false
  projectDeleteOpen.value = true
}

function requestRenameProject() {
  renameTitle.value = currentWorkTitle.value
  projectMenuOpen.value = false
  projectRenameOpen.value = true
}

function cancelRenameProject() {
  projectRenameOpen.value = false
}

function confirmRenameProject() {
  const nextTitle = renameTitle.value.trim()
  if (!nextTitle) return
  currentWorkTitle.value = nextTitle
  syncCurrentProjectRecord()
  projectRenameOpen.value = false
  persist()
}

function cancelDeleteProject() {
  projectDeleteOpen.value = false
}

function confirmDeleteProject() {
  const remaining = projects.value.filter((project) => project.id !== currentProjectId.value)
  if (!remaining.length) remaining.push(createBlankProjectRecord(''))
  projects.value = remaining
  projectDeleteOpen.value = false
  const target = remaining[0]
  restoreProjectRecord(target)
  projectMenuOpen.value = false
  agentOpen.value = false
  agentTasks.value = [{ id: 'agent-ready', label: '等待任务', state: 'done', detail: 'Agent 已就绪' }]
  persist({ allowProjectDeletion: true })
}

function memeStore() {
  if (!store.value.memes) store.value.memes = { entries: [], updatedAt: Date.now() }
  return store.value.memes
}
function createMemeEntry(value: { id: string; name: string; content: string; explanation?: string; source?: string; sourceUrl?: string; date?: string; tags?: string[]; createdBy?: 'agent' | 'manual'; enabled?: boolean }, save = true) {
  memeStore().entries.push(createMeme({ id: value.id, name: value.name, explanation: value.explanation || '', usage: value.content, source: value.source || value.sourceUrl || '', sourceUrl: value.sourceUrl, date: value.date || '', keywords: value.tags || [], enabled: value.enabled !== false, creationSource: value.createdBy === 'agent' ? 'agent' : 'manual' }))
  memeStore().updatedAt = Date.now()
  if (save) persist()
}
function updateMemeEntry(value: { id: string; name: string; content: string; explanation?: string; source?: string; sourceUrl?: string; date?: string; tags?: string[]; createdBy?: 'agent' | 'manual'; enabled?: boolean }) {
  const entry = memeStore().entries.find((item) => item.id === value.id); if (!entry || entry.locked) return
  Object.assign(entry, normalizeMeme({ ...entry, name: value.name, explanation: value.explanation || '', usage: value.content, source: value.source || value.sourceUrl || '', sourceUrl: value.sourceUrl, date: value.date || '', keywords: value.tags || [], enabled: value.enabled !== false }, Date.now()))
  memeStore().updatedAt = Date.now(); persist()
}
function deleteMemeEntry(id: string) { const entry = memeStore().entries.find((item) => item.id === id); if (!entry || entry.locked) return; memeStore().entries = memeStore().entries.filter((item) => item.id !== id); memeStore().updatedAt = Date.now(); persist() }
function toggleMemeEntry(id: string, enabled: boolean) { const entry = memeStore().entries.find((item) => item.id === id); if (!entry || entry.locked) return; entry.enabled = enabled; entry.updatedAt = Date.now(); memeStore().updatedAt = Date.now(); persist() }
function acceptMemeCandidate(value: { id?: string; name: string; content: string; explanation?: string; source?: string; sourceUrl?: string; date?: string; tags?: string[] }) { createMemeEntry({ ...value, id: value.id || ('meme-' + Date.now()), createdBy: 'agent' }); const entry = memeStore().entries[memeStore().entries.length - 1]; if (entry) entry.creationSource = 'agent'; memeCandidates.value = memeCandidates.value.filter((item) => item !== value) }
function dismissMemeCandidate(value: unknown) { memeCandidates.value = memeCandidates.value.filter((item) => item !== value) }
async function fetchWebMemeCandidates(query: string, engine: 'bing' | 'google' | 'duckduckgo' = 'bing', limit = 12, proxyProvider?: Resource, signal?: AbortSignal): Promise<MemePanelEntry[]> {
  if (!query.trim()) return []
  const proxyFields = proxyProvider?.fields ?? {}
  const response = await fetch(localApiUrl('/api/web/search'), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      engine,
      limit,
      useProxy: proxyFields['使用代理'] === 'true',
      proxyHost: proxyFields['代理地址'] ?? '',
      proxyPort: proxyFields['代理端口'] ?? '',
    }),
  })
  const body = await response.json() as { results?: WebMemeResult[]; error?: string }
  if (!response.ok) throw new Error(body.error || '网络热梗检索失败')
  return (body.results || []).filter((item) => item.title && item.url).map((item, index) => ({ id: 'candidate-' + Date.now() + '-' + index, name: item.title || '', content: item.snippet || item.title || '', explanation: '来自联网检索结果，等待整理含义与用法。', source: item.source || '网络检索', sourceUrl: item.url, date: item.publishedAt || '' }))
}

async function searchWebMemes(query: string, engine: 'bing' | 'google' | 'duckduckgo' = 'bing', limit = 12) {
  if (!query.trim()) return; memeSearchBusy.value = true
  try {
    memeCandidates.value = await fetchWebMemeCandidates(query, engine, limit, defaultProvider.value)
  } catch (error) { generationError.value = error instanceof Error ? error.message : '网络热梗检索失败' } finally { memeSearchBusy.value = false }
}

function fallbackMemeSearchQueries(input: string) {
  const quoted = [...input.matchAll(/[“「『"]([^”」』"]{2,80})[”」』"]/g)].map((match) => match[1].trim())
  const cleaned = input
    .replace(/[“”「」『』"]/g, ' ')
    .replace(/(?:请|帮我|麻烦|重点|搜|搜索|检索|查找|收集|一下|关于|相关|关联用法|总结|整理|提炼|成为|变成|一条|这个|出|网络热梗|网络梗|热梗|的梗)/gu, ' ')
    .replace(/[，,。；;：:、|/]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const pieces = [...quoted, ...cleaned.split(/\s*(?:和|与|以及|及|还有|结合)\s*/u)]
  const queries: string[] = []
  const add = (value: string, suffix: string) => {
    const term = value.replace(/\s+/gu, ' ').trim()
    if (term.length < 2) return
    const query = `${term} ${suffix}`.trim()
    if (!queries.some((item) => item.toLowerCase() === query.toLowerCase())) queries.push(query)
  }
  for (const piece of pieces) {
    if (/BGM|音乐|歌曲|音频/iu.test(piece)) add(piece, '梗 用法')
    else add(piece, '网络热梗')
  }
  if (cleaned) add(cleaned.replace(/(?:和|与|以及|及|还有|结合)/gu, ' '), '网络热梗')
  return queries.slice(0, 5)
}

async function planMemeSearchQueries(input: string) {
  const fallback = fallbackMemeSearchQueries(input)
  const provider = agentProvider.value
  // Never send the whole natural-language request to a search engine. If the
  // local extractor cannot find a usable entity and no planning model is
  // available, stop and ask for a more specific query instead.
  if (!provider || !isApiConfigured(provider)) return fallback
  const schema = { type: 'object', additionalProperties: false, required: ['queries'], properties: { queries: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 2, maxLength: 80 } } } }
  try {
    const text = await requestChat(localApiUrl, {
        ...readModelSettings(provider),
        providerId: provider.id,
        purpose: 'meme-search',
        baseUrl: provider.fields['接口地址'],
        apiKey: provider.fields['API Key'],
        protocol: provider.fields['协议'] ?? 'OpenAI Compatible',
        model: provider.fields['模型'],
        responseFormat: 'json_object',
        useProxy: provider.fields['使用代理'] === 'true',
        proxyHost: provider.fields['代理地址'] ?? '',
        proxyPort: provider.fields['代理端口'] ?? '',
        stream: provider.fields['流式输出'] !== 'false',
        signal: agentAbortController?.signal,
        messages: [
          { role: 'system', content: `你是网络检索词规划器。把用户对网络热梗的自然语言描述拆成最多 5 条适合搜索引擎的短查询。提取梗名、歌曲/BGM名、人物或事件名等核心实体；删除“帮我搜索、总结一下”等指令词；不要把整段用户原话原样作为查询。每条查询不超过 80 个字符，必要时加入“网络热梗”“梗”“BGM”“用法”等限定词。只返回 JSON：${JSON.stringify(schema)}` },
          { role: 'user', content: input },
        ],
      })
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')) as { queries?: unknown }
    const planned = Array.isArray(parsed.queries) ? parsed.queries.filter((item): item is string => typeof item === 'string' && item.trim().length >= 2 && item.trim().length <= 80).map((item) => item.trim()) : []
    const merged = [...planned, ...fallback]
    return [...new Set(merged.map((item) => item.replace(/\s+/gu, ' ').trim()))].slice(0, 5)
  } catch {
    return fallback
  }
}

async function summarizeWebMemeCandidates(query: string, candidates: MemePanelEntry[]) {
  const provider = agentProvider.value
  // Agent collection must produce an AI-derived explanation. Writing raw
  // search snippets into the meme table makes ordinary news/results look like
  // verified memes and is worse than asking the user to configure an Agent API.
  if (!provider || !isApiConfigured(provider)) return []
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['memes'],
    properties: {
      memes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceIndex', 'name', 'content', 'explanation', 'tags'],
          properties: {
            sourceIndex: { type: 'integer', minimum: 0 },
            name: { type: 'string' },
            content: { type: 'string' },
            explanation: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }
  const text = await requestChat(localApiUrl, {
      ...readModelSettings(provider),
      providerId: provider.id,
      purpose: 'meme-summary',
      baseUrl: provider.fields['接口地址'],
      apiKey: provider.fields['API Key'],
      protocol: provider.fields['协议'] ?? 'OpenAI Compatible',
      model: provider.fields['模型'],
      responseFormat: 'json_object',
      useProxy: provider.fields['使用代理'] === 'true',
      proxyHost: provider.fields['代理地址'] ?? '',
      proxyPort: provider.fields['代理端口'] ?? '',
      stream: provider.fields['流式输出'] !== 'false',
      signal: agentAbortController?.signal,
      messages: [
        { role: 'system', content: `你是网络热梗整理助手。根据搜索结果提炼真正的网络表达，不要照抄新闻标题。为每条结果总结：热梗名称、具体表达或用法、含义和适用场景、简短标签。只返回符合此 JSON Schema 的 JSON：${JSON.stringify(schema)}。sourceIndex 必须对应输入结果的序号；无法确认是热梗的结果可以省略。` },
        { role: 'user', content: JSON.stringify({ query, results: candidates.map((candidate, index) => ({ sourceIndex: index, title: candidate.name, snippet: candidate.content, source: candidate.source, url: candidate.sourceUrl, date: candidate.date })) }) },
      ],
  })
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')) as { memes?: Array<{ sourceIndex?: number; name?: string; content?: string; explanation?: string; tags?: string[] }> }
    const summarized = (parsed.memes ?? []).filter((item) => Number.isInteger(item.sourceIndex) && candidates[item.sourceIndex as number] && item.name?.trim() && item.content?.trim()).map((item, index) => {
      const source = candidates[item.sourceIndex as number]
      return {
        ...source,
        id: `meme-agent-${Date.now()}-${index}`,
        name: item.name!.trim(),
        content: item.content!.trim(),
        explanation: item.explanation?.trim() || '由 Agent 根据联网结果整理。',
        tags: item.tags?.filter((tag) => tag.trim()).map((tag) => tag.trim()) ?? [],
        createdBy: 'agent' as const,
        enabled: true,
      }
    })
    return summarized
  } catch {
    return []
  }
}

async function collectWebMemesForAgent(query: string, engine: 'bing' | 'google' | 'duckduckgo', limit: number, expectedEpoch = agentRunEpoch) {
  const ensureCurrentProject = () => {
    if (expectedEpoch !== agentRunEpoch) throw new Error('当前作品已切换，旧 Agent 任务已取消')
  }
  ensureCurrentProject()
  memeSearchBusy.value = true
  const signal = agentAbortController?.signal
  const queryActivityId = addAgentActivity('拆分搜索关键词', '提取梗名、人物和事件，规划多批检索。', 'running', 'model')
  try {
    const queries = await planMemeSearchQueries(query)
    ensureCurrentProject()
    if (!queries.length) {
      throw new Error('无法从请求中提取有效搜索关键词，请补充具体的梗名、歌曲、人物或事件名')
    }
    updateAgentActivity(queryActivityId, { state: 'done', detail: queries.join('；') })
    updateAgentTask('execute', { detail: `已拆分 ${queries.length} 条搜索词，准备分批检索` })
    const summarizedBatches: MemePanelEntry[] = []
    let successfulBatches = 0
    for (const [index, searchQuery] of queries.entries()) {
      ensureCurrentProject()
      updateAgentTask('execute', { detail: `正在搜索第 ${index + 1}/${queries.length} 批：${searchQuery}` })
      const batchActivityId = addAgentActivity(`搜索第 ${index + 1}/${queries.length} 批`, `${engine} · ${searchQuery}`, 'running', 'tool')
      try {
        const batch = await fetchWebMemeCandidates(searchQuery, engine, Math.max(4, Math.ceil(limit / Math.max(1, queries.length)) + 2), agentProvider.value, signal)
        ensureCurrentProject()
        updateAgentActivity(batchActivityId, { state: 'done', detail: `${searchQuery} · 找到 ${batch.length} 条结果。` })
        if (!batch.length) continue
        successfulBatches += 1
        updateAgentTask('execute', { detail: `第 ${index + 1}/${queries.length} 批找到 ${batch.length} 条结果，正在整理和提炼` })
        const summaryActivityId = addAgentActivity('提炼联网搜索结果', `正在整理第 ${index + 1} 批的 ${batch.length} 条结果。`, 'running', 'model')
        try {
          const summaries = await summarizeWebMemeCandidates(searchQuery, batch)
          ensureCurrentProject()
          summarizedBatches.push(...summaries)
          updateAgentActivity(summaryActivityId, { state: 'done', detail: `提炼出 ${summaries.length} 条可用热梗。` })
        } catch (error) {
          ensureCurrentProject()
          updateAgentActivity(summaryActivityId, { state: 'error', detail: error instanceof Error ? error.message : '本批整理失败', kind: 'error' })
          throw error
        }
        ensureCurrentProject()
      } catch (error) {
        ensureCurrentProject()
        signal?.throwIfAborted()
        updateAgentActivity(batchActivityId, { state: 'error', detail: error instanceof Error ? error.message : '本批搜索失败', kind: 'error' })
        // One search batch may fail while other keyword batches still produce useful results.
      }
    }
    const summarized = summarizedBatches
      .filter((meme, index, all) => all.findIndex((item) => item.name.trim().toLowerCase() === meme.name.trim().toLowerCase()) === index)
      .slice(0, limit)
    if (!successfulBatches || !summarized.length) throw new Error('搜索没有返回可整理的结果')
    ensureCurrentProject()
    updateAgentTask('execute', { detail: `已完成 ${successfulBatches} 批搜索，提炼出 ${summarized.length} 条热梗，准备统一写入` })
    return { entries: summarized, queries }
  } finally {
    if (expectedEpoch === agentRunEpoch) memeSearchBusy.value = false
  }
}
function selectResource(id: string) {
  selectedIds.value[activePage.value] = id
}

function toggleOutlineCollapse(id: string) {
  const node = store.value.outline.find((item) => item.id === id)
  if (!node) return
  node.outlineCollapsed = node.outlineCollapsed !== true
}

function updateOutlineStructure(payload: {
  outlineType?: Resource['outlineType']
  outlineParentId?: string
  outlineStartChapterId?: string
  outlineEndChapterId?: string
  outlineCollapsed?: boolean
}) {
  const node = selectedResource.value
  if (activePage.value !== 'outline' || !node) return
  const byId = new Map(store.value.outline.map((item) => [item.id, item]))
  const validTypes = new Set<NonNullable<Resource['outlineType']>>(['book', 'volume', 'chapterRange', 'scene'])
  const nextType = payload.outlineType ?? node.outlineType ?? 'chapterRange'
  if (!validTypes.has(nextType)) return
  const parentAccepts = (childType: NonNullable<Resource['outlineType']>, parentType: NonNullable<Resource['outlineType']>) => {
    if (childType === 'book') return false
    if (childType === 'volume') return parentType === 'book'
    if (childType === 'chapterRange') return parentType === 'volume' || parentType === 'book'
    return parentType === 'chapterRange' || parentType === 'volume'
  }
  const requestedParentId = payload.outlineParentId
  const parentWasExplicitlyChanged = requestedParentId !== undefined
  if (parentWasExplicitlyChanged && typeof requestedParentId !== 'string') return
  let parentId = parentWasExplicitlyChanged
    ? (requestedParentId.trim() || undefined)
    : node.outlineParentId
  const parent = parentId ? byId.get(parentId) : undefined
  if (nextType === 'book') {
    // A book is always the root. Clear a stale existing parent when the user
    // changes a node's type to book.
    parentId = undefined
  } else if (parentId && (!parent || parent.id === node.id || !parentAccepts(nextType, parent.outlineType ?? 'chapterRange'))) {
    // Type changes are emitted separately from parent changes by the form. If
    // the old parent no longer fits, safely detach it; reject an explicitly
    // selected invalid parent so bad events never enter the store.
    if (parentWasExplicitlyChanged) return
    parentId = undefined
  }
  if (parentId) {
    const seen = new Set<string>()
    let cursor: string | undefined = parentId
    while (cursor && !seen.has(cursor)) {
      if (cursor === node.id) return
      seen.add(cursor)
      cursor = byId.get(cursor)?.outlineParentId
    }
  }
  const chapterIds = new Set(store.value.chapters.map((chapter) => chapter.id))
  const normalizeChapterId = (value: unknown) => {
    if (typeof value !== 'string') return value === undefined ? undefined : null
    const chapterId = value.trim()
    if (!chapterId) return undefined
    return chapterIds.has(chapterId) ? chapterId : null
  }
  const startChapterId = payload.outlineStartChapterId === undefined
    ? node.outlineStartChapterId
    : normalizeChapterId(payload.outlineStartChapterId)
  const endChapterId = payload.outlineEndChapterId === undefined
    ? node.outlineEndChapterId
    : normalizeChapterId(payload.outlineEndChapterId)
  if (startChapterId === null || endChapterId === null) return
  if (payload.outlineCollapsed !== undefined && typeof payload.outlineCollapsed !== 'boolean') return
  if (parentWasExplicitlyChanged || parentId !== node.outlineParentId || nextType === 'book') node.outlineParentId = parentId
  if (payload.outlineType !== undefined) node.outlineType = nextType
  if (payload.outlineStartChapterId !== undefined) node.outlineStartChapterId = startChapterId as string | undefined
  if (payload.outlineEndChapterId !== undefined) node.outlineEndChapterId = endChapterId as string | undefined
  if (payload.outlineCollapsed !== undefined) node.outlineCollapsed = payload.outlineCollapsed
}

function openCustomModuleReference(collection: 'characters' | 'items' | 'skills', id: string) {
  activePage.value = collection
  selectedIds.value[collection] = id
}

function customModuleStore(): CustomModuleStore {
  if (!store.value.customModules) store.value.customModules = { schemas: [], entries: [] }
  return store.value.customModules
}

function selectCustomModule(id: string) {
  selectedIds.value.custom = id
}

function createCustomModule(payload: { name: string; description: string; fields: CustomModulePanelField[] }) {
  const now = Date.now()
  const id = `custom-module-${now}-${Math.random().toString(36).slice(2, 7)}`
  const schema = normalizeCustomModuleSchema({
    id,
    type: payload.name,
    title: payload.name,
    description: payload.description,
    fields: payload.fields,
  }, now)
  customModuleStore().schemas.push(schema)
  syncContextResourceItems(store.value)
  selectedIds.value.custom = id
  activePage.value = 'custom'
  persist()
}

function updateCustomModule(panelModule: CustomModulePanelDefinition) {
  const customStore = customModuleStore()
  const existing = customStore.schemas.find((schema) => schema.id === panelModule.id)
  if (!existing) return
  const previousFields = new Map(existing.fields.map((field) => [field.id, field]))
  const nextFieldIds = new Set(panelModule.fields.map((field) => field.id))
  const nextFieldKeys = new Set(panelModule.fields.map((field) => field.key.trim()).filter(Boolean))
  const removedFields = existing.fields.filter((field) => !nextFieldIds.has(field.id) && !nextFieldKeys.has(field.key.trim()))
  const entriesWithRemovedData = customStore.entries.filter((entry) => entry.schemaId === existing.id && removedFields.some((field) => {
    const value = entry.data[field.key]
    if (value === undefined || value === null) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    return true
  }))
  if (removedFields.length && entriesWithRemovedData.length && !window.confirm(
    `即将删除字段“${removedFields.map((field) => field.label || field.key).join('、')}”。
已有 ${entriesWithRemovedData.length} 条数据填写了这些字段，继续后这些字段的数据会被清除。
确定继续吗？`,
  )) return
  const schema = normalizeCustomModuleSchema({
    ...existing,
    title: panelModule.name,
    description: panelModule.description ?? '',
    fields: panelModule.fields.map((field) => ({
      ...field,
      type: field.type as CustomModuleFieldType,
    })),
    lockedAll: panelModule.lockedAll === true,
    updatedAt: Date.now(),
    version: existing.version + 1,
  }, Date.now())
  schema.createdAt = existing.createdAt
  schema.version = Math.max(existing.version + 1, schema.version)
  const entryIds = new Set(customStore.entries.filter((entry) => entry.schemaId === schema.id).map((entry) => entry.id))
  for (const entry of customStore.entries) {
    if (!entryIds.has(entry.id)) continue
    for (const field of schema.fields) {
      const oldField = previousFields.get(field.id)
      if (oldField && oldField.key !== field.key && entry.data[field.key] === undefined && entry.data[oldField.key] !== undefined) {
        entry.data[field.key] = entry.data[oldField.key]
        delete entry.data[oldField.key]
      }
    }
    entry.data = normalizeCustomModuleData(entry.data, schema)
    entry.title = schema.titleField ? String(entry.data[schema.titleField] ?? entry.title ?? '') : entry.title
    entry.updatedAt = Date.now()
  }
  const index = customStore.schemas.findIndex((item) => item.id === schema.id)
  customStore.schemas[index] = schema
  syncContextResourceItems(store.value)
  persist()
}

function renameCustomModule(moduleId: string, name: string) {
  const schema = customModuleStore().schemas.find((item) => item.id === moduleId)
  if (!schema || !name.trim()) return
  const previousTitle = schema.title
  schema.title = name.trim()
  if (schema.type === previousTitle) schema.type = schema.title
  schema.updatedAt = Date.now()
  syncContextResourceItems(store.value)
  persist()
}

function deleteCustomModule(moduleId: string) {
  const customStore = customModuleStore()
  const schema = customStore.schemas.find((item) => item.id === moduleId)
  if (!schema || !window.confirm(`确定删除“${schema.title}”及其全部条目吗？`)) return
  customStore.schemas = customStore.schemas.filter((item) => item.id !== moduleId)
  customStore.entries = customStore.entries.filter((entry) => entry.schemaId !== moduleId)
  syncContextResourceItems(store.value)
  selectedIds.value.custom = customStore.schemas[0]?.id ?? ''
  persist()
}

function createCustomEntry(moduleId: string, panelEntry: { id: string; title: string; data: Record<string, unknown>; lockedAll?: boolean; lockedFields?: string[] }) {
  const schema = customModuleStore().schemas.find((item) => item.id === moduleId)
  if (!schema) return
  const entry = normalizeCustomModuleEntry({ ...panelEntry, schemaId: moduleId }, schema, Date.now())
  customModuleStore().entries.push(entry)
  syncContextResourceItems(store.value)
  persist()
}

function updateCustomEntry(moduleId: string, panelEntry: { id: string; title: string; data: Record<string, unknown>; lockedAll?: boolean; lockedFields?: string[] }) {
  const customStore = customModuleStore()
  const schema = customStore.schemas.find((item) => item.id === moduleId)
  const existing = customStore.entries.find((entry) => entry.id === panelEntry.id && entry.schemaId === moduleId)
  if (!schema || !existing) return
  const next = normalizeCustomModuleEntry({ ...panelEntry, schemaId: moduleId }, schema, Date.now())
  Object.assign(existing, next)
  syncContextResourceItems(store.value)
  persist()
}

function deleteCustomEntry(moduleId: string, entryId: string) {
  const customStore = customModuleStore()
  const schema = customStore.schemas.find((item) => item.id === moduleId)
  if (!schema || !window.confirm(`确定删除“${schema.title}”中的这条数据吗？`)) return
  customStore.entries = customStore.entries.filter((entry) => !(entry.schemaId === moduleId && entry.id === entryId))
  syncContextResourceItems(store.value)
  persist()
}

function updateResourceTitle(value: string) {
  if (selectedResource.value) {
    selectedResource.value.title = value
    syncContextResourceItems(store.value)
  }
}

function updateResourceSummary(value: string) {
  if (selectedResource.value) selectedResource.value.summary = value
}

function updateCreationPromptHint(key: string, value: string) {
  const pageType: Record<string, StandardResourceType> = { world: 'world', characters: 'character', items: 'item', skills: 'skill' }
  const type = pageType[activePage.value]
  if (!type) return
  const next = normalizeStandardCreationPromptHints(standardCreationPromptHints.value)
  if (value.trim()) next[type][key] = value.trim()
  else delete next[type][key]
  standardCreationPromptHints.value = next
  persistGlobalSettings()
}

function toggleResourceLock(field: string) {
  const resource = selectedResource.value
  if (!resource || resource.lockedAll === true) return
  const canonicalField = canonicalTriggerField(field)
  const locked = new Set((resource.lockedFields ?? []).map(canonicalTriggerField))
  if (locked.has(canonicalField)) locked.delete(canonicalField)
  else locked.add(canonicalField)
  resource.lockedFields = [...locked]
}

function toggleSelectedResourceReviewStatus() {
  if (!selectedResource.value) return
  selectedResource.value.reviewStatus = selectedResource.value.reviewStatus === 'complete' ? 'pending' : 'complete'
}

function toggleSelectedResourceReviewStatusLock() {
  if (!selectedResource.value || selectedResource.value.lockedAll === true) return
  selectedResource.value.reviewStatusLocked = selectedResource.value.reviewStatusLocked !== true
}

function toggleSelectedResourceAllLock() {
  if (!selectedResource.value) return
  setResourceLockAll(selectedResource.value, selectedResource.value.lockedAll !== true)
}

function openResourceGroupDialog() {
  if (!activeGroupPage.value) return
  resourceGroupEditingId.value = null
  resourceGroupTitle.value = ''
  resourceGroupDialogOpen.value = true
}

function cancelResourceGroupDialog() {
  resourceGroupDialogOpen.value = false
  resourceGroupEditingId.value = null
  resourceGroupTitle.value = ''
}

function createResourceGroup() {
  const page = activeGroupPage.value
  const title = resourceGroupTitle.value.trim()
  if (!page || !title) return
  if (resourceGroupEditingId.value) {
    const group = store.value.resourceGroups[page].find((item) => item.id === resourceGroupEditingId.value)
    if (!group) {
      cancelResourceGroupDialog()
      return
    }
    group.title = title
    cancelResourceGroupDialog()
    return
  }
  const group: ResourceGroup = { id: `${page}-group-${Date.now()}`, title, collapsed: false }
  store.value.resourceGroups[page].push(group)
  selectedGroupIds.value[page] = group.id
  cancelResourceGroupDialog()
}

function renameResourceGroup(groupId: string) {
  const page = activeGroupPage.value
  if (!page || groupId === '__ungrouped__') return
  const group = store.value.resourceGroups[page].find((item) => item.id === groupId)
  if (!group) return
  resourceGroupEditingId.value = group.id
  resourceGroupTitle.value = group.title
  resourceGroupDialogOpen.value = true
}

function toggleResourceGroup(groupId: string) {
  const page = activeGroupPage.value
  if (!page) return
  if (groupId === '__ungrouped__') {
    ungroupedCollapsed.value[page] = !ungroupedCollapsed.value[page]
    return
  }
  const group = store.value.resourceGroups[page].find((item) => item.id === groupId)
  if (!group) return
  group.collapsed = !group.collapsed
  selectedGroupIds.value[page] = group.id
}

function moveResourceGroupToTop(groupId: string) {
  const page = activeGroupPage.value
  if (!page || groupId === '__ungrouped__') return
  const groups = store.value.resourceGroups[page]
  const index = groups.findIndex((group) => group.id === groupId)
  if (index <= 0) return
  const [group] = groups.splice(index, 1)
  groups.unshift(group)
  selectedGroupIds.value[page] = group.id
}

function moveResourceGroupToBottom(groupId: string) {
  const page = activeGroupPage.value
  if (!page || groupId === '__ungrouped__') return
  const groups = store.value.resourceGroups[page]
  const index = groups.findIndex((group) => group.id === groupId)
  if (index < 0 || index === groups.length - 1) return
  const [group] = groups.splice(index, 1)
  groups.push(group)
  selectedGroupIds.value[page] = group.id
}

function deleteResourceGroup(groupId: string) {
  const page = activeGroupPage.value
  if (!page || groupId === '__ungrouped__') return
  const groups = store.value.resourceGroups[page]
  const index = groups.findIndex((group) => group.id === groupId)
  if (index < 0) return
  // Deleting a fold bar only removes the container. Its cards remain in the
  // collection and are returned to the ungrouped section.
  activeCollection.value.forEach((resource) => {
    if (resource.groupId === groupId) delete resource.groupId
  })
  groups.splice(index, 1)
  if (selectedGroupIds.value[page] === groupId) {
    selectedGroupIds.value[page] = groups[0]?.id ?? ''
  }
}

function setAllResourceGroupsCollapsed(collapsed: boolean) {
  const page = activeGroupPage.value
  if (!page) return
  store.value.resourceGroups[page].forEach((group) => { group.collapsed = collapsed })
}

function startResourceDrag(event: DragEvent, resourceId: string) {
  draggedResourceGroupId.value = null
  draggedResourceId.value = resourceId
  dropTargetGroupId.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', resourceId)
  }
}

function startResourceGroupDrag(event: DragEvent, groupId: string) {
  if (groupId === '__ungrouped__') return
  draggedResourceId.value = null
  draggedResourceGroupId.value = groupId
  dropTargetGroupId.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-novel-resource-group', groupId)
    event.dataTransfer.setData('text/plain', groupId)
  }
}

function dragOverResourceGroup(groupId: string) {
  if (draggedResourceGroupId.value) {
    if (groupId !== '__ungrouped__' && groupId !== draggedResourceGroupId.value) dropTargetGroupId.value = groupId
    return
  }
  if (draggedResourceId.value) dropTargetGroupId.value = groupId
}

function dropResourceIntoGroup(groupId: string) {
  const draggedGroupId = draggedResourceGroupId.value
  if (draggedGroupId) {
    const page = activeGroupPage.value
    if (page && groupId !== '__ungrouped__' && groupId !== draggedGroupId) {
      const groups = store.value.resourceGroups[page]
      const fromIndex = groups.findIndex((group) => group.id === draggedGroupId)
      const toIndex = groups.findIndex((group) => group.id === groupId)
      if (fromIndex >= 0 && toIndex >= 0) {
        const [group] = groups.splice(fromIndex, 1)
        groups.splice(toIndex, 0, group)
      }
    }
    draggedResourceGroupId.value = null
    dropTargetGroupId.value = null
    return
  }
  const resourceId = draggedResourceId.value
  const resource = activeCollection.value.find((item) => item.id === resourceId)
  if (resource) {
    if (groupId === '__ungrouped__') delete resource.groupId
    else resource.groupId = groupId
    if (groupId !== '__ungrouped__' && activeGroupPage.value) selectedGroupIds.value[activeGroupPage.value] = groupId
  }
  draggedResourceId.value = null
  dropTargetGroupId.value = null
}

function dropResourceOnResource(targetId: string) {
  const sourceId = draggedResourceId.value
  if (!sourceId || sourceId === targetId || !activeGroupPage.value) {
    endResourceDrag()
    return
  }
  const collection = activeCollection.value
  const sourceIndex = collection.findIndex((item) => item.id === sourceId)
  const targetIndex = collection.findIndex((item) => item.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0) {
    endResourceDrag()
    return
  }
  const source = collection[sourceIndex]
  const target = collection[targetIndex]
  if (target.groupId) source.groupId = target.groupId
  else delete source.groupId
  const [moved] = collection.splice(sourceIndex, 1)
  const nextIndex = collection.findIndex((item) => item.id === targetId)
  collection.splice(Math.max(0, nextIndex), 0, moved)
  endResourceDrag()
}

function endResourceDrag() {
  draggedResourceId.value = null
  draggedResourceGroupId.value = null
  dropTargetGroupId.value = null
}

function endResourceGroupDrag() {
  draggedResourceGroupId.value = null
  dropTargetGroupId.value = null
}

function allowInternalResourceDragOver(event: DragEvent) {
  if (!draggedResourceId.value && !draggedResourceGroupId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function rememberModalPointerDown(event: PointerEvent) {
  modalPointerDownTarget.value = event.target
}

function closeModalOnBackdrop(kind: 'holdingPicker' | 'cardDetail' | 'projectDelete' | 'chapterDelete' | 'projectRename' | 'resourceGroup' | 'agent', event: MouseEvent) {
  const canClose = event.target === event.currentTarget && modalPointerDownTarget.value === event.currentTarget
  modalPointerDownTarget.value = null
  if (!canClose) return
  if (kind === 'holdingPicker') holdingPicker.value = null
  if (kind === 'cardDetail') cardDetail.value = null
  if (kind === 'projectDelete') cancelDeleteProject()
  if (kind === 'chapterDelete') cancelDeleteChapter()
  if (kind === 'projectRename') cancelRenameProject()
  if (kind === 'resourceGroup') cancelResourceGroupDialog()
  if (kind === 'agent') agentOpen.value = false
}

function holdingCollection(type: HoldingType) {
  return type === 'skills' ? store.value.skills : store.value.items
}

function characterHoldingIds(character: Resource, type: HoldingType) {
  const key = type === 'skills' ? 'holdingSkills' : 'holdingItems'
  const stored = character[key]
  if (stored) return stored
  const field = type === 'skills' ? '持有技能' : '持有道具'
  const values = (character.fields[field] ?? '').split(/[、,，]/).map((value) => value.trim()).filter(Boolean)
  return values.map((value) => holdingCollection(type).find((item) => item.id === value || item.title === value)?.id).filter((id): id is string => Boolean(id))
}

function holdingTitle(type: HoldingType, id: string) {
  return holdingCollection(type).find((item) => item.id === id)?.title ?? id
}

function isHolding(character: Resource, type: HoldingType, id: string) {
  return characterHoldingIds(character, type).includes(id)
}

function openHoldingPicker(type: HoldingType) {
  if (!selectedResource.value || activePage.value !== 'characters') return
  holdingPicker.value = { type, characterId: selectedResource.value.id }
}

function toggleHolding(type: HoldingType, id: string) {
  const character = store.value.characters.find((item) => item.id === holdingPicker.value?.characterId)
  if (!character) return
  const key = type === 'skills' ? 'holdingSkills' : 'holdingItems'
  const ids = characterHoldingIds(character, type)
  character[key] = ids.includes(id) ? ids.filter((itemId) => itemId !== id) : [...ids, id]
}

function openCardDetail(type: HoldingType, id: string) {
  cardDetail.value = { type, id }
}

function agentPageForType(type: AgentResourceType): AgentResourcePage {
  const pages: Record<AgentResourceType, AgentResourcePage> = {
    world: 'world', character: 'characters', item: 'items', skill: 'skills', outline: 'outline', world_event: 'worldEngine', style: 'style',
  }
  return pages[type]
}

function resourceDefaults(page: AgentResourcePage, title: string, summary?: string, fields: Record<string, string> = {}): Resource {
  const id = `${page}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const defaults: Record<AgentResourcePage, Omit<Resource, 'id' | 'title' | 'summary'>> = {
    world: { tag: '草稿', fields: { '触发策略': '关键词', '触发键': '', '内容': '', '适用范围': '', '状态': '草稿' } },
    characters: { tag: '待完善', fields: { '触发策略': '关键词', '触发键': '', '角色身份': '', '性别': '', '种族': '', '性格': '', '外貌': '', '人物动机': '', '当前状态': '', '已知信息': '', '尚未知晓': '', '说话习惯': '' }, holdingItems: [], holdingSkills: [] },
    items: { tag: '待完善', fields: { '触发策略': '关键词', '触发键': '', '用途': '', '当前持有人': '', '当前位置': '', '使用限制': '', '关联线索': '' } },
    skills: { tag: '主动', fields: { '触发策略': '关键词', '触发键': '', '技能性质': '主动', '技能效果': '', '关联线索': '' } },
    outline: { tag: '草稿', fields: { '章节目标': '', '场景': '', '冲突': '', '结尾状态': '' } },
    worldEngine: { tag: '待推进', fields: {} },
    style: { tag: '待审阅', fields: { '规则': '', '反例': '', '正例': '' } },
  }
  const base = defaults[page]
  const isContextCard = ['world', 'characters', 'items', 'skills'].includes(page)
  const inputFields = isContextCard
    ? Object.fromEntries(Object.entries(fields).map(([key, value]) => [canonicalTriggerField(key), value]))
    : page === 'style'
      ? Object.fromEntries(Object.entries(fields).filter(([key]) => !legacyStyleMetadataFields.has(key)))
      : fields
  const normalizedFields = { ...base.fields, ...inputFields }
  if (page === 'skills') {
    normalizedFields['技能性质'] = normalizedFields['技能性质'] === '被动' ? '被动' : '主动'
  }
  if (normalizedFields['说明'] !== undefined && normalizedFields['内容'] === undefined) normalizedFields['内容'] = normalizedFields['说明']
  delete normalizedFields['说明']
  const resource: Resource = { id, title, summary: summary?.trim() ?? '', tag: base.tag, fields: normalizedFields, creationSource: 'manual', reviewStatus: 'pending', reviewStatusLocked: false, lockedAll: false, lockedFields: [], allowRecursive: false, allowFurtherRecursive: false, injectionOrder: 100, ...(page === 'outline' ? { outlineType: 'chapterRange' as const } : {}), ...(page === 'style' ? { enabled: true } : {}), ...(base.holdingItems ? { holdingItems: [] } : {}), ...(base.holdingSkills ? { holdingSkills: [] } : {}) }
  return isContextCard ? normalizeResourceTriggers(resource) : resource
}

function insertResource(page: AgentResourcePage, title: string, summary?: string, fields?: Record<string, string>) {
  const item = resourceDefaults(page, title.trim() || '未命名条目', summary, fields)
  const collection = store.value[page] as Resource[]
  if (activeGroupPage.value === page && activeGroups.value.some((group) => group.id === selectedGroupId.value)) item.groupId = selectedGroupId.value
  collection.unshift(item)
  syncContextResourceItems(store.value)
  selectedIds.value[page] = item.id
  return item
}

function addResource() {
  if (!currentConfig.value) return
  if (activePage.value === 'api') {
    addProvider()
    return
  }
  if (activePage.value === 'outline') {
    const selected = selectedResource.value
    const selectedType = selected?.outlineType ?? (selected ? 'chapterRange' : undefined)
    const outlineType: NonNullable<Resource['outlineType']> = !selected
      ? 'book'
      : selectedType === 'book'
        ? 'volume'
        : selectedType === 'volume'
          ? 'chapterRange'
          : 'scene'
    const title = outlineType === 'book'
      ? '全书总纲'
      : outlineType === 'volume'
        ? `第 ${(store.value.outline.filter((item) => item.outlineType === 'volume').length || 0) + 1} 卷大纲`
        : outlineType === 'chapterRange'
          ? '章节范围大纲'
          : '场景大纲'
    const item = insertResource('outline', title, outlineType === 'book' ? '全书故事主线与最终落点。' : outlineType === 'volume' ? '本卷的核心冲突、节奏和结局。' : outlineType === 'chapterRange' ? '一段章节范围内的剧情推进。' : '具体场景的目标、冲突和结果。')
    item.outlineType = outlineType
    item.outlineParentId = outlineType === 'book'
      ? undefined
      : selectedType === 'scene'
        ? selected?.outlineParentId
        : selected?.id
    if (outlineType === 'chapterRange') {
      const parentVolumeId = selected?.outlineType === 'volume' ? selected.outlineParentId : undefined
      const chapters = parentVolumeId
        ? store.value.chapters.filter((chapter) => chapter.volumeId === parentVolumeId)
        : store.value.chapters
      item.outlineStartChapterId = chapters[0]?.id
      item.outlineEndChapterId = chapters[Math.min(2, Math.max(0, chapters.length - 1))]?.id
    }
    return
  }
  insertResource(activePage.value as AgentResourcePage, activePage.value === 'characters' ? '未命名角色' : activePage.value === 'items' ? '未命名道具' : activePage.value === 'skills' ? '未命名技能' : '未命名条目')
}

function resourceCreateLabel(page: PageKey) {
  const labels: Partial<Record<PageKey, string>> = {
    world: '新建世界书条目',
    characters: '新建角色',
    items: '新建道具',
    skills: '新建技能',
    outline: '新建大纲节点',
    worldEngine: '添加世界引擎事件',
    style: '新建文风规则',
  }
  return labels[page] ?? '新建条目'
}

function addProvider() {
  const id = `providers-${Date.now()}`
  const item: Resource = { id, title: '新的 API 预设', tag: 'OpenAI Compatible · 未测试', summary: '用于正文写作或其他任务的模型连接配置。', enabled: store.value.providers.length === 0, fields: { '协议': 'OpenAI Compatible', '接口地址': 'https://api.openai.com/v1', '模型': '', 'API Key': '', '上下文长度': String(defaultModelSettings.contextTokens), '使用代理': 'false', '代理地址': '127.0.0.1', '代理端口': '7890', '流式输出': 'true', '状态': '未测试' } }
  store.value.providers.unshift(item)
  selectedIds.value.api = id
  store.value.modelOptions[id] = []
  providerTest.value = ''
  apiError.value = ''
}

function removeResource() {
  if (!currentConfig.value || !selectedResource.value) return
  const collection = store.value[currentConfig.value.collection] as Resource[]
  const removedResource = { id: selectedResource.value.id, title: selectedResource.value.title }
  const label = currentConfig.value.title
  const hasReferences = ['characters', 'items', 'skills'].includes(currentConfig.value.collection)
  const warning = hasReferences
    ? `
相关背包、索引和世界引擎引用会同步清理。`
    : ''
  if (!window.confirm(`确定删除${label}“${removedResource.title}”吗？${warning}
此操作无法撤销。`)) return
  const removedId = removedResource.id
  const index = collection.findIndex((item) => item.id === removedId)
  if (index >= 0) collection.splice(index, 1)
  if (['world', 'characters', 'items', 'skills'].includes(currentConfig.value.collection)) {
    cleanupDeletedResourceReferences(store.value, currentConfig.value.collection as 'world' | 'characters' | 'items' | 'skills', removedResource)
  }
  syncContextResourceItems(store.value)
  selectedIds.value[activePage.value] = collection[0]?.id ?? ''
}

function updateField(key: string, value: string) {
  if (!selectedResource.value) return
  if (['world', 'characters', 'items', 'skills'].includes(activePage.value)
    && updateResourceTriggerField(selectedResource.value, key, value)) return
  const nextValue = activePage.value === 'skills' && key === '技能性质'
    ? (value === '被动' ? '被动' : '主动')
    : value
  selectedResource.value.fields[key] = nextValue
  if (activePage.value === 'skills' && key === '技能性质') selectedResource.value.tag = nextValue
}

function updateResourceMeta(key: 'allowRecursive' | 'allowFurtherRecursive' | 'injectionOrder', value: boolean | number) {
  if (!selectedResource.value) return
  if (key === 'injectionOrder') {
    const order = Math.max(0, Number(value) || 0)
    selectedResource.value.injectionOrder = order
    selectedResource.value.retrieval = { ...selectedResource.value.retrieval, injectionOrder: order }
    return
  }
  const enabled = Boolean(value)
  selectedResource.value[key] = enabled
  selectedResource.value.retrieval = {
    ...selectedResource.value.retrieval,
    [key === 'allowRecursive' ? 'allowRecursion' : 'allowFurtherRecursion']: enabled,
  }
}

function toggleResourceEnabled(id: string) {
  if (activePage.value !== 'style') return
  const resource = store.value.style.find((item) => item.id === id)
  if (!resource) return
  resource.enabled = resource.enabled === false
  globalStyleRules.value = cloneSerializable(store.value.style)
  persistGlobalSettings()
}

function updateCharacterField(key: string, value: string) {
  if (!selectedResource.value) return
  selectedResource.value.fields[key] = value
  if (key === '角色身份') selectedResource.value.tag = value
}

function updateCharacterImages(payload: { images: NonNullable<Resource['characterImages']>; coverImageId: string }) {
  if (activePage.value !== 'characters' || !selectedResource.value) return
  selectedResource.value.characterImages = payload.images
  selectedResource.value.characterCoverImageId = payload.coverImageId
}

function promptResource(resource: Resource): Resource {
  const safeResource = { ...resource }
  delete safeResource.characterImages
  delete safeResource.characterCoverImageId
  return safeResource
}

const { applyAgentOperation, describeAgentOperation } = createAgentOperations({
  store,
  activeChapter,
  selectedGroupIds,
  selectedVolumeId,
  selectedChapterId,
  chapterSearch,
  candidate,
  agentPageForType,
  insertResource,
})

function isResourceFieldLocked(resource: Resource, field: string) {
  return resource.lockedAll === true || (Array.isArray(resource.lockedFields)
    && resource.lockedFields.some((locked) => canonicalTriggerField(locked) === canonicalTriggerField(field))
  )
}

function updateProviderField(key: string, value: string) {
  if (!selectedProvider.value) return
  selectedProvider.value.fields[key] = value
  if (['协议', '接口地址', 'API Key', '使用代理', '代理地址', '代理端口'].includes(key)) {
    // Never keep a model dropdown from a different endpoint or credential.
    store.value.modelOptions[selectedProvider.value.id] = []
  }
  if (['协议', '接口地址', 'API Key', '模型', '使用代理', '代理地址', '代理端口'].includes(key) && /^(已保存|连接成功)/.test(selectedProvider.value.fields['状态'] ?? '')) {
    selectedProvider.value.fields['状态'] = '未保存'
    providerTest.value = ''
  }
}

function updateSelectedProviderTitle(value: string) {
  if (selectedProvider.value) selectedProvider.value.title = value
}

function updateSelectedProviderSummary(value: string) {
  if (selectedProvider.value) selectedProvider.value.summary = value
}

function selectProvider(id: string) {
  selectedIds.value.api = id
  providerTest.value = ''
  apiError.value = ''
}

function selectAgentProvider(id: string) {
  if (!store.value.providers.some((provider) => provider.id === id)) return
  agentProviderId.value = id
}

function selectAgentMode(mode: AgentMode) {
  if (agentMode.value === mode) return
  agentMode.value = mode
  persist()
}

function resetAgentConversationView() {
  agentPendingPlan.value = null
  agentTasks.value = [{ id: 'agent-ready', label: '等待任务', state: 'done', detail: 'Agent 已就绪' }]
  agentActivities.value = []
  agentLiveResponse.value = null
}

function activateAgentConversation(conversation: AgentConversation) {
  conversation.archived = false
  conversation.archivedAt = undefined
  activeAgentConversationId.value = conversation.id
  agentMessages.value = cloneSerializable(normalizeAgentMessages(conversation.messages, agentPersistedMessageLimit))
  if (!agentMessages.value.length) {
    agentMessages.value = [{ id: `agent-welcome-${Date.now()}`, role: 'assistant', content: agentWelcomeContent, createdAt: Date.now() }]
  }
  resetAgentConversationView()
}

function createNewAgentConversation() {
  if (!canSwitchAgentConversation.value) return
  syncActiveAgentConversation()
  const conversation = createAgentConversation()
  agentConversations.value.unshift(conversation)
  activateAgentConversation(conversation)
  persist()
}

function selectAgentConversation(id: string) {
  if (!canSwitchAgentConversation.value || id === activeAgentConversationId.value) return
  const conversation = agentConversations.value.find((item) => item.id === id)
  if (!conversation || conversation.archived) return
  syncActiveAgentConversation()
  activateAgentConversation(conversation)
  persist()
}

function renameAgentConversation(id: string) {
  if (!canSwitchAgentConversation.value) return
  const conversation = agentConversations.value.find((item) => item.id === id && item.archived !== true)
  if (!conversation) return
  const nextTitle = window.prompt('重命名对话', conversation.title)?.trim()
  if (!nextTitle || nextTitle === conversation.title) return
  conversation.title = nextTitle.slice(0, 80)
  conversation.updatedAt = Date.now()
  persist()
}

function archiveAgentConversation(id: string) {
  if (!canSwitchAgentConversation.value) return
  const conversation = agentConversations.value.find((item) => item.id === id && item.archived !== true)
  if (!conversation) return
  syncActiveAgentConversation()
  const wasActive = conversation.id === activeAgentConversationId.value
  const archivedAt = Date.now()
  conversation.archived = true
  conversation.archivedAt = archivedAt
  conversation.updatedAt = archivedAt
  if (wasActive) {
    const next = agentConversationList.value[0]
    if (next) activateAgentConversation(next)
    else {
      const fresh = createAgentConversation()
      agentConversations.value.unshift(fresh)
      activateAgentConversation(fresh)
    }
  }
  persist()
}

function deleteAgentConversation(id: string) {
  if (!canSwitchAgentConversation.value) return
  const conversation = agentConversations.value.find((item) => item.id === id && item.archived !== true)
  if (!conversation) return
  if (!window.confirm(`确定永久删除对话“${conversation.title}”吗？
删除后聊天记录无法恢复。`)) return
  syncActiveAgentConversation()
  const wasActive = conversation.id === activeAgentConversationId.value
  agentConversations.value = agentConversations.value.filter((item) => item.id !== id)
  if (wasActive) {
    const next = agentConversationList.value[0]
    if (next) activateAgentConversation(next)
    else {
      const fresh = createAgentConversation()
      agentConversations.value.unshift(fresh)
      activateAgentConversation(fresh)
    }
  }
  persist()
}

function restoreArchivedAgentConversation(id: string) {
  const conversation = agentConversations.value.find((item) => item.id === id && item.archived === true)
  if (!conversation) return
  conversation.archived = false
  conversation.archivedAt = undefined
  conversation.updatedAt = Date.now()
  persist()
}

function deleteArchivedAgentConversation(id: string) {
  const conversation = agentConversations.value.find((item) => item.id === id && item.archived === true)
  if (!conversation) return
  if (!window.confirm(`确定永久删除已归档对话“${conversation.title}”吗？
删除后聊天记录无法恢复。`)) return
  agentConversations.value = agentConversations.value.filter((item) => item.id !== id)
  persist()
}

function selectWriterProvider(id: string) {
  if (!store.value.providers.some((provider) => provider.id === id)) return
  writerProviderId.value = id
}

function selectWorldEngineProvider(id: string) {
  if (!store.value.providers.some((provider) => provider.id === id)) return
  worldEngineProviderId.value = id
}

function removeProvider() {
  const provider = selectedProvider.value
  if (!provider) return
  if (!window.confirm(`确定删除 API 预设“${provider.title}”吗？
删除后正文、Agent 和世界引擎不会再使用它。`)) return
  const index = store.value.providers.findIndex((item) => item.id === provider.id)
  if (index >= 0) store.value.providers.splice(index, 1)
  normalizeProviderDefaults(store.value.providers)
  selectedIds.value.api = store.value.providers[0]?.id ?? ''
  if (agentProviderId.value === provider.id) agentProviderId.value = ''
  if (writerProviderId.value === provider.id) writerProviderId.value = ''
  if (worldEngineProviderId.value === provider.id) worldEngineProviderId.value = ''
  providerTest.value = ''
  apiError.value = ''
}

function toggleProviderDefault(id: string) {
  if (!store.value.providers.some((provider) => provider.id === id)) return
  for (const provider of store.value.providers) provider.enabled = provider.id === id
  persist()
}

function updateContextLayout(next: ContextBlock[]) {
  const groups = normalizeContextGroups(next, store.value.contextBlocks)
  store.value.contextGroups = groups
  // Normalize collection ownership immediately after a drag. In particular,
  // custom-module entries must be returned to the custom-module block instead
  // of remaining visible under a standard resource block until the next save.
  syncContextResourceItems(store.value)
  // Keep the old flat projection for older snapshots and any integrations
  // that still read contextBlocks directly.
  store.value.contextBlocks = store.value.contextGroups.map(({ items, ...block }) => ({ ...block, items: cloneSerializable(items) }))
}


function retrievalQuery(extra = '') {
  const chapter = activeChapter.value
  return `${extra} ${chapter?.title ?? ''} ${chapter?.taskGoal ?? ''} ${chapter?.content ?? ''}`.trim()
}

function customModuleContextEnabled(schemaId: string) {
  const fallbackGroup = contextLayout.value.find((group) => group.collection === 'custom')
  const ownerGroup = contextLayout.value.find((group) => group.items.some((item) => item.customModuleId === schemaId)) ?? fallbackGroup
  if (ownerGroup?.enabled === false) return false
  const item = ownerGroup?.items.find((entry) => entry.customModuleId === schemaId)
  return item?.enabled !== false
}

function formatCustomModulesContext(): PromptPart[] {
  const customStore = store.value.customModules
  if (!customStore?.schemas.length) return []
  const layoutOrder = contextResourceOrder(store.value)
  const enabledSchemas = customStore.schemas
    .map((schema) => {
      if (!customModuleContextEnabled(schema.id)) return null
      const entries = customStore.entries
        .filter((entry) => entry.schemaId === schema.id)
        .slice(0, 16)
        .map((entry) => customModuleExamplePayload(schema, entry.data, entry.id))
      return {
        schema,
        entries,
        rank: layoutOrder.get(`custom:${schema.id}`) ?? layoutOrder.get('custom') ?? Number.POSITIVE_INFINITY,
      }
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => left.rank - right.rank)
  return enabledSchemas.map(({ schema, entries, rank }) => {
    const contract = customModulePromptContract(schema, {}, { includePromptHints: false }).schema
    return {
      rank,
      text: `[custom] ${schema.title}
${schema.description || ''}
字段契约：${JSON.stringify(contract)}
数据：${JSON.stringify(entries)}`,
    }
  })
}

function retrievedContext(extra = '', forcedCast: string[] = []) {
  const retrievalStore = { ...store.value, style: [] }
  const matches = retrieveStoreContext(retrievalStore, retrievalQuery(extra), { maxDepth: 2, maxResults: 28 })
  for (const name of forcedCast) {
    const characterIndex = store.value.characters.findIndex((character) => character.title === name)
    const character = store.value.characters[characterIndex]
    if (!character || matches.some((match) => match.collection === 'characters' && match.resource.id === character.id)) continue
    const forcedMatch: RetrievalMatch = { collection: 'characters', resource: character, sourceIndex: characterIndex, depth: 0, matchedKeys: [character.title], matchType: 'direct' }
    matches.push(forcedMatch)
  }
  const groups = contextLayout.value
  const isMatchEnabled = (match: RetrievalMatch) => {
    const layoutCollection = match.collection === 'outline' ? 'chapter' : match.collection
    const group = groups.find((candidate) => candidate.items.some((entry) => entry.resourceId === match.resource.id || entry.resourceIds?.includes(match.resource.id)))
      ?? groups.find((item) => item.collection === layoutCollection)
    if (group?.enabled === false) return false
    const item = group?.items.find((entry) => entry.resourceId === match.resource.id || entry.resourceIds?.includes(match.resource.id))
    return item?.enabled !== false
  }
  const enabledMatches = matches.filter(isMatchEnabled)
  const layoutOrder = contextResourceOrder(store.value)
  enabledMatches.sort((left, right) => {
    const configuredOrder = (match: RetrievalMatch) => {
      const specific = layoutOrder.get(`${match.collection}:${match.resource.id}`)
      const collection = layoutOrder.get(match.collection)
      return specific ?? collection ?? Number.POSITIVE_INFINITY
    }
    const order = (match: RetrievalMatch) => match.resource.retrieval?.injectionOrder ?? match.resource.injectionOrder ?? 1000
    const leftLayout = configuredOrder(left)
    const rightLayout = configuredOrder(right)
    return leftLayout - rightLayout || order(left) - order(right) || left.depth - right.depth || left.sourceIndex - right.sourceIndex
  })
  const promptParts = enabledMatches.map((match) => {
    const layoutCollection = match.collection === 'outline' ? 'chapter' : match.collection
    const specific = layoutOrder.get(`${layoutCollection}:${match.resource.id}`)
    const collection = layoutOrder.get(layoutCollection)
    return { rank: specific ?? collection ?? Number.POSITIVE_INFINITY, text: formatRetrievedContext([match]) }
  })
  const engineGroup = groups.find((group) => group.collection === 'worldEngine')
  const engineItem = engineGroup?.items.find((item) => item.collection === 'worldEngine')
  const engineText = engineGroup?.enabled !== false && engineItem?.enabled !== false ? formatWorldEngineContext(store.value.worldEngine) : ''
  if (engineText) promptParts.push({ rank: layoutOrder.get('worldEngine') ?? Number.POSITIVE_INFINITY, text: engineText })
  promptParts.push(...formatCustomModulesContext())
  promptParts.sort((left, right) => left.rank - right.rank)
  return { matches: enabledMatches, parts: promptParts, text: promptParts.map((part) => part.text).filter(Boolean).join('\n\n') }
}

type PromptPart = { rank: number; text: string }

function contextStaticEnabled(collection: string) {
  const group = contextLayout.value.find((item) => item.collection === collection)
  if (group?.enabled === false) return false
  const item = group?.items.find((entry) => !entry.resourceId && !entry.resourceIds?.length)
  return item?.enabled !== false
}

function formatOrderedContext(result: { parts: PromptPart[] }, extras: { collection: string; text: string }[] = []) {
  const layoutOrder = contextResourceOrder(store.value)
  const parts: PromptPart[] = [...result.parts]
  for (const extra of extras) {
    if (!extra.text.trim() || !contextStaticEnabled(extra.collection)) continue
    parts.push({ rank: layoutOrder.get(extra.collection) ?? Number.POSITIVE_INFINITY, text: extra.text.trim() })
  }
  return parts.sort((left, right) => left.rank - right.rank).map((part) => part.text).filter(Boolean).join('\n\n')
}

const {
  worldEngine,
  busy: worldEngineBusy,
  error: worldEngineError,
  run: runWorldEngine,
  updateTimeSpan: updateWorldEngineTimeSpan,
  addEvent: addWorldEngineEvent,
  updateEventReviewStatus: updateWorldEngineEventReviewStatus,
  toggleEventReviewStatusLock: toggleWorldEngineEventReviewStatusLock,
  toggleEventLockAll: toggleWorldEngineEventLockAll,
  approveProposal: approveWorldEngineProposal,
  rejectProposal: rejectWorldEngineProposal,
} = useWorldEngineController({
  store,
  activeChapter,
  effectiveCast,
  provider: worldEngineProvider,
  isApiConfigured,
  retrieveContextText: (query, cast) => formatOrderedContext(retrievedContext(query, cast)),
  localApiUrl,
  persist,
})

function formatStyleRulesContext() {
  const styleGroup = contextLayout.value.find((group) => group.collection === 'style')
  if (styleGroup?.enabled === false) return ''
  const styleItems = styleGroup?.items ?? []
  const layoutOrder = contextResourceOrder(store.value)
  return store.value.style
    .filter((rule) => {
      if (rule.enabled === false) return false
      const item = styleItems.find((entry) => entry.resourceId === rule.id || entry.resourceIds?.includes(rule.id))
      return item?.enabled !== false
    })
    .sort((left, right) => {
      const leftOrder = layoutOrder.get(`style:${left.id}`) ?? layoutOrder.get('style') ?? Number.POSITIVE_INFINITY
      const rightOrder = layoutOrder.get(`style:${right.id}`) ?? layoutOrder.get('style') ?? Number.POSITIVE_INFINITY
      return leftOrder - rightOrder
    })
    .map((rule) => {
      const fields = Object.entries(rule.fields ?? {}).filter(([key, value]) => value.trim() && !['反例', '正例'].includes(key) && !legacyStyleMetadataFields.has(key))
      const examples = ['反例', '正例'].map((key) => rule.fields[key]?.trim() ? `${key}：${rule.fields[key].trim()}` : '').filter(Boolean)
      return [`【${rule.title}】${rule.summary}`.trim(), ...fields.map(([key, value]) => `${key}：${value.trim()}`), ...examples].join('\n')
    })
    .join('\n\n')
}

function buildWritingMessages(chapter: Chapter): ChatMessage[] {
  const cast = effectiveCast.value
  const goal = chapter.taskGoal?.trim() || '未指定，请依据章节正文与检索资料推进当前情节。'
  const retrieved = retrievedContext(writerRetrievalTerms.value, cast)
  const contextText = formatOrderedContext(retrieved, [
    { collection: 'chapter', text: `本章任务：${goal}
出场人物：${cast.length ? cast.join('、') : '未指定（请根据正文与已检索资料判断）'}` },
    { collection: 'recent', text: `当前章节正文：
${chapter.content || '（空）'}` },
    { collection: 'style', text: `启用的文风规则（逐条遵守）：
${formatStyleRulesContext() || '当前没有启用的文风规则。'}` },
    { collection: 'output', text: '输出要求：只输出可接在正文后的中文小说正文，不要标题、说明或 Markdown。' },
  ])
  return [
          { role: 'system', content: `你是小说续写助手。严格遵守已检索资料，不新增与资料冲突的设定，不一次性复述资料。保持当前章节的叙事视角和文风。出场人物应以任务栏指定名单为准；未指定时，根据正文与检索到的角色资料自行判断。资料中的当前状态、道具归属、技能和已知信息视为事实约束。

本次上下文（按编排顺序）：
${contextText || '没有命中的资料。'}` },
          { role: 'user', content: `请续写当前章节。
章节标题：${chapter.title}
请生成 300 到 600 字的候选正文，推进本章任务。` },
        ]
}

const {
  state: writerState,
  detail: writerDetail,
  canAccept: canAcceptCandidate,
  generate: generateCandidate,
  discard: discardCandidate,
  accept: acceptCandidate,
} = useWritingGeneration({
  activeChapter,
  projectId: currentProjectId,
  provider: writerProvider,
  candidate,
  busy: isGenerating,
  error: generationError,
  buildMessages: buildWritingMessages,
  localApiUrl,
  isApiConfigured,
  updateChapterContent,
})

const writerActivityState = computed(() => {
  if (isGenerating.value || !paragraphEdit.value) return writerState.value
  if (paragraphEdit.value.status === 'waiting') return 'running'
  if (paragraphEdit.value.status === 'error') return 'error'
  if (paragraphEdit.value.status === 'ready') return 'done'
  return writerState.value
})
const writerActivityDetail = computed(() => {
  if (isGenerating.value || !paragraphEdit.value) return writerDetail.value
  const edit = paragraphEdit.value
  if (edit.status === 'waiting') return `正在修改第 ${edit.index + 1} 段${edit.response ? ` · 已接收 ${edit.response.replace(/\s/g, '').length} 字` : '，等待模型回复'}`
  if (edit.status === 'ready') return `第 ${edit.index + 1} 段修改已生成，等待采纳`
  if (edit.status === 'error') return edit.error
  return writerDetail.value
})

function localApiUrl(path: string) {
  return desktopApiPort ? `http://127.0.0.1:${desktopApiPort}${path}` : path
}

async function requestModels(resource: Resource) {
  const baseUrl = resource.fields['接口地址'] ?? ''
  const apiKey = resource.fields['API Key']?.trim() ?? ''
  if (!baseUrl.trim()) throw new Error('请先填写接口地址')
  if (!apiKey) throw new Error('请先填写 API Key')

  const response = await fetch(localApiUrl('/api/proxy/models'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiKey,
      protocol: resource.fields['协议'] ?? 'OpenAI Compatible',
      useProxy: resource.fields['使用代理'] === 'true',
      proxyHost: resource.fields['代理地址'] ?? '',
      proxyPort: resource.fields['代理端口'] ?? '',
    }),
  }).catch(() => { throw new Error('本地代理服务未启动，请重新启动桌面应用') })
  const body = await response.json().catch(() => null) as { models?: unknown[]; error?: string } | null
  if (!response.ok) throw new Error(body?.error || `本地代理返回 ${response.status}`)
  const ids = (body?.models ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (!ids.length) throw new Error('中转站返回了空模型列表')
  return [...new Set(ids)]
}

async function testProvider() {
  if (!selectedProvider.value) return
  providerTest.value = '测试中'
  apiError.value = ''
  try {
    const models = await requestModels(selectedProvider.value)
    store.value.modelOptions[selectedProvider.value.id] = models
    selectedProvider.value.fields['状态'] = `连接成功 · ${models.length} 个模型`
    providerTest.value = '连接成功'
  } catch (error) {
    const message = error instanceof Error ? error.message : '连接失败'
    apiError.value = message
    selectedProvider.value.fields['状态'] = `连接失败：${message}`
    providerTest.value = '连接失败'
  }
}

async function fetchModels() {
  if (!selectedProvider.value) return
  providerTest.value = '拉取中'
  apiError.value = ''
  try {
    const models = await requestModels(selectedProvider.value)
    store.value.modelOptions[selectedProvider.value.id] = models
    selectedProvider.value.fields['模型'] = ''
    selectedProvider.value.fields['状态'] = `模型已更新 · ${models.length} 个`
    providerTest.value = '模型已更新'
  } catch (error) {
    apiError.value = error instanceof Error ? error.message : '获取模型失败'
    selectedProvider.value.fields['状态'] = `获取模型失败：${apiError.value}`
    providerTest.value = '获取失败'
  }
}

function apiModels(resource: Resource | undefined) {
  return resource ? (store.value.modelOptions[resource.id] ?? []) : []
}

function isApiConfigured(resource: Resource) {
  const fields = resource.fields
  const complete = Boolean(fields['接口地址']?.trim() && fields['API Key']?.trim() && fields['模型']?.trim())
  const savedOrVerified = /^(已保存|连接成功)/.test(fields['状态'] ?? '')
  if (!complete || !savedOrVerified) return false
  try {
    readModelSettings(resource)
    return true
  } catch {
    return false
  }
}

function apiStatusLabel(resource: Resource) {
  return isApiConfigured(resource) ? '可用' : '未配置'
}

async function saveProvider() {
  const provider = selectedProvider.value
  if (!provider) return
  const fields = provider.fields
  const model = fields['模型']?.trim() ?? ''
  apiError.value = ''
  if (!fields['接口地址']?.trim()) {
    apiError.value = '请先填写接口地址'
    providerTest.value = '保存失败'
    return
  }
  if (!fields['API Key']?.trim()) {
    apiError.value = '请先填写 API Key'
    providerTest.value = '保存失败'
    return
  }
  if (!model) {
    apiError.value = '请先选择模型'
    providerTest.value = '保存失败'
    return
  }
  providerTest.value = '保存中'
  try {
    readModelSettings(provider)
    // Saving a preset is also its final verification step. Re-fetch the
    // provider's model list so a stale local model list cannot make an
    // unreachable or misspelled preset appear available.
    const availableModels = await requestModels(provider)
    store.value.modelOptions[provider.id] = availableModels
    if (!availableModels.includes(model)) {
      throw new Error('当前模型名称不在接口返回的模型列表中，请重新获取并选择')
    }
    fields['状态'] = '已保存 · 可用'
    providerTest.value = '已保存'
    persist()
  } catch (error) {
    fields['状态'] = '未配置'
    apiError.value = error instanceof Error ? error.message : '无法验证 API 配置'
    providerTest.value = '保存失败'
  }
}

function customModuleLinkedResources(schema: CustomModuleStore['schemas'][number], entry: CustomModuleStore['entries'][number]) {
  type ReferenceCollection = 'characters' | 'items' | 'skills'
  const resourcesByCollection: Record<ReferenceCollection, Resource[]> = {
    characters: store.value.characters,
    items: store.value.items,
    skills: store.value.skills,
  }
  const linkedResources: Array<{
    collection: ReferenceCollection
    id: string
    title: string
    depth: number
    linkedBy?: { collection: ReferenceCollection; id: string; field: string }
    resource?: Resource
  }> = []
  const visited = new Set<string>()
  const append = (
    collection: ReferenceCollection,
    id: string,
    depth: number,
    linkedBy?: { collection: ReferenceCollection; id: string; field: string },
  ) => {
    const normalizedId = id.trim()
    if (!normalizedId) return
    const key = `${collection}:${normalizedId}`
    if (visited.has(key)) return
    visited.add(key)
    const resource = resourcesByCollection[collection].find((item) => item.id === normalizedId)
    if (!resource) {
      linkedResources.push({ collection, id: normalizedId, title: '已删除的卡片', depth, linkedBy })
      return
    }
    linkedResources.push({ collection, id: resource.id, title: resource.title, depth, linkedBy, resource: promptResource(resource) })
    if (collection !== 'characters' || depth > 0) return
    resource.holdingItems?.forEach((holdingId) => append('items', holdingId, depth + 1, { collection, id: resource.id, field: 'holdingItems' }))
    resource.holdingSkills?.forEach((holdingId) => append('skills', holdingId, depth + 1, { collection, id: resource.id, field: 'holdingSkills' }))
  }

  schema.fields.forEach((field) => {
    const collection = field.type === 'characterIndex'
      ? 'characters'
      : field.type === 'itemIndex'
        ? 'items'
        : field.type === 'skillIndex'
          ? 'skills'
          : null
    if (!collection) return
    const values = Array.isArray(entry.data[field.key])
      ? entry.data[field.key] as string[]
      : typeof entry.data[field.key] === 'string'
        ? [entry.data[field.key] as string]
        : []
    values.forEach((id) => append(collection, id, 0, { collection, id, field: field.key }))
  })
  return linkedResources
}

function buildAgentRequest(prompt: string, mode: AgentMode) {
  // Budget the full request once, including protected system instructions and
  // retrieved material. Collecting history here must not pre-trim its report.
  const conversation = collectAgentConversation(agentMessages.value, prompt)
  const schemaText = JSON.stringify(agentResponseSchema)
  const retrieved = retrievedContext(prompt)
  const matches = retrieved.matches
  const retrievedText = formatOrderedContext(retrieved, [
    ...(mode === 'writing' ? [{ collection: 'style', text: `当前启用的文风规则（请严格遵守）：
${formatStyleRulesContext() || '当前没有启用的文风规则。'}` }] : []),
    { collection: 'output', text: '输出要求：只返回符合 Agent 协议的 JSON。文风规则不使用触发策略、触发键或检查方式字段；创建和更新规则时只填写规则及可选正反例。' },
  ])
  const creationPromptHintsText = JSON.stringify(standardCreationPromptHints.value, null, 2)
  const groupCollectionTerms: Record<GroupedResourceCollection, RegExp> = {
    world: /世界书/u,
    characters: /角色卡|角色|人物/u,
    items: /道具卡|道具|物品/u,
    skills: /技能卡|技能/u,
    style: /文风规则|文风/u,
  }
  const mentionedGroupCollections = groupedResourcePages.filter((collection) => groupCollectionTerms[collection].test(prompt))
  const catalogCollections = mentionedGroupCollections.length
    ? mentionedGroupCollections
    : activeGroupPage.value ? [activeGroupPage.value] : []
  const workspace = {
    currentChapter: activeChapter.value ? {
      id: activeChapter.value.id,
      title: activeChapter.value.title,
      taskGoal: activeChapter.value.taskGoal ?? '',
      cast: activeChapter.value.cast ?? [],
      content: activeChapter.value.content,
    } : null,
    volumes: store.value.volumes.map((volume) => ({ id: volume.id, title: volume.title })),
    // Only expose the confirmed, compact projection. The raw state also
    // contains pending proposals and execution logs, which are workbench
    // metadata rather than story facts and must not be treated as canon by a
    // model.
    worldEngine: formatWorldEngineContext(store.value.worldEngine) || null,
    customModules: (store.value.customModules?.schemas ?? []).filter((schema) => customModuleContextEnabled(schema.id)).map((schema) => {
      const promptContract = customModulePromptContract(schema, {}, { includePromptHints: false })
      const creationPromptContract = customModulePromptContract(schema)
      return {
        id: schema.id,
        type: schema.type,
        title: schema.title,
        description: schema.description,
        titleField: schema.titleField,
        // Keep both the normalized schema and the JSON contract in the workspace.
        // The normalized schema lets the Agent preserve field metadata when it
        // creates a new module, while the contract describes the values expected
        // in each entry.
        schema: {
          id: schema.id,
          type: schema.type,
          title: schema.title,
          description: schema.description,
          titleField: schema.titleField,
          // Keep creation-only promptHint values out of the ordinary schema
          // view. They are supplied separately through creationContract.
          fields: schema.fields.map(({ promptHint: _promptHint, ...field }) => field),
        },
        // The ordinary contract describes the stored data only. Creation
        // guidance is kept in a separate contract so it cannot be mistaken
        // for an existing entry fact during retrieval or updates.
        contract: promptContract.schema,
        creationContract: creationPromptContract.schema,
        example: promptContract.example,
        entries: (store.value.customModules?.entries ?? [])
          .filter((entry) => entry.schemaId === schema.id)
          .slice(0, 24)
          .map((entry) => ({
            ...customModuleExamplePayload(schema, entry.data, entry.id),
            title: entry.title,
            lockedAll: entry.lockedAll === true,
            lockedFields: entry.lockedFields ?? [],
            linkedResources: customModuleLinkedResources(schema, entry),
          })),
      }
    }),
    customModuleReferenceCatalog: {
      characters: store.value.characters.map(({ id, title }) => ({ id, title })),
      items: store.value.items.map(({ id, title }) => ({ id, title })),
      skills: store.value.skills.map(({ id, title }) => ({ id, title })),
    },
    networkMemes: (store.value.memes?.entries ?? []).filter((meme) => meme.enabled).slice(0, 24).map((meme) => ({
      id: meme.id,
      name: meme.name,
      explanation: meme.explanation,
      usage: meme.usage,
      examples: meme.examples,
      keywords: meme.keywords,
      source: meme.source,
    })),
    resourceGroupCatalog: Object.fromEntries(catalogCollections.map((collection) => [collection, {
      groups: store.value.resourceGroups[collection].map(({ id, title }) => ({ id, title })),
      resources: (store.value[collection] as Resource[]).map(({ id, title, groupId }) => ({ id, title, groupId: groupId ?? null })),
    }])),
    retrievedResources: matches.slice(0, 28).map((match) => ({
      collection: match.collection,
      id: match.resource.id,
      title: match.resource.title,
      depth: match.depth,
      matchedKeys: match.matchedKeys,
      resource: promptResource(match.resource),
    })),
  }
  const messages: ChatMessage[] = [
        { role: 'system', content: `你是叙事工坊的作品维护 Agent。${mode === 'writing' ? '当前为写作模式：所有创作性回复、正文和资料文字都必须遵守上下文中的启用文风规则；文风规则不可忽略。' : '当前为灵感模式：可以不受文风规则约束，自由讨论、分析和发散剧情。仍须把检索到的作品资料作为已知事实；推测和建议不得伪装成既定事实。只有用户明确要求写入作品时才生成修改操作。'}你可以创建或更新世界书、角色、道具、技能、大纲、世界引擎事件、文风规则，也可以创建实验性自定义模块，以及创建、更新和删除自定义模块条目，可以创建章节和分卷，也可以追加当前章节正文。下方还会附带当前作品最近的 Agent 对话历史；它用于理解用户前后文，不能替代当前作品资料，也不能把聊天中的猜测当成已确认事实。已启用的网络热梗表会作为独立资料提供给你；网络热梗不能当作世界书条目。当前已有网络热梗：${JSON.stringify(workspace.networkMemes)}。当用户要求搜索网络热梗、近期网络梗或最新网络流行表达时，必须返回 search_web_memes 操作，不能创建世界书条目代替搜索。search_web_memes 会由桌面端联网搜索，并调用整理流程提炼每条热梗的名称、表达、含义和适用场景，整理后直接写入独立的网络热梗栏目；不要把网络热梗创建成世界书条目。创建章节时必须返回 create_chapter 操作；创建分卷时必须返回 create_volume 操作。章节 title 必填，content 可选；volumeId 可省略（此时归入当前分卷），若指定必须使用下面提供的有效分卷 ID。分卷 title 必填。严格只返回 JSON，不要 Markdown，不要额外解释。返回值必须符合下面的 JSON Schema：${schemaText}

资源类型边界：所有标准资源都必须使用固定模板。创建 world、character、item、skill、outline、world_event、style 时，必须返回完整字段集合，即使字段没有内容也要写空字符串，并设置 includeAllFields:true。更新操作只发送确实需要修改的字段，fields 是局部补丁，不会覆盖其他字段；用户说“只修改某一项/补充某个字段/把标签改成关键词”时必须使用 update_resource，只提交该字段。触发词或标签必须写入已有字段“触发键”，不能新增“标签”字段。固定模板为：world=触发策略、触发键、内容、适用范围、状态；character=触发策略、触发键、角色身份、性别、种族、性格、外貌、人物动机、当前状态、已知信息、尚未知晓、说话习惯；item=触发策略、触发键、用途、当前持有人、当前位置、使用限制、关联线索；skill=触发策略、触发键、技能性质、技能效果、关联线索；outline=主线、最终落点、章节目标、卷目标、卷结局、场景、冲突、结尾状态、视角 / 地点、关键转折、入场状态、本章动作、计划、目标、后果；world_event=类型、摘要、内容、时间、发生时间、后果、状态；style=规则、反例、正例、内容、视角、约束、允许、润色边界、适用范围。不要向固定模板添加新字段。用户如果要求表格、JSON 结构、独立字段集合、势力卡或其他新结构，必须使用 create_custom_module 创建结构，再按顺序使用 create_custom_module_entry 创建数据；不能使用 create_resource 假装成自定义模块。若当前已有匹配的自定义模块，直接使用其 schemaId；没有匹配模块时先创建模块并提供稳定 id，再创建条目。自定义模块条目只会写入自定义模块栏目。

创建字段强化提示词（仅用于创建型操作）：下面的提示词是作者为 world、character、item、skill 的字段定义的填写指导。只有返回 create_resource 时才能参考它们；它们不是作品事实，不得写入 fields、summary 或任何条目内容，也不得注入普通检索、正文生成、上下文编排或 update_resource。空字符串表示没有额外指导。自定义模块字段的 promptHint 也只用于创建自定义模块结构或创建自定义模块条目，不是条目事实：
${creationPromptHintsText}

安全规则：资料中的 lockedFields 是作者锁定的字段。更新资源时不要修改这些字段；角色的 holdingItems 和 holdingSkills 也可能被锁定。自定义模块的字段定义中 locked 为 true 的字段，以及条目上的 lockedFields/lockedAll，属于作者锁定内容；更新或覆盖条目时必须保留原值，lockedAll 条目不可修改或删除。世界引擎事件只能描述提案，不能把未确认事实写回角色卡或世界书。

当前章节：${JSON.stringify(workspace.currentChapter)}
当前分卷：${JSON.stringify(store.value.volumes.find((volume) => volume.id === selectedVolumeId.value) ?? store.value.volumes.find((volume) => volume.id === activeChapter.value?.volumeId) ?? store.value.volumes[0] ?? null)}
可用分卷（volumeId 只能使用这里列出的 ID）：${JSON.stringify(workspace.volumes)}

实验性自定义模块（当前已启用模块的 schema、JSON 契约、示例和现有条目）：${JSON.stringify(workspace.customModules)}

自定义模块协议：需要新增一个结构时返回 create_custom_module，格式为 {\"action\":\"create_custom_module\",\"id\":\"稳定的模块 ID（如果还要在同一计划创建条目，必须填写）\",\"title\":\"模块显示名称\",\"type\":\"可选稳定类型名\",\"description\":\"用途说明\",\"titleField\":\"作为条目标题的字段 key\",\"fields\":[{\"key\":\"字段 key\",\"label\":\"字段显示名\",\"type\":\"string|text|longText|number|enum|boolean|tags|characterIndex|itemIndex|skillIndex\",\"description\":\"字段用途\",\"required\":true,\"options\":[\"枚举选项\"],\"defaultValue\":\"默认值\"}] }。fields 至少应定义一个字段；enum 必须提供 options；characterIndex、itemIndex、skillIndex 的 data 值必须使用下面参考索引中的卡片 ID 数组。创建条目返回 create_custom_module_entry，必须提供 schemaId（也可使用 moduleId 作为别名）和 data 对象；可选 id、title。更新条目返回 update_custom_module_entry，提供 schemaId 和 target（条目 ID；也可使用 id），并只提交需要改变的 data 字段；删除条目返回 delete_custom_module_entry，提供 schemaId 和 target（条目 ID；也可使用 id）。需要同时创建模块和条目时，按先 create_custom_module（必须自行填写稳定 id）再 create_custom_module_entry（使用相同 schemaId）的顺序返回操作；如果无法确定稳定 ID，就只创建模块，不要猜测条目 schemaId。不要用 create_resource 代替自定义模块操作，也不要把自定义模块条目写入世界书。字段值会按 schema 校验和归一化；字段名必须来自对应结构，类型或枚举不匹配时会拒绝执行。所有自定义模块操作都必须先经过用户确认再执行。

自定义模块参考索引（索引字段只能引用下面列出的卡片 ID）：${JSON.stringify(workspace.customModuleReferenceCatalog)}

已确认的世界引擎状态：${formatWorldEngineContext(store.value.worldEngine) || '尚未建立'}

上下文资料（按编排顺序，未命中的资料不会提供给你）：
${retrievedText || '没有命中的资料。'}

结构化检索结果：${JSON.stringify(workspace.retrievedResources)}` },
        { role: 'system', content: `你也可以管理折叠栏，支持的 collection 只有 world（世界书）、characters（角色卡）、items（道具卡）、skills（技能卡）、style（文风规则）。可新建和删除折叠栏，也可把条目移入折叠栏或用 groupTarget: null 移回未分组；删除折叠栏只会保留条目并解除分组。创建条目时 groupTarget 可指定折叠栏 ID 或名称，null 或省略表示未分组。名称若有重名应使用索引中的 ID。style 折叠栏属于全局文风规则设置，会跨作品保留。当前分组与条目索引（只提供本次请求相关分类；若没有相关分类，请先询问用户，不要猜测目标）：${JSON.stringify(workspace.resourceGroupCatalog)}` },
        { role: 'system', content: '所有作品条目都有 creationSource、reviewStatus、reviewStatusLocked、lockedAll 元数据。creationSource 由应用记录，不可修改；新建条目会自动记录来源。reviewStatus 只接受 pending 或 complete，用户明确要求校对/标记完成时可以通过 update_resource 修改。reviewStatusLocked 为 true 时不得切换校对状态；lockedAll 为 true 时不得修改该条目任何内容，也不得移动其折叠栏归属。逐字段 lockedFields 与 holdingItems/holdingSkills 锁定规则仍然有效。' },
        ...conversation,
  ]
  return { messages, matchCount: matches.length, conversationCount: conversation.length }
}

async function requestAgentResponse(
  prompt: string,
  mode: AgentMode,
  options: { onDelta?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<AgentResponse> {
  const provider = agentProvider.value
  if (!provider || !isApiConfigured(provider)) throw new Error('当前没有已保存且可用的 API 预设')
  const request = buildAgentRequest(prompt, mode)
  const modelSettings = readModelSettings(provider)
  const budget = prepareContextBudget(request.messages, modelSettings).report
  const keptConversationCount = request.conversationCount - budget.trimmedMessages
  updateAgentTask('read', { detail: `已检索 ${request.matchCount} 条作品资料，保留 ${keptConversationCount} 条对话上下文` })
  addAgentActivity('检索作品上下文', `命中 ${request.matchCount} 条资料；按 Token 预算保留 ${keptConversationCount} 条对话消息，裁剪 ${budget.trimmedMessages} 条历史消息。本次输入估算 ${budget.estimatedInputTokens.toLocaleString()} Token。`, 'done', 'tool')
  const text = await requestChat(localApiUrl, {
    ...modelSettings,
    providerId: provider.id,
    purpose: 'agent',
    baseUrl: provider.fields['接口地址'],
    apiKey: provider.fields['API Key'],
    protocol: provider.fields['协议'] ?? 'OpenAI Compatible',
    model: provider.fields['模型'],
    responseFormat: 'json_object',
    stream: provider.fields['流式输出'] !== 'false',
    signal: options.signal,
    useProxy: provider.fields['使用代理'] === 'true',
    proxyHost: provider.fields['代理地址'] ?? '',
    proxyPort: provider.fields['代理端口'] ?? '',
    messages: request.messages,
  }, { onDelta: options.onDelta })
  options.signal?.throwIfAborted()
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  let raw: unknown
  try { raw = JSON.parse(clean) } catch { throw new Error('模型返回的内容不是有效 JSON') }
  const validation = validateAgentResponse(
    raw,
    new Set(store.value.volumes.map((volume) => volume.id)),
    store.value.customModules?.schemas ?? [],
  )
  if (!validation.ok) throw new Error(`Agent 响应校验失败：${validation.error}`)
  return validation.value
}

function updateAgentTask(id: string, patch: Partial<AgentTask>) {
  const task = agentTasks.value.find((item) => item.id === id)
  if (task) Object.assign(task, patch)
}

function addAgentActivity(title: string, detail = '', state: AgentActivityEvent['state'] = 'done', kind: AgentActivityEvent['kind'] = 'status') {
  const event: AgentActivityEvent = {
    id: `agent-activity-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    detail: detail.trim() || undefined,
    createdAt: Date.now(),
    state,
    kind,
  }
  agentActivities.value.unshift(event)
  if (agentActivities.value.length > 80) agentActivities.value.splice(80)
  return event.id
}

function updateAgentActivity(id: string, patch: Partial<Pick<AgentActivityEvent, 'title' | 'detail' | 'state' | 'kind'>>) {
  const event = agentActivities.value.find((item) => item.id === id)
  if (!event) return
  Object.assign(event, patch)
}

function addAgentResultMessage(content: string, role: 'assistant' | 'system' = 'assistant') {
  agentMessages.value.push({
    id: `agent-result-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    content,
    createdAt: Date.now(),
    activities: normalizeAgentActivities(agentActivities.value),
  })
}

function finishAgentActivities(state: 'done' | 'error', detail?: string) {
  for (const activity of agentActivities.value) {
    if (activity.state !== 'running') continue
    activity.state = state
    if (detail) activity.detail = detail
  }
}

function resetAgentTasks() {
  if (agentBusy.value || agentPendingPlan.value) return
  agentTasks.value = [{ id: 'agent-ready', label: '等待任务', state: 'done', detail: 'Agent 已就绪' }]
  agentActivities.value = []
  agentLiveResponse.value = null
}

function captureAgentSnapshot(): AgentSnapshot {
  const current = store.value
  return cloneSerializable({
    volumes: current.volumes,
    chapters: current.chapters,
    world: current.world,
    characters: current.characters.map(promptResource),
    items: current.items,
    skills: current.skills,
    outline: current.outline,
    style: current.style,
    resourceGroups: current.resourceGroups,
    worldEngine: current.worldEngine,
    customModules: current.customModules,
    memes: current.memes,
    contextBlocks: current.contextBlocks,
    contextGroups: current.contextGroups,
  })
}

function agentStoreFingerprint() {
  return JSON.stringify(captureAgentSnapshot())
}

function agentPlanFingerprint() {
  return JSON.stringify({
    store: agentStoreFingerprint(),
    chapterId: selectedChapterId.value,
    volumeId: selectedVolumeId.value,
  })
}

function restoreAgentSnapshot(snapshot: AgentSnapshot) {
  const current = store.value
  const currentCharacters = new Map(current.characters.map((character) => [character.id, character]))
  if (snapshot.volumes) current.volumes = cloneSerializable(snapshot.volumes)
  current.chapters = cloneSerializable(snapshot.chapters)
  current.world = cloneSerializable(snapshot.world)
  current.characters = cloneSerializable(snapshot.characters).map((character) => {
    const latest = currentCharacters.get(character.id)
    const images = latest?.characterImages ?? character.characterImages
    const coverImageId = latest?.characterCoverImageId ?? character.characterCoverImageId
    const restored = { ...character }
    delete restored.characterImages
    delete restored.characterCoverImageId
    if (images !== undefined) restored.characterImages = images
    if (coverImageId !== undefined) restored.characterCoverImageId = coverImageId
    return restored
  })
  current.items = cloneSerializable(snapshot.items)
  current.skills = cloneSerializable(snapshot.skills)
  current.outline = cloneSerializable(snapshot.outline)
  current.style = cloneSerializable(snapshot.style)
  current.resourceGroups = cloneSerializable(snapshot.resourceGroups)
  // Older history entries predate World Engine. Do not erase a current engine
  // state just because that legacy snapshot has no field for it.
  if (snapshot.worldEngine) current.worldEngine = cloneSerializable(snapshot.worldEngine)
  if (snapshot.customModules) current.customModules = cloneSerializable(snapshot.customModules)
  if (snapshot.memes) current.memes = cloneSerializable(snapshot.memes)
  // Older persisted Agent history entries predate the context layout fields.
  // Keep the current layout when those snapshots do not contain them.
  if (Array.isArray(snapshot.contextBlocks)) current.contextBlocks = cloneSerializable(snapshot.contextBlocks)
  if (Array.isArray(snapshot.contextGroups)) current.contextGroups = cloneSerializable(snapshot.contextGroups)
  for (const collection of ['world', 'characters', 'items', 'skills'] as const) {
    current[collection] = current[collection].map(normalizeResourceTriggers)
  }
  // Custom-module operations can add or remove schemas. Rebuild the
  // context-layout items when restoring an Agent snapshot so undo/error
  // recovery does not leave stale custom-module entries in the inspector.
  syncContextResourceItems(current)
}

function addAgentHistory(plan: AgentPlan, snapshot: AgentSnapshot, changes: string[], afterFingerprint = agentStoreFingerprint()) {
  agentHistory.value.unshift({
    id: plan.id,
    summary: changes.length > 1 ? `Agent 执行 ${changes.length} 项修改` : changes[0] ?? 'Agent 修改',
    changes,
    createdAt: Date.now(),
    status: 'applied',
    snapshot,
    afterFingerprint,
  })
  if (agentHistory.value.length > agentHistoryLimit.value) agentHistory.value.splice(agentHistoryLimit.value)
}

function rejectAgentPlan() {
  if (!agentPendingPlan.value || agentBusy.value) return
  const plan = agentPendingPlan.value
  agentPendingPlan.value = null
  agentTasks.value = [
    { id: 'read', label: '读取当前作品资料', state: 'done', detail: '已读取当前作品资料' },
    { id: 'plan', label: '分析请求并生成操作计划', state: 'done', detail: `已生成 ${plan.operations.length} 个操作` },
    { id: 'execute', label: '执行作品资料变更', state: 'done', detail: '已取消，作品未修改' },
    { id: 'report', label: '整理执行结果', state: 'done', detail: '已记录取消结果' },
  ]
  addAgentActivity('已取消修改计划', `未写入作品，取消了 ${plan.operations.length} 项待确认操作。`, 'done', 'result')
  addAgentResultMessage('已取消这次修改，作品资料没有变化。', 'system')
}

async function approveAgentPlan() {
  const plan = agentPendingPlan.value
  if (!plan || agentBusy.value) return
  const executionEpoch = agentRunEpoch
  if (plan.storeFingerprint && plan.storeFingerprint !== agentPlanFingerprint()) {
    agentPendingPlan.value = null
    agentTasks.value = [
      { id: 'read', label: '读取当前作品资料', state: 'done', detail: '已读取当前作品资料' },
      { id: 'plan', label: '分析请求并生成操作计划', state: 'error', detail: '计划生成后作品资料发生变化' },
      { id: 'execute', label: '执行作品资料变更', state: 'done', detail: '未执行，避免把旧计划写入新状态' },
      { id: 'report', label: '整理执行结果', state: 'done', detail: '请重新发送请求生成新计划' },
    ]
    addAgentActivity('计划已失效', '作品资料或当前章节在计划生成后发生变化，未执行旧计划。', 'error', 'error')
    addAgentResultMessage('作品资料或当前章节在计划生成后发生了变化。为避免写错章节或覆盖你的新修改，这次计划已取消，请重新发送请求。', 'system')
    return
  }
  const controller = new AbortController()
  agentAbortController = controller
  agentBusy.value = true
  const snapshot = captureAgentSnapshot()
  const previousChapterId = selectedChapterId.value
  const previousVolumeId = selectedVolumeId.value
  let hasAppliedChanges = false
  updateAgentTask('execute', { state: 'running', detail: '等待写入作品资料' })
  const executionActivityId = addAgentActivity('执行修改计划', `准备执行 ${plan.operations.length} 项操作。`, 'running', 'tool')
  try {
    const collectedSearches = new Map<number, Awaited<ReturnType<typeof collectWebMemesForAgent>>>()
    // Finish asynchronous work before mutating the project. Switching works
    // or editing during retrieval must never leave a half-applied plan.
    for (const [index, operation] of plan.operations.entries()) {
      if (executionEpoch !== agentRunEpoch) return
      if (operation.action === 'search_web_memes') {
        const searchActivityId = addAgentActivity('联网检索网络热梗', `正在拆分关键词并分批搜索（${operation.engine}）。`, 'running', 'tool')
        const collected = await collectWebMemesForAgent(operation.query, operation.engine, operation.limit, executionEpoch)
        if (executionEpoch !== agentRunEpoch) return
        collectedSearches.set(index, collected)
        updateAgentActivity(searchActivityId, { title: '网络热梗已整理', detail: `搜索 ${collected.queries.length} 批，提炼 ${collected.entries.length} 条，等待写入栏目。`, state: 'done', kind: 'result' })
      }
    }
    if (executionEpoch !== agentRunEpoch) return
    controller.signal.throwIfAborted()
    if (plan.storeFingerprint && plan.storeFingerprint !== agentPlanFingerprint()) {
      agentPendingPlan.value = null
      throw new Error('准备执行期间作品资料或当前章节发生变化，计划已取消，请重新发送请求。')
    }
    const changes: string[] = []
    // The commit contains no awaits, so failure can restore this snapshot
    // without erasing edits made by the author while network requests ran.
    for (const [index, operation] of plan.operations.entries()) {
      hasAppliedChanges = true
      if (operation.action === 'search_web_memes') {
        const collected = collectedSearches.get(index)!
        for (const meme of collected.entries) {
          createMemeEntry({ ...meme, id: meme.id || `meme-agent-${Date.now()}`, createdBy: 'agent' }, false)
        }
        memeCandidates.value = []
        const names = collected.entries.slice(0, 5).map((meme) => meme.name).filter(Boolean).join('、')
        changes.push(`已拆分 ${collected.queries.length} 条关键词，分批联网检索并整理 ${collected.entries.length} 条网络热梗（${operation.engine}），已写入网络热梗栏目${names ? `：${names}${collected.entries.length > 5 ? '等' : ''}` : ''}`)
        addAgentActivity('写入网络热梗栏目', `已添加 ${collected.entries.length} 条：${names}${collected.entries.length > 5 ? '等' : ''}。`, 'done', 'tool')
      } else {
        const change = applyAgentOperation(operation)
        changes.push(change)
        addAgentActivity('写入作品资料', change, 'done', 'tool')
      }
    }
    if (executionEpoch !== agentRunEpoch) return
    // Keep the context orchestrator in sync with schemas created or removed by
    // the Agent before the plan is persisted and shown to the user.
    syncContextResourceItems(store.value)
    // Capture the exact post-plan state. Undo is only safe while the author
    // has not changed the work after Agent execution; otherwise restoring the
    // whole pre-plan snapshot would erase the author's newer manual edits.
    addAgentHistory(plan, snapshot, changes, agentStoreFingerprint())
    agentPendingPlan.value = null
    updateAgentTask('execute', { state: 'done', detail: changes.join('；') })
    updateAgentActivity(executionActivityId, { state: 'done', detail: `已完成 ${changes.length} 项修改。`, kind: 'result' })
    updateAgentTask('report', { state: 'running' })
    const reportActivityId = addAgentActivity('整理执行结果', '正在生成执行摘要并保存修改记录。', 'running', 'result')
    updateAgentTask('report', { state: 'done', detail: '修改记录已保存，可在右侧撤销' })
    updateAgentActivity(reportActivityId, { state: 'done', detail: '修改记录已保存，可在右侧撤销。' })
    addAgentResultMessage(`已按你的确认执行：\n${changes.join('\n')}`)
    persist()
  } catch (error) {
    if (executionEpoch !== agentRunEpoch) return
    if (hasAppliedChanges) {
      restoreAgentSnapshot(snapshot)
      selectedChapterId.value = previousChapterId
      selectedVolumeId.value = previousVolumeId
    }
    const message = error instanceof Error ? error.message : 'Agent 执行失败'
    const recovery = hasAppliedChanges ? '已恢复执行前状态' : '尚未写入作品，现有修改已保留'
    updateAgentTask('execute', { state: 'error', detail: message })
    updateAgentTask('report', { state: 'done', detail: recovery })
    updateAgentActivity(executionActivityId, { state: 'error', detail: message, kind: 'error' })
    finishAgentActivities('error', recovery)
    addAgentActivity(`执行失败，${recovery}`, message, 'error', 'error')
    addAgentResultMessage(`执行失败，${recovery}：${message}`, 'system')
    persist()
  } finally {
    if (executionEpoch === agentRunEpoch) {
      agentBusy.value = false
      agentAbortController = undefined
    }
  }
}

function undoAgentHistory(id: string) {
  if (agentBusy.value || id !== latestUndoableHistoryId.value) return
  const entry = agentHistory.value.find((item) => item.id === id)
  if (!entry || entry.status === 'undone') return
  if (entry.afterFingerprint && entry.afterFingerprint !== agentStoreFingerprint()) {
    addAgentActivity('撤销已阻止', '作品在这笔修改后又发生变化，避免覆盖新的手动编辑。', 'error', 'error')
    addAgentResultMessage('这笔 Agent 修改之后作品又发生了变化。为避免撤销覆盖新的手动修改，本次撤销已停止；请先保存当前内容，再重新生成计划。', 'system')
    return
  }
  restoreAgentSnapshot(entry.snapshot)
  entry.status = 'undone'
  addAgentActivity('已撤销 Agent 修改', entry.summary, 'done', 'result')
  addAgentResultMessage(`已撤销：${entry.summary}`, 'system')
  persist()
}

async function runAgentPrompt(prompt: string) {
  if (agentBusy.value || agentPendingPlan.value) return
  if (!agentConversations.value.length || !activeAgentConversationId.value) {
    restoreAgentConversationState(undefined, undefined, agentMessages.value)
  }
  const requestMode = agentMode.value
  const requestEpoch = ++agentRunEpoch
  const requestFingerprint = agentPlanFingerprint()
  const controller = new AbortController()
  agentAbortController = controller
  const now = Date.now()
  agentMessages.value.push({ id: `agent-user-${now}`, role: 'user', content: prompt, createdAt: now })
  const activeConversation = agentConversations.value.find((conversation) => conversation.id === activeAgentConversationId.value)
  if (activeConversation) {
    if (activeConversation.title === '新对话') activeConversation.title = agentConversationTitle(prompt)
    activeConversation.updatedAt = now
  }
  agentBusy.value = true
  agentLiveResponse.value = null
  agentActivities.value = []
  addAgentActivity('收到 Agent 请求', prompt.replace(/\s+/g, ' ').slice(0, 160), 'done', 'status')
  agentTasks.value = [
    { id: 'read', label: '读取当前作品资料', state: 'running', detail: '检查章节、卡片和世界书结构' },
    { id: 'plan', label: '分析请求并生成操作计划', state: 'queued' },
    { id: 'execute', label: '执行作品资料变更', state: 'queued' },
    { id: 'report', label: '整理执行结果', state: 'queued' },
  ]
  const readActivityId = addAgentActivity('读取当前作品资料', '检查章节、卡片、世界书和上下文编排。', 'running', 'tool')
  let planActivityId = ''
  let modelActivityId = ''
  try {
    if (requestEpoch !== agentRunEpoch) return
    updateAgentTask('read', { state: 'done', detail: '已读取当前作品资料' })
    updateAgentActivity(readActivityId, { state: 'done', detail: '章节、卡片和世界书已载入。' })
    updateAgentTask('plan', { state: 'running', detail: '按 Agent JSON 操作协议解析请求' })
    planActivityId = addAgentActivity('分析请求并生成操作计划', '按 Agent JSON 协议整理可执行操作。', 'running', 'model')
    const usingModel = Boolean(agentProvider.value && isApiConfigured(agentProvider.value))
    let rawResponse: AgentResponse
    if (usingModel) {
      const provider = agentProvider.value!
      const streaming = provider.fields['流式输出'] !== 'false'
      modelActivityId = addAgentActivity('调用模型生成回复', `${provider.title} · ${provider.fields['模型']} · ${streaming ? '流式接收' : '等待完整回复'}`, 'running', 'model')
      agentLiveResponse.value = { message: '', receivedChars: 0, streaming: true }
      let rawText = ''
      try {
        rawResponse = await requestAgentResponse(prompt, requestMode, {
          signal: controller.signal,
          onDelta: (delta) => {
            if (requestEpoch !== agentRunEpoch || controller.signal.aborted) return
            rawText += delta
            agentLiveResponse.value = {
              message: extractAgentMessagePreview(rawText),
              receivedChars: rawText.length,
              streaming: true,
            }
            const detail = `正在接收模型回复 · 已接收 ${rawText.length} 字符`
            updateAgentTask('plan', { detail })
            updateAgentActivity(modelActivityId, { detail, kind: 'stream' })
          },
        })
        if (requestEpoch !== agentRunEpoch) return
        updateAgentActivity(modelActivityId, { state: 'done', title: '模型回复已接收并校验', detail: streaming ? `已接收 ${rawText.length} 字符；操作协议校验通过。` : '已接收完整回复；操作协议校验通过。', kind: 'result' })
        agentLiveResponse.value = null
      } catch (error) {
        if (requestEpoch !== agentRunEpoch) return
        controller.signal.throwIfAborted()
        agentLiveResponse.value = null
        updateAgentActivity(modelActivityId, { state: 'error', detail: error instanceof Error ? error.message : '模型请求失败', kind: 'error' })
        const fallback = parseLocalAgentPrompt(prompt, activeGroupPage.value ?? undefined)
        if (!fallback.operations.some((operation) => operation.action === 'search_web_memes')) throw error
        rawResponse = fallback
        updateAgentActivity(planActivityId, { detail: '模型暂不可用，切换本地搜索意图识别。', kind: 'status' })
        addAgentActivity('已切换本地解析器', '模型 API 暂不可用，继续识别网络搜索意图。', 'done', 'status')
        agentMessages.value.push({ id: `agent-fallback-${Date.now()}`, role: 'system', content: '模型 API 暂不可用，已使用本地搜索意图识别继续执行网络检索。', createdAt: Date.now() })
      }
    } else {
      rawResponse = parseLocalAgentPrompt(prompt, activeGroupPage.value ?? undefined)
    }
    if (requestEpoch !== agentRunEpoch) return
    const validation = validateAgentResponse(
      rawResponse,
      new Set(store.value.volumes.map((volume) => volume.id)),
      store.value.customModules?.schemas ?? [],
    )
    if (!validation.ok) throw new Error(`Agent 计划校验失败：${validation.error}`)
    const parsed = validation.value
    if (requestEpoch !== agentRunEpoch) return
    updateAgentTask('plan', { state: 'done', detail: `${usingModel ? '模型' : '本地解析器'}生成 ${parsed.operations.length} 个操作` })
    updateAgentActivity(planActivityId, { state: 'done', detail: `${usingModel ? '模型' : '本地解析器'}生成 ${parsed.operations.length} 个操作。`, kind: 'result' })
    if (!parsed.operations.length) {
      updateAgentTask('execute', { state: 'done', detail: '未修改作品资料' })
      updateAgentTask('report', { state: 'running' })
      updateAgentTask('report', { state: 'done', detail: '结果已返回到对话框' })
      addAgentActivity('已返回分析结果', '本次请求没有需要写入作品的操作。', 'done', 'result')
      addAgentResultMessage(parsed.message)
      return
    }
    if (requestFingerprint !== agentPlanFingerprint()) {
      throw new Error('生成计划期间作品资料或当前章节发生了变化，请重新发送请求。')
    }
    const plan: AgentPlan = {
      id: `agent-plan-${Date.now()}`,
      message: parsed.message,
      operations: parsed.operations,
      descriptions: parsed.operations.map((operation, index) => describeAgentOperation(operation, parsed.operations.slice(0, index))),
      createdAt: Date.now(),
      storeFingerprint: requestFingerprint,
    }
    agentPendingPlan.value = plan
    updateAgentTask('execute', { state: 'queued', detail: '等待你确认后写入作品' })
    updateAgentTask('report', { state: 'queued', detail: '等待确认' })
    addAgentActivity('等待确认修改', `已生成 ${parsed.operations.length} 项操作，确认后才会写入作品。`, 'done', 'result')
    addAgentResultMessage(`${parsed.message}

我已经生成修改计划，请在下方确认后执行。`)
  } catch (error) {
    if (requestEpoch !== agentRunEpoch) return
    agentLiveResponse.value = null
    const message = error instanceof Error ? error.message : 'Agent 执行失败'
    const runningTask = agentTasks.value.find((task) => task.state === 'running')
    if (runningTask) {
      runningTask.state = 'error'
      runningTask.detail = message
    } else {
      updateAgentTask('execute', { state: 'error', detail: message })
    }
    for (const task of agentTasks.value) {
      if (task.state === 'queued') {
        task.state = 'done'
        task.detail = '未执行（前置步骤失败）'
      }
    }
    updateAgentTask('report', { state: 'done', detail: '已返回错误信息' })
    updateAgentActivity(readActivityId, { state: 'done' })
    if (planActivityId) updateAgentActivity(planActivityId, { state: 'error', detail: message, kind: 'error' })
    finishAgentActivities('error', message)
    addAgentActivity('Agent 执行失败', message, 'error', 'error')
    addAgentResultMessage(`执行失败：${message}`, 'system')
  } finally {
    if (requestEpoch === agentRunEpoch) {
      agentBusy.value = false
      agentLiveResponse.value = null
      agentAbortController = undefined
    }
  }
}

const agentDraft = ref('')
const agentContextScope = computed(() => `${currentProjectId.value}:${activeAgentConversationId.value}`)
const {
  budget: agentContextBudget,
  usage: agentContextUsage,
  status: agentContextStatus,
  budgetLabel: agentContextBudgetLabel,
  error: agentContextBudgetError,
} = useContextMetrics({
  provider: agentProvider,
  scopeKey: agentContextScope,
  purposes: ['agent'],
  messages: () => buildAgentRequest(agentDraft.value.trim() || '（待输入本次需求）', agentMode.value).messages,
})
const writerContextScope = computed(() => `${currentProjectId.value}:${activeChapter.value?.id ?? ''}`)
const {
  budget: writerContextBudget,
  usage: writerContextUsage,
  status: writerContextStatus,
  budgetLabel: writerContextBudgetLabel,
  error: writerContextBudgetError,
} = useContextMetrics({
  provider: writerProvider,
  scopeKey: writerContextScope,
  purposes: ['writing', 'paragraph'],
  messages: () => activeChapter.value ? buildWritingMessages(activeChapter.value) : null,
})

const latestChatMetrics = ref<ChatMetrics | null>(null)
const {
  busy: modelLimitsBusy,
  message: modelLimitsMessage,
  error: modelLimitsError,
  fetchLimits: fetchModelLimits,
} = useModelLimits({ provider: selectedProvider, localApiUrl, persist })
const activityRequestIds = new Set<number>()
let activityMetricsWatermark = currentChatMetricsId()
const removeChatMetricsListener = subscribeChatMetrics((metrics) => {
  if (metrics.requestId <= activityMetricsWatermark) return
  if (metrics.status === 'running') activityRequestIds.add(metrics.requestId)
  else if (!activityRequestIds.delete(metrics.requestId)) return
  if (!latestChatMetrics.value || metrics.requestId >= latestChatMetrics.value.requestId) latestChatMetrics.value = metrics
})
watch(currentProjectId, () => {
  activityMetricsWatermark = currentChatMetricsId()
  latestChatMetrics.value = null
  activityRequestIds.clear()
}, { flush: 'sync' })
onBeforeUnmount(removeChatMetricsListener)

</script>

<template>
<div class="app-shell" :class="{ 'focus-mode': focusMode, 'desktop-shell': isDesktopRuntime }" @click="editorToolsOpen = false" @dragover.capture="allowInternalResourceDragOver">
    <div v-if="remotePersistenceError && desktopStorageHydrated" class="storage-warning" role="status">
      <span>{{ remotePersistenceError }}</span>
      <button v-if="isDesktopRuntime && saveState === '保存冲突'" class="storage-warning-action" type="button" @click="reloadDesktopStorage">重新加载本机版本</button>
    </div>
    <div v-if="qyFileError" class="storage-warning qy-file-warning" role="alert">
      <span>{{ qyFileError }}</span>
      <button class="storage-warning-action" type="button" @click="qyFileError = ''">关闭</button>
    </div>
    <DesktopTitleBar v-if="isDesktopRuntime" :title="pageTitle" :save-state="saveState" :settings-open="settingsOpen" :theme-mode="themeSettings.mode" :file-path="currentQyPath" :recent-files="recentQyFiles" :file-busy="qyFileBusy" @settings="settingsOpen = true" @toggle-theme="toggleThemeMode" @new-file="createNewQyFile" @open-file="openQyFile" @save-file="saveQyFile()" @save-as-file="saveQyFile(true)" @open-recent-file="openRecentQyFile" @remove-recent-file="removeRecentQyFile" />
    <AiActivityStrip
      v-if="isDesktopRuntime"
      :writing-busy="isGenerating || paragraphEdit?.status === 'waiting'"
      :writer-state="writerActivityState"
      :writer-detail="writerActivityDetail"
      :agent-busy="agentBusy"
      :agent-pending-confirmation="Boolean(agentPendingPlan)"
      :world-engine-busy="worldEngineBusy"
      :search-busy="memeSearchBusy"
      :agent-tasks="agentTasks"
      :budget="latestChatMetrics?.budget"
      :usage="latestChatMetrics?.usage"
      :metrics-status="latestChatMetrics?.status"
      context-budget-label="本次请求上下文预算"
    />
    <SidebarNav :items="navItems" :active-page="activePage" :project-menu-open="projectMenuOpen" :current-work-title="currentWorkTitle" :current-project-id="currentProjectId" :projects="projects" @navigate="setPage($event as PageKey)" @toggle-project-menu="toggleProjectMenu" @new-project="createNewProject" @select-project="switchProject" @rename-project="requestRenameProject" @delete-project="requestDeleteProject" />

    <main class="main-area">
      <TopBar v-if="!isDesktopRuntime" :title="pageTitle" :save-state="saveState" :settings-open="settingsOpen" :theme-mode="themeSettings.mode" @settings="settingsOpen = true" @toggle-theme="toggleThemeMode" />
      <AiActivityStrip
        v-if="!isDesktopRuntime"
        :writing-busy="isGenerating || paragraphEdit?.status === 'waiting'"
        :writer-state="writerActivityState"
        :writer-detail="writerActivityDetail"
        :agent-busy="agentBusy"
        :agent-pending-confirmation="Boolean(agentPendingPlan)"
        :world-engine-busy="worldEngineBusy"
        :search-busy="memeSearchBusy"
        :agent-tasks="agentTasks"
      />

      <section v-if="activePage === 'writer'" class="writer-layout">
        <aside class="chapter-rail">
          <div class="chapter-rail-head"><span>章节目录</span><button class="icon-button" type="button" title="跳转到末尾章节" aria-label="跳转到末尾章节" @click="jumpToLastChapter"><ArrowDown :size="15" /></button></div>
          <label class="chapter-search"><Search :size="14" /><input v-model="chapterSearch" type="search" placeholder="搜索章节" aria-label="搜索章节" /><button v-if="chapterSearch" class="chapter-search-clear" type="button" title="清空搜索" aria-label="清空搜索" @click="chapterSearch = ''"><X :size="13" /></button></label>
          <div class="chapter-list">
            <section v-for="volume in visibleVolumes" :key="volume.id" class="chapter-volume">
              <div class="volume-heading">
                <button class="volume-toggle" type="button" :title="volume.collapsed ? '展开分卷' : '折叠分卷'" :aria-label="volume.collapsed ? '展开分卷' : '折叠分卷'" @click="toggleVolume(volume)"><ChevronDown :size="14" :class="{ 'volume-chevron-collapsed': volume.collapsed }" /></button>
                <input class="volume-title-input" :value="volume.title" placeholder="输入分卷名称" aria-label="分卷名称" @input="updateVolumeTitle(volume, ($event.target as HTMLInputElement).value)" />
                <small>{{ chapterCountByVolume[volume.id] ?? 0 }}</small>
              </div>
              <div v-if="!volume.collapsed || normalizedChapterSearch" class="volume-chapters">
                <button v-for="chapter in chaptersForVolume(volume.id)" :key="chapter.id" :class="['chapter-item', { active: chapter.id === selectedChapterId }]" type="button" @click="selectChapter(chapter.id)">
                  <span>{{ chapter.title }}</span><small>{{ chapter.status }}<template v-if="chapter.wordCount"> · {{ chapter.wordCount }} 字</template></small>
                </button>
              </div>
            </section>
            <p v-if="!filteredChapters.length" class="chapter-empty">没有匹配的章节</p>
          </div>
          <div class="chapter-actions"><button class="button secondary" type="button" @click="createChapter"><Plus :size="14" />新建章节</button><button class="button secondary" type="button" @click="createVolume"><FolderPlus :size="14" />新建卷</button></div>
        </aside>
        <article class="editor-pane">
          <div class="editor-head"><div><span class="eyebrow"><template v-if="volumeForChapter(activeChapter)?.title">{{ volumeForChapter(activeChapter)?.title }} / </template>{{ activeChapter.status }}</span><input class="chapter-title-editor" :value="chapterDisplayTitle(activeChapter)" placeholder="输入章节标题" aria-label="章节标题" @input="updateChapterTitle(($event.target as HTMLInputElement).value)" /></div><div class="editor-actions"><button class="button secondary" type="button" @click="focusMode = !focusMode"><PanelRight :size="15" />{{ focusMode ? '退出专注' : '专注写作' }}</button><button class="button secondary" type="button" @click="persist()"><Save :size="15" />保存</button></div></div>
          <div class="editor-toolbar"><span class="tool-label">正文编辑区</span><span class="toolbar-hint">选段后可续写、改写或润色</span><div class="editor-overflow" @click.stop @keydown.esc.stop.prevent="editorToolsOpen = false"><button class="icon-button" :class="{ active: editorToolsOpen }" type="button" title="正文工具" aria-label="正文工具" aria-haspopup="true" :aria-expanded="editorToolsOpen" @click="toggleEditorTools"><MoreHorizontal :size="16" /></button><div v-if="editorToolsOpen" class="editor-tool-menu" role="group" aria-label="正文工具"><label class="editor-format-setting"><span>首行缩进</span><select v-model.number="formatIndentSpaces" aria-label="首行缩进空格数"><option :value="0">不缩进</option><option :value="1">1 个全角空格</option><option :value="2">2 个全角空格</option><option :value="4">4 个全角空格</option></select></label><button class="editor-menu-action" type="button" :disabled="!activeChapter.content.trim()" @click="formatChapterContent"><AlignLeft :size="15" />应用自动排版</button><button class="editor-menu-action" type="button" :disabled="!activeChapter.content.trim()" @click="copyChapterAsPlainText"><Check v-if="copyFeedback === 'copied'" :size="15" /><Clipboard v-else :size="15" />{{ copyFeedback === 'copied' ? '已复制纯文本' : '复制全章纯文本' }}</button><p v-if="copyFeedback === 'error'" class="editor-menu-feedback error">复制失败，请检查剪贴板权限。</p><p v-else-if="copyFeedback === 'copied'" class="editor-menu-feedback">Markdown 标记已移除，段落与链接文字已保留。</p><div class="editor-menu-divider"></div><button class="editor-menu-action danger" type="button" @click="requestDeleteChapter"><Trash2 :size="15" />删除当前章节</button></div></div></div>
          <ParagraphEditor :model-value="activeChapter.content" :edit-state="paragraphEdit" :disabled="isGenerating" @update:model-value="updateChapterContent" @open-edit="openParagraphEdit" @close-edit="closeParagraphEdit" @update-instruction="updateParagraphInstruction" @request-edit="requestParagraphEdit" @apply-edit="applyParagraphEdit" />
          <div class="editor-footer"><span>{{ activeChapter.wordCount }} 字 · 自动保存</span><span>Markdown 兼容</span></div>
          <div v-if="candidate || isGenerating" class="candidate-box" :aria-busy="isGenerating">
            <div class="candidate-head"><div><span class="eyebrow">候选正文</span><strong>{{ isGenerating ? '正在生成' : canAcceptCandidate ? '生成完成 · 待采纳' : writerState === 'done' ? '候选已失效 · 不可采纳' : '生成中断 · 不可采纳' }}</strong></div><button class="icon-button" type="button" :title="isGenerating ? '停止生成并丢弃候选' : '丢弃候选'" @click="discardCandidate"><X :size="16" /></button></div>
            <p v-if="candidate">{{ candidate }}<span v-if="isGenerating" class="agent-typing-cursor" aria-hidden="true"></span></p>
            <p v-else class="candidate-wait"><LoaderCircle class="spin" :size="14" />等待模型回复…</p>
            <div class="candidate-actions"><button class="button secondary" type="button" @click="discardCandidate">{{ isGenerating ? '停止生成' : '丢弃' }}</button><button class="button primary" type="button" :disabled="!canAcceptCandidate" @click="acceptCandidate"><Check :size="15" />采纳候选</button></div>
          </div>
        </article>
        <aside class="assistant-pane">
          <div class="assistant-tabs"><button v-for="tab in [{ key: 'task', label: '本章任务' }, { key: 'context', label: '本次资料' }, { key: 'checks', label: '检查建议' }]" :key="tab.key" :class="{ selected: assistantTab === tab.key }" type="button" @click="assistantTab = tab.key as typeof assistantTab">{{ tab.label }}</button></div>
          <div v-if="assistantTab === 'task'" class="assistant-content writer-task-content">
            <h2>本章任务</h2>
            <label class="form-field task-goal-field"><span>剧情目标</span><textarea :value="activeChapter.taskGoal ?? ''" rows="3" placeholder="输入本章要推进的剧情目标" @input="updateChapterTaskGoal(($event.target as HTMLTextAreaElement).value)" /></label>
            <div class="form-field"><span>出场人物</span><div class="cast-tag-editor"><span v-for="name in activeChapter.cast ?? []" :key="name" class="cast-tag"><span>{{ name }}</span><button type="button" :title="`移除 ${name}`" :aria-label="`移除 ${name}`" @click="removeChapterCast(name)"><X :size="12" /></button></span><input v-model="castDraft" type="text" placeholder="输入人物，按空格添加" @keydown="commitChapterCast" @blur="addChapterCast(castDraft)" /></div><div v-if="!(activeChapter.cast?.length) && inferredCast.length" class="cast-inferred"><span>从本章内容识别</span><span v-for="name in inferredCast" :key="name" class="cast-inferred-tag">{{ name }}</span></div><small>留空时根据剧情目标和正文识别角色，并检索相关角色资料。</small></div>
            <label class="form-field writer-api-select"><span>正文生成 API</span><select :value="writerProviderSelectionId" aria-label="选择正文生成 API" @change="selectWriterProvider(($event.target as HTMLSelectElement).value)"><option v-if="!store.providers.length" value="">未配置 API</option><option v-for="provider in store.providers" :key="provider.id" :value="provider.id">{{ provider.title }}{{ provider.fields['模型'] ? ` · ${provider.fields['模型']}` : '' }}</option></select></label>
            <ContextUsageIndicator :budget="writerContextBudget" :usage="writerContextUsage" :status="writerContextStatus" :budget-label="writerContextBudgetLabel" label="正文上下文" />
            <p v-if="writerContextBudgetError" class="generation-error" role="status">{{ writerContextBudgetError }}</p>
            <div v-if="generationError" class="generation-error" role="alert">{{ generationError }}</div>
            <button class="button primary full generate-chapter-button" type="button" :disabled="isGenerating || paragraphEdit !== null || !store.providers.length" @click="generateCandidate"><LoaderCircle v-if="isGenerating" class="spin" :size="15" /><Sparkles v-else :size="15" />{{ isGenerating ? '正在生成…' : '生成正文' }}</button>
          </div>
          <div v-else-if="assistantTab === 'context'" class="assistant-content"><h2>本次使用的资料</h2><div v-if="retrievedContextPreview.length"><div v-for="match in retrievedContextPreview" :key="`${match.collection}-${match.resource.id}`" class="evidence"><strong>{{ match.resource.title }} <span class="tag">{{ match.matchType === 'direct' ? '直接命中' : `递归 ${match.depth} 层` }}</span></strong><span>{{ match.collection }} · 注入顺序 {{ match.resource.injectionOrder ?? 100 }} · {{ match.matchedKeys.join('、') }}</span></div></div><div v-else class="helper">当前章节没有命中世界书或卡片资料。</div><div class="warning-note"><LockKeyhole :size="15" />世界引擎状态会作为独立的已确认上下文注入；世界书和卡片仍按常驻、关键词、递归规则检索。</div><span class="helper">命中 {{ retrievedContextPreview.length }} 条卡片资料 · 资料块估算 {{ contextTokens.toLocaleString() }} tokens</span></div>
          <div v-else class="assistant-content"><h2>审阅与确认</h2><div class="check-row"><Check :size="15" /><span>设定冲突与道具归属</span><em>待生成后检查</em></div><div class="check-row"><Check :size="15" /><span>角色知情边界</span><em>待生成后检查</em></div><div class="check-row"><Check :size="15" /><span>文风正反例</span><em>按需审阅</em></div><div class="warning-note"><LockKeyhole :size="15" />确认状态变化后，下一章才使用新资料。</div></div>
        </aside>
      </section>

      <section v-else-if="activePage === 'context'" class="page-view context-view">
        <div class="page-header"><div><span class="eyebrow">Prompt Manager 风格</span><h1>上下文编排</h1><p>拖动提示块的顺序，决定资料进入模型的结构。每次生成都会固化一份快照。</p></div><div class="header-stat"><span>资料块估算</span><strong>{{ contextTokens.toLocaleString() }} tokens</strong></div></div>
         <div class="context-grid"><ContextOrchestrationPanel :blocks="contextLayout" @update-blocks="updateContextLayout" /><aside class="context-inspector"><div class="inspector-icon"><SlidersHorizontal :size="18" /></div><h2>本章上下文</h2><p>先排列世界书、角色、道具、技能、自定义模块等大块，再排列块内条目；启用的内容会按这个层级注入模型。</p><div class="summary-line"><span>已启用块</span><strong>{{ contextLayout.filter((item) => item.enabled).length }} / {{ contextLayout.length }}</strong></div><div class="summary-line"><span>资料来源</span><strong>世界书 + 卡片 + 自定义模块 + 大纲</strong></div><div class="summary-line"><span>版本</span><strong>两级提示词布局</strong></div><div class="warning-note"><Cloud :size="15" />拖动后的顺序会持久化，并用于正文和 Agent 请求。</div></aside></div>
      </section>

      <section v-else-if="activePage === 'agent'" class="page-view agent-page">
        <AgentPanel
          :messages="agentMessages"
          :conversations="agentConversationList"
          :active-conversation-id="activeAgentConversationId"
          :can-switch-conversation="canSwitchAgentConversation"
          :tasks="agentTasks"
          :activities="agentActivities"
          :live-response="agentLiveResponse"
          :quick-actions="agentQuickActions"
          :busy="agentBusy"
          :model-label="agentModelLabel"
          :mode="agentMode"
          :providers="store.providers"
          :selected-provider-id="agentProviderSelectionId"
          :budget="agentContextBudget"
          :usage="agentContextUsage"
          :metrics-status="agentContextStatus"
          :context-budget-label="agentContextBudgetLabel"
          :context-budget-error="agentContextBudgetError"
          :pending-plan="agentPendingPlan"
          :history="agentHistory"
          :undoable-history-id="latestUndoableHistoryId"
          standalone
          @send="runAgentPrompt"
          @draft-changed="agentDraft = $event"
          @quick="runAgentPrompt"
          @approve-plan="approveAgentPlan"
          @reject-plan="rejectAgentPlan"
          @undo-history="undoAgentHistory"
          @reset-tasks="resetAgentTasks"
          @select-provider="selectAgentProvider"
          @select-mode="selectAgentMode"
          @new-conversation="createNewAgentConversation"
          @select-conversation="selectAgentConversation"
          @rename-conversation="renameAgentConversation"
          @archive-conversation="archiveAgentConversation"
          @delete-conversation="deleteAgentConversation"
          @close="closeAgentSurface"
        />
      </section>

      <CustomModulesPanel
        v-else-if="activePage === 'custom'"
        :modules="customModulePanelData"
        :selected-module-id="customSelectedModuleId"
        :characters="store.characters.map(({ id, title }) => ({ id, title }))"
        :items="store.items.map(({ id, title }) => ({ id, title }))"
        :skills="store.skills.map(({ id, title }) => ({ id, title }))"
        @select-module="selectCustomModule"
        @create-module="createCustomModule"
        @rename-module="renameCustomModule"
        @update-module="updateCustomModule"
        @delete-module="deleteCustomModule"
        @create-entry="createCustomEntry"
        @update-entry="updateCustomEntry"
        @delete-entry="deleteCustomEntry"
        @open-reference="openCustomModuleReference"
      />

      <InternetMemesPanel
        v-else-if="activePage === 'memes'"
        :memes="memePanelEntries"
        :candidates="memeCandidates"
        :busy="memeSearchBusy"
        @create="createMemeEntry"
        @update="updateMemeEntry"
        @delete="deleteMemeEntry"
        @toggle="toggleMemeEntry"
        @accept-candidate="acceptMemeCandidate"
        @dismiss-candidate="dismissMemeCandidate"
        @search-web="searchWebMemes"
      />
      <JsonStructureViewer v-else-if="activePage === 'json'" :entries="jsonStructures" />

      <section v-else-if="activePage === 'worldEngine'" class="page-view world-engine-view">
        <WorldEnginePanel
          :world-engine="worldEngine"
          :outline="store.outline"
          :chapters="store.chapters"
          :world="store.world"
          :characters="store.characters"
          :items="store.items"
          :skills="store.skills"
          :active-chapter="activeChapter"
          :providers="store.providers"
          :selected-provider-id="worldEngineProviderSelectionId"
          :busy="worldEngineBusy"
          @run-simulation="runWorldEngine"
          @save="persist"
          @update-time-span="updateWorldEngineTimeSpan"
          @add-event="addWorldEngineEvent"
          @select-provider="selectWorldEngineProvider"
          @approve-proposal="approveWorldEngineProposal"
          @reject-proposal="rejectWorldEngineProposal"
          @update-event-review-status="updateWorldEngineEventReviewStatus"
          @toggle-event-review-status-lock="toggleWorldEngineEventReviewStatusLock"
          @toggle-event-lock-all="toggleWorldEngineEventLockAll"
        />
        <p v-if="worldEngineError" class="generation-error world-engine-error" role="alert">{{ worldEngineError }}</p>
      </section>

      <ApiManagementPanel
        v-else-if="activePage === 'api'"
        :resources="activeCollection"
        :selected-resource="selectedResource"
        :protocol-options="protocolOptions"
        :provider-test="providerTest"
        :is-configured="isApiConfigured"
        :status-label="apiStatusLabel"
        :model-options="apiModels"
        @add="addResource"
        @select="selectResource"
        @remove="removeResource"
        @test="testProvider"
        @fetch="fetchModels"
        @update-title="updateSelectedProviderTitle"
        @update-summary="updateSelectedProviderSummary"
        @update-field="updateProviderField"
      />

      <ResourceCollectionView
           v-if="currentConfig && activePage !== 'api' && activePage !== 'worldEngine'"
          :title="currentConfig.title"
          :intro="currentConfig.intro"
          :active-page="activePage"
          :active-collection="activeCollection"
          :selected-resource="selectedResource"
          :role-options="roleOptions"
          :resource-create-label="resourceCreateLabel(activePage)"
          :active-group-page="activeGroupPage"
          :active-groups="activeGroups"
          :resource-group-sections="resourceGroupSections"
          :drop-target-group-id="dropTargetGroupId"
          :outline-roots="outlineRoots"
          :outline-child-map="outlineChildMap"
          :outline-chapters="store.chapters"
          :outline-volumes="store.volumes"
          @add-resource="addResource"
          @open-resource-group-dialog="openResourceGroupDialog"
          @rename-resource-group="renameResourceGroup"
          @move-resource-group-to-top="moveResourceGroupToTop"
          @move-resource-group-to-bottom="moveResourceGroupToBottom"
          @delete-resource-group="deleteResourceGroup"
          @set-all-resource-groups-collapsed="setAllResourceGroupsCollapsed"
          @select-resource="selectResource"
          @toggle-resource-group="toggleResourceGroup"
          @start-resource-drag="startResourceDrag"
          @end-resource-drag="endResourceDrag"
          @drag-over-resource-group="dragOverResourceGroup"
          @drop-resource-into-group="dropResourceIntoGroup"
           @drop-resource-on-resource="dropResourceOnResource"
          @start-resource-group-drag="startResourceGroupDrag"
          @end-resource-group-drag="endResourceGroupDrag"
          @remove-resource="removeResource"
          @update-title="updateResourceTitle"
          @update-summary="updateResourceSummary"
          @update-field="updateField"
          :creation-prompt-hints="standardCreationPromptHints[({ world: 'world', characters: 'character', items: 'item', skills: 'skill' } as Record<string, StandardResourceType>)[activePage] ?? 'world']"
          @update-creation-prompt-hint="updateCreationPromptHint"
          @update-character-field="updateCharacterField"
          @update-character-images="updateCharacterImages"
          @update-resource-meta="updateResourceMeta"
          @toggle-resource-lock="toggleResourceLock"
          @toggle-review-status="toggleSelectedResourceReviewStatus"
          @toggle-review-status-lock="toggleSelectedResourceReviewStatusLock"
          @toggle-resource-lock-all="toggleSelectedResourceAllLock"
          @toggle-resource-enabled="toggleResourceEnabled"
          @toggle-outline-collapse="toggleOutlineCollapse"
          @update-outline-structure="updateOutlineStructure"
        >
       <section v-if="activePage === 'characters' && selectedResource" class="character-holdings">
         <div class="page-header holdings-header"><div><span class="eyebrow">角色关联</span><h2>{{ selectedResource.title }}的背包与技能</h2><p>背包读取道具卡，技能读取技能卡；点击标签可查看完整详情。</p></div></div>
         <div class="holdings-grid">
           <article class="holding-card"><div class="holding-card-head"><div><span class="eyebrow">道具卡关联</span><h3>背包 <button class="field-lock-button" type="button" :class="{ locked: isResourceFieldLocked(selectedResource, 'holdingItems') }" :title="isResourceFieldLocked(selectedResource, 'holdingItems') ? '已锁定，Agent 不可修改' : '锁定持有道具，禁止 Agent 修改'" @click="toggleResourceLock('holdingItems')"><LockKeyhole :size="13" /></button></h3></div><button class="icon-button" type="button" title="添加背包道具" aria-label="添加背包道具" @click="openHoldingPicker('items')"><Plus :size="16" /></button></div><div class="holding-tags"><button v-for="id in characterHoldingIds(selectedResource, 'items')" :key="id" class="holding-tag" type="button" @click="openCardDetail('items', id)"><KeyRound :size="14" />{{ holdingTitle('items', id) }}</button><span v-if="!characterHoldingIds(selectedResource, 'items').length" class="holding-empty">暂无道具</span></div></article>
           <article class="holding-card"><div class="holding-card-head"><div><span class="eyebrow">技能卡关联</span><h3>技能 <button class="field-lock-button" type="button" :class="{ locked: isResourceFieldLocked(selectedResource, 'holdingSkills') }" :title="isResourceFieldLocked(selectedResource, 'holdingSkills') ? '已锁定，Agent 不可修改' : '锁定持有技能，禁止 Agent 修改'" @click="toggleResourceLock('holdingSkills')"><LockKeyhole :size="13" /></button></h3></div><button class="icon-button" type="button" title="添加技能" aria-label="添加技能" @click="openHoldingPicker('skills')"><Plus :size="16" /></button></div><div class="holding-tags"><button v-for="id in characterHoldingIds(selectedResource, 'skills')" :key="id" class="holding-tag skill-tag" type="button" @click="openCardDetail('skills', id)"><Sparkles :size="14" />{{ holdingTitle('skills', id) }}</button><span v-if="!characterHoldingIds(selectedResource, 'skills').length" class="holding-empty">暂无技能</span></div></article>
         </div>
       </section>
      </ResourceCollectionView>
    </main>

    <button
      v-if="activePage !== 'agent'"
      class="agent-fab"
      :class="{ dragging: agentDragging }"
      :style="agentFabStyle"
      type="button"
      title="拖动 Agent 或点击打开"
      aria-label="拖动 Agent 或点击打开"
      @pointerdown="startAgentDrag"
      @click="toggleAgentSurface"
    >
      <QyLogo class="agent-fab-logo" :size="27" tone="buttonText" label="AI Agent" />
    </button>

    <div v-if="agentOpen && activePage !== 'agent'" class="agent-drawer-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('agent', $event)"></div>
    <div v-if="agentOpen && activePage !== 'agent'" class="agent-drawer" :style="agentDrawerStyle">
      <AgentPanel
        :messages="agentMessages"
        :conversations="agentConversationList"
        :active-conversation-id="activeAgentConversationId"
        :can-switch-conversation="canSwitchAgentConversation"
        :tasks="agentTasks"
        :activities="agentActivities"
        :live-response="agentLiveResponse"
        :quick-actions="agentQuickActions"
        :busy="agentBusy"
        :model-label="agentModelLabel"
        :mode="agentMode"
        :providers="store.providers"
        :selected-provider-id="agentProviderSelectionId"
        :budget="agentContextBudget"
        :usage="agentContextUsage"
        :metrics-status="agentContextStatus"
        :context-budget-label="agentContextBudgetLabel"
        :context-budget-error="agentContextBudgetError"
        :pending-plan="agentPendingPlan"
        :history="agentHistory"
        :undoable-history-id="latestUndoableHistoryId"
        @send="runAgentPrompt"
        @draft-changed="agentDraft = $event"
        @quick="runAgentPrompt"
        @approve-plan="approveAgentPlan"
        @reject-plan="rejectAgentPlan"
        @undo-history="undoAgentHistory"
        @reset-tasks="resetAgentTasks"
        @select-provider="selectAgentProvider"
        @select-mode="selectAgentMode"
        @new-conversation="createNewAgentConversation"
        @select-conversation="selectAgentConversation"
        @rename-conversation="renameAgentConversation"
        @archive-conversation="archiveAgentConversation"
        @delete-conversation="deleteAgentConversation"
        @close="closeAgentSurface"
      />
    </div>

    <div v-if="holdingPicker" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('holdingPicker', $event)">
      <section class="card-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title"><header class="card-modal-head"><div><span class="eyebrow">角色关联</span><h2 id="picker-title">添加{{ holdingPicker.type === 'skills' ? '技能' : '道具' }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="holdingPicker = null"><X :size="18" /></button></header><p class="card-modal-intro">点击卡片即可添加或移除，已关联的卡片会显示勾选状态。</p><div class="card-picker-list"><button v-for="item in holdingPickerResources" :key="item.id" :class="['card-picker-item', { selected: isHolding(store.characters.find((character) => character.id === holdingPicker?.characterId)!, holdingPicker.type, item.id) }]" type="button" @click="toggleHolding(holdingPicker.type, item.id)"><span><strong>{{ item.title }}</strong><small>{{ item.summary }}</small></span><Check v-if="isHolding(store.characters.find((character) => character.id === holdingPicker?.characterId)!, holdingPicker.type, item.id)" :size="16" /></button></div></section>
    </div>

    <div v-if="cardDetail && cardDetailResource" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('cardDetail', $event)">
      <article class="card-detail-modal" role="dialog" aria-modal="true" aria-labelledby="card-detail-title"><header class="card-modal-head"><div><span class="eyebrow">{{ cardDetail.type === 'skills' ? '技能卡' : '道具卡' }}</span><h2 id="card-detail-title">{{ cardDetailResource.title }}</h2></div><button class="icon-button" type="button" title="关闭详情" aria-label="关闭详情" @click="cardDetail = null"><X :size="18" /></button></header><p class="card-detail-summary">{{ cardDetailResource.summary }}</p><dl class="card-detail-fields"><template v-for="(value, key) in cardDetailResource.fields" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl></article>
    </div>

    <div v-if="chapterDeleteOpen" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('chapterDelete', $event)">
      <article class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-chapter-title"><header class="card-modal-head"><div><span class="eyebrow">章节管理</span><h2 id="delete-chapter-title">删除当前章节？</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="cancelDeleteChapter"><X :size="18" /></button></header><p class="card-modal-intro">将删除“{{ activeChapter.title }}”及其正文、任务和出场人物。此操作无法撤销。若这是最后一章，会自动新建一个空白章节。</p><div class="confirm-actions"><button class="button secondary" type="button" @click="cancelDeleteChapter">取消</button><button class="button danger-button" type="button" @click="confirmDeleteChapter"><Trash2 :size="15" />确认删除</button></div></article>
    </div>

    <div v-if="projectDeleteOpen" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('projectDelete', $event)">
      <article class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-title"><header class="card-modal-head"><div><span class="eyebrow">作品管理</span><h2 id="delete-project-title">删除当前作品？</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="cancelDeleteProject"><X :size="18" /></button></header><p class="card-modal-intro">将删除“{{ currentWorkTitle }}”的章节、世界书、角色卡、道具卡、技能卡和大纲等本地资料。API 设置不会被删除。</p><div class="confirm-actions"><button class="button secondary" type="button" @click="cancelDeleteProject">取消</button><button class="button danger-button" type="button" @click="confirmDeleteProject"><Trash2 :size="15" />确认删除</button></div></article>
    </div>

    <div v-if="projectRenameOpen" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('projectRename', $event)">
      <article class="confirm-modal rename-modal" role="dialog" aria-modal="true" aria-labelledby="rename-project-title"><header class="card-modal-head"><div><span class="eyebrow">作品管理</span><h2 id="rename-project-title">重命名作品</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="cancelRenameProject"><X :size="18" /></button></header><label class="form-field rename-field"><span>作品名称</span><input v-model="renameTitle" type="text" maxlength="60" autofocus @keyup.enter="confirmRenameProject" /></label><div class="confirm-actions"><button class="button secondary" type="button" @click="cancelRenameProject">取消</button><button class="button primary" type="button" :disabled="!renameTitle.trim()" @click="confirmRenameProject"><PenLine :size="15" />保存名称</button></div></article>
    </div>

    <div v-if="resourceGroupDialogOpen" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('resourceGroup', $event)">
      <article class="confirm-modal group-modal" role="dialog" aria-modal="true" aria-labelledby="resource-group-title"><header class="card-modal-head"><div><span class="eyebrow">{{ currentConfig?.title }}</span><h2 id="resource-group-title">{{ resourceGroupEditingId ? '重命名折叠栏' : '添加折叠栏' }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="cancelResourceGroupDialog"><X :size="18" /></button></header><label class="form-field rename-field"><span>折叠栏名称</span><input v-model="resourceGroupTitle" type="text" maxlength="40" placeholder="例如：主要角色、核心道具" autofocus @keyup.enter="createResourceGroup" /></label><div class="confirm-actions"><button class="button secondary" type="button" @click="cancelResourceGroupDialog">取消</button><button class="button primary" type="button" :disabled="!resourceGroupTitle.trim()" @click="createResourceGroup"><PenLine v-if="resourceGroupEditingId" :size="15" /><FolderPlus v-else :size="15" />{{ resourceGroupEditingId ? '保存名称' : '创建折叠栏' }}</button></div></article>
    </div>

    <SettingsPanel :open="settingsOpen" :desktop-runtime="isDesktopRuntime" :resources="store.providers" :selected-resource="selectedProvider" :model-options="store.modelOptions" :protocol-options="protocolOptions" :status-label="apiStatusLabel" :provider-test="providerTest" :api-error="apiError" :model-limits-busy="modelLimitsBusy" :model-limits-message="modelLimitsMessage" :model-limits-error="modelLimitsError" :history-limit="agentHistoryLimit" :auto-save-seconds="autoSaveSeconds" :qy-backup-count="qyBackupCount" :theme-settings="themeSettings" :archived-conversations="archivedAgentConversationList" @close="settingsOpen = false" @select="selectProvider" @add="addProvider" @remove="removeProvider" @save="saveProvider" @update-field="updateProviderField" @test="testProvider" @fetch="fetchModels" @fetch-model-limits="fetchModelLimits" @toggle-provider-default="toggleProviderDefault" @update-history-limit="updateAgentHistoryLimit" @update-auto-save="updateAutoSaveSeconds" @update-qy-backup-count="updateQyBackupCount" @update-theme-color="updateThemeColor" @reset-theme="resetThemeSettings" @restore-conversation="restoreArchivedAgentConversation" @delete-archived-conversation="deleteArchivedAgentConversation" />

    <div v-if="isDesktopRuntime && !desktopStorageHydrated" class="desktop-storage-gate" role="alertdialog" aria-modal="true" aria-labelledby="desktop-storage-title">
      <section>
        <LoaderCircle v-if="!desktopStorageError" class="spin" :size="22" />
        <h1 id="desktop-storage-title">{{ desktopStorageError ? '无法读取本机作品' : '正在读取本机作品' }}</h1>
        <p>{{ desktopStorageError || '读取完成前不会加载默认内容或写入作品文件。' }}</p>
        <button v-if="desktopStorageError" class="button primary" type="button" @click="retryDesktopStorage">重试连接</button>
      </section>
    </div>
    <div v-if="isDesktopRuntime && desktopStorageFlushing" class="desktop-storage-gate" role="status" aria-live="polite">
      <section>
        <LoaderCircle class="spin" :size="22" />
        <h1>正在保存作品</h1>
        <p>确认本机文件写入完成后，应用才会关闭。</p>
      </section>
    </div>
  </div>
</template>











