import type { MemeStore } from './data/memes'
import type { AgentOperation } from './agent/schema'

export type Resource = {
  id: string
  title: string
  tag: string
  summary: string
  fields: Record<string, string>
  /** Whether a matched entry may activate entries through its content/keywords. */
  allowRecursive?: boolean
  /** Whether entries activated recursively may continue activating more entries. */
  allowFurtherRecursive?: boolean
  /** Lower values are injected earlier; kept on every context-capable resource. */
  injectionOrder?: number
  /** Optional structured retrieval settings for newer resource editors. */
  retrieval?: ResourceRetrievalConfig
  /** Fields protected from AI Agent updates. Use `title`, `summary`, field names, `holdingItems`, or `holdingSkills`. */
  lockedFields?: string[]
  /** Records how this entry was first created; Agent updates do not change it. */
  creationSource?: 'agent' | 'manual'
  /** Author review state, independent from semantic tags such as character role. */
  reviewStatus?: 'pending' | 'complete'
  /** Prevents Agent operations from changing only the review state. */
  reviewStatusLocked?: boolean
  /** Previous review-state lock retained while the whole entry is locked. */
  reviewStatusLockedBeforeAll?: boolean
  /** Prevents Agent operations from changing any editable content on this entry. */
  lockedAll?: boolean
  holdingItems?: string[]
  holdingSkills?: string[]
  characterImages?: CharacterImage[]
  characterCoverImageId?: string
  groupId?: string
  /** API presets use this as the global default; style rules use it as enabled state. */
  enabled?: boolean
  /** Hierarchy metadata used by the nested story-outline editor. */
  outlineType?: OutlineNodeType
  outlineParentId?: string
  outlineStartChapterId?: string
  outlineEndChapterId?: string
  outlineCollapsed?: boolean
}

export type OutlineNodeType = 'book' | 'volume' | 'chapterRange' | 'scene'

/** Field primitives supported by an experimental custom module. */
export type CustomModuleFieldType = 'string' | 'text' | 'longText' | 'number' | 'enum' | 'boolean' | 'tags' | 'characterIndex' | 'itemIndex' | 'skillIndex'

export type CustomModuleFieldValue = string | number | boolean | string[]

/** A field definition is both the form description and the AI JSON contract. */
export type CustomModuleFieldDefinition = {
  /** Stable field identifier. It is also the key used in `data`. */
  id: string
  key: string
  /** Human-readable label shown in the editor. */
  label: string
  type: CustomModuleFieldType
  description?: string
  /** Additional author-written instruction shown beside the field and sent to AI. */
  promptHint?: string
  required?: boolean
  defaultValue?: CustomModuleFieldValue
  /** Only used by enum fields. */
  options?: string[]
  placeholder?: string
  /** Prevent Agent updates to this custom field. */
  locked?: boolean
}

/** A user-defined card/table schema, for example a "势力卡". */
export type CustomModuleSchema = {
  id: string
  /** Value written into the generated JSON `type` property. */
  type: string
  title: string
  description: string
  fields: CustomModuleFieldDefinition[]
  /** Field key used as a list title when present. */
  titleField?: string
  version: number
  createdAt: number
  updatedAt: number
  /** Prevents Agent from changing the module definition or its entries. */
  lockedAll?: boolean
}

/** A concrete row/card created from a custom module schema. */
export type CustomModuleEntry = {
  id: string
  schemaId: string
  title?: string
  data: Record<string, CustomModuleFieldValue>
  createdAt: number
  updatedAt: number
  /** Prevents Agent from changing this custom entry. */
  lockedAll?: boolean
  /** Optional field keys protected from Agent updates. */
  lockedFields?: string[]
}

/** Optional aggregate shape used by persistence/UI code when custom modules are enabled. */
export type CustomModuleStore = {
  schemas: CustomModuleSchema[]
  entries: CustomModuleEntry[]
}

export type CharacterImage = {
  id: string
  name: string
  dataUrl: string
  createdAt: number
  /**
   * Portable reference for the desktop attachment store.
   *
   * The renderer still keeps `dataUrl` while an image is being edited.  A
   * portfolio serializer may remove that inline payload and retain this
   * reference instead; keeping the field optional preserves old inline
   * snapshots and lets the migration happen at the file boundary.
   */
  attachment?: CharacterImageAttachmentRef
}

export type CharacterImageAttachmentRef = {
  /** Stable file name/key in the portfolio's attachment store. */
  assetId: string
  /** Original data URL media type, for example `image/jpeg`. */
  mimeType: string
  /** Number of decoded bytes in the sidecar payload. */
  byteLength: number
  /** Optional integrity hash supplied by a future attachment writer. */
  sha256?: string
}

/** How a context-capable resource is selected for a prompt. */
export type ResourceTriggerStrategy = 'always' | 'keywords'

export type ResourceRetrievalConfig = {
  enabled?: boolean
  /** `always` injects the entry whenever retrieval runs; `keywords` requires a key hit. */
  triggerStrategy?: ResourceTriggerStrategy
  allowRecursion?: boolean
  allowFurtherRecursion?: boolean
  injectionOrder?: number
  keys?: string[]
}

/**
 * The dynamic, story-level state maintained by the World Engine.
 *
 * Resources (world book entries, cards and outline nodes) remain the author's source
 * of truth. The engine stores observations and proposed changes separately so
 * a model can reason about the world without silently rewriting those cards.
 */
export type WorldEngineRunStatus = 'idle' | 'running' | 'awaiting-review' | 'error'

/**
 * The amount of narrative time a world-engine run is allowed to advance.
 *
 * Fictional calendars are intentionally represented as text. The engine can
 * therefore record that a chapter/day/month passed without pretending that it
 * can calculate dates for an arbitrary fictional calendar.
 */
export type WorldEngineTimeAdvanceMode = 'current' | 'chapter' | 'day' | 'month' | 'custom'

export type WorldEngineClock = {
  /** Human-readable story time, for example "星期五 18:00". */
  label: string
  /** Optional calendar name, such as "雾港历" or "自定义历法". */
  calendar?: string
  /** Story time before the last confirmed advance, when one exists. */
  previousTime?: string
  /** Canonical current story time. `label` remains as a legacy display alias. */
  currentTime: string
  /** How the last world-engine run advanced the narrative clock. */
  timeAdvanceMode: WorldEngineTimeAdvanceMode
  /** Optional target time selected for the latest advance. */
  targetTime?: string
  /** A custom narrative duration in whole days for `custom` mode. */
  customDays?: number
  /** Why the current time was advanced or deliberately left unchanged. */
  timeAdvanceReason?: string
  chapterId?: string
  /** Monotonic revision that changes whenever the clock is confirmed. */
  revision: number
  updatedAt: number
}

export type WorldEngineCharacterAvailability = 'interaction' | 'cooldown' | 'unseen'

export type WorldEngineCharacterState = {
  id: string
  /** Stable id of the corresponding character card, when one exists. */
  characterId?: string
  name: string
  availability: WorldEngineCharacterAvailability
  location: string
  activity: string
  mood: string
  goals: string[]
  knownFacts: string[]
  nextAction?: string
  lastSeenChapterId?: string
  /** Protects characters present in the current scene from duplicate updates. */
  sceneProtected: boolean
  updatedAt: number
  expiresAt?: number
  evidence: string[]
}

export type WorldEngineRelationship = {
  id: string
  fromCharacterId: string
  toCharacterId: string
  label: string
  detail?: string
  confidence?: 'confirmed' | 'inferred' | 'uncertain'
  evidence: string[]
  updatedAt: number
}

export type WorldEngineEventKind = 'trend' | 'event' | 'action' | 'discovery' | 'consequence'
export type WorldEngineEventStatus = 'planned' | 'active' | 'resolved' | 'discarded'

export type WorldEngineEvent = {
  id: string
  kind: WorldEngineEventKind
  title: string
  summary: string
  status: WorldEngineEventStatus
  actorIds: string[]
  /** Story time or chapter in which the event is expected to happen. */
  scheduledTime?: string
  chapterId?: string
  consequences: string[]
  evidence: string[]
  creationSource?: 'agent' | 'manual'
  reviewStatus?: 'pending' | 'complete'
  reviewStatusLocked?: boolean
  /** Previous review-state lock retained while the whole event is locked. */
  reviewStatusLockedBeforeAll?: boolean
  lockedAll?: boolean
  updatedAt: number
}

export type WorldEngineTimelineEntry = {
  id: string
  title: string
  summary: string
  /** Story time label; this is intentionally text because fiction time is not
   * necessarily a real-world timestamp. */
  time: string
  chapterId?: string
  source: 'chapter' | 'engine' | 'author'
  eventIds: string[]
  createdAt: number
}

export type WorldEngineWorkNote = {
  id: string
  title: string
  content: string
  chapterId?: string
  createdAt: number
}

export type WorldEngineChangeKind = 'clock' | 'character' | 'relationship' | 'event' | 'timeline' | 'note'

/** A single change proposed by the model before the author confirms it. */
export type WorldEngineChangeProposal = {
  id: string
  kind: WorldEngineChangeKind
  targetId: string
  summary: string
  patch: Record<string, unknown>
  evidence: string[]
}

export type WorldEngineProposalStatus = 'pending' | 'accepted' | 'rejected'

export type WorldEngineProposal = {
  id: string
  status: WorldEngineProposalStatus
  sourceChapterId?: string
  reasoning: string
  changes: WorldEngineChangeProposal[]
  createdAt: number
  decidedAt?: number
}

export type WorldEngineLogEntry = {
  id: string
  chapterId?: string
  prompt: string
  response: string
  status: 'success' | 'error'
  error?: string
  createdAt: number
}

export type WorldEngineState = {
  schemaVersion: number
  enabled: boolean
  status: WorldEngineRunStatus
  clock: WorldEngineClock
  /** Character snapshots for off-screen/background simulation. */
  characterStates: WorldEngineCharacterState[]
  relationships: WorldEngineRelationship[]
  events: WorldEngineEvent[]
  timeline: WorldEngineTimelineEntry[]
  workNotes: WorldEngineWorkNote[]
  pendingProposals: WorldEngineProposal[]
  logs: WorldEngineLogEntry[]
  /** Last confirmed chapter used as input for the next simulation. */
  lastProcessedChapterId?: string
  updatedAt: number
}

export type ResourceGroup = {
  id: string
  title: string
  collapsed: boolean
}

export type Volume = {
  id: string
  title: string
  collapsed: boolean
}

export type Chapter = {
  id: string
  title: string
  status: string
  content: string
  wordCount: number
  volumeId: string
  taskGoal?: string
  cast?: string[]
}

export type ContextBlock = {
  id: string
  title: string
  source: string
  role: string
  tokens: number
  enabled: boolean
  /** Optional major-prompt category. Older blocks can omit this field. */
  collection?: ContextCollection
  /** Entries nested inside this block. They form the second-level prompt order. */
  items?: ContextItem[]
  /** Stable ordering value retained for imported layouts. */
  order?: number
  /** Whether the group's nested entries are currently hidden in the editor. */
  collapsed?: boolean
}

/** Sections that can participate in the prompt manager's top-level order. */
export type ContextCollection =
  | 'system'
  | 'world'
  | 'characters'
  | 'items'
  | 'skills'
  | 'style'
  | 'outline'
  | 'worldEngine'
  | 'chapter'
  | 'recent'
  | 'output'
  | 'custom'

/** A nested prompt entry. `resourceId(s)` optionally pins it to card records. */
export type ContextItem = {
  id: string
  title: string
  source: string
  role: string
  tokens: number
  enabled: boolean
  collection?: ContextCollection
  resourceId?: string
  resourceIds?: string[]
  /** Stable custom-module schema id when this item represents a module. */
  customModuleId?: string
  tag?: string
  order?: number
}

/** Two-level prompt layout. Groups are dragged as a unit; items are ordered within a group. */
export type ContextGroup = Omit<ContextBlock, 'items'> & {
  collection?: ContextCollection
  items: ContextItem[]
}

export type Store = {
  schemaVersion: number
  volumes: Volume[]
  chapters: Chapter[]
  world: Resource[]
  characters: Resource[]
  items: Resource[]
  skills: Resource[]
  outline: Resource[]
  style: Resource[]
  providers: Resource[]
  modelOptions: Record<string, string[]>
  contextBlocks: ContextBlock[]
  /** Current two-level prompt layout. Optional for old snapshots. */
  contextGroups?: ContextGroup[]
  resourceGroups: Record<'world' | 'characters' | 'items' | 'skills' | 'style', ResourceGroup[]>
  /** Optional in type declarations so pre-World-Engine snapshots remain readable. */
  worldEngine?: WorldEngineState
  /** Experimental user-defined JSON modules and their entries. */
  customModules?: CustomModuleStore
  /** User-managed and Agent-collected network meme table. */
  memes: MemeStore
}

/**
 * The content boundary of one project inside a version 2 `.qy` portfolio.
 *
 * API providers and model lists are intentionally excluded from portable
 * project data. Style rules live in `PortfolioSharedContent` because they
 * are shared by every project in the same portfolio.
 */
export type PortfolioProjectContent = Omit<Omit<Omit<Store, 'providers' | 'modelOptions'>, 'style'>, 'resourceGroups'> & {
  /** Style groups belong to PortfolioSharedContent, so this object cannot contain a style group. */
  resourceGroups: Omit<Store['resourceGroups'], 'style'>
}

/** Content shared by every project in a `.qy` portfolio. */
export type PortfolioSharedContent = {
  styleRules: Resource[]
  /** Folded / ordered style-rule groups shared by every project. */
  styleGroups: ResourceGroup[]
}

export type PortfolioMetadata = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Empty string is used for a valid empty portfolio with no active project. */
  activeProjectId: string
}

export type PortfolioProject = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  content: PortfolioProjectContent
}

/**
 * Portable `.qy` document contract. This is deliberately separate from the
 * current in-memory `Store`: one file owns a portfolio and can contain many
 * projects.
 */
export type PortfolioDocument = {
  format: 'qy'
  version: 2
  kind: 'portfolio'
  portfolio: PortfolioMetadata
  sharedContent: PortfolioSharedContent
  projects: PortfolioProject[]
}

export type AgentMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  /** Visible action summaries for this turn; excluded from model conversation text. */
  activities?: AgentActivityEvent[]
}

/** A persisted Agent conversation belonging to the current work. */
export type AgentConversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Archived conversations remain persisted and can be restored from Settings. */
  archived?: boolean
  /** Time at which the conversation was archived. */
  archivedAt?: number
  messages: AgentMessage[]
}

export type AgentMode = 'writing' | 'inspiration'

export type AgentTask = {
  id: string
  label: string
  state: 'queued' | 'running' | 'done' | 'error'
  detail?: string
}

/** A human-readable event emitted while the Agent is planning or executing a task. */
export type AgentActivityEvent = {
  id: string
  title: string
  detail?: string
  createdAt: number
  state: 'running' | 'done' | 'error'
  kind?: 'status' | 'model' | 'tool' | 'stream' | 'result' | 'error'
}

/** Only the human-readable top-level Agent message is previewed while JSON arrives. */
export type AgentLiveResponse = {
  message: string
  receivedChars: number
  streaming: boolean
}

export type AgentQuickAction = {
  id: string
  label: string
  prompt: string
}

export type AgentPlanDiffStatus = 'added' | 'changed' | 'cleared' | 'removed' | 'locked'

/** One field-level before/after item shown before an Agent plan is approved. */
export type AgentPlanFieldDiff = {
  field: string
  before?: unknown
  after?: unknown
  status: AgentPlanDiffStatus
  locked?: boolean
}

/** Review metadata for one operation in a pending Agent plan. */
export type AgentOperationReview = {
  operationIndex: number
  action: AgentOperation['action']
  kind: 'create' | 'update' | 'delete' | 'move' | 'append' | 'search'
  title: string
  target?: string
  /** Explicit current-work target path shown during approval. */
  targetPath?: {
    portfolioId?: string
    projectId?: string
    collection?: string
  }
  diffs: AgentPlanFieldDiff[]
}

export type AgentPlan = {
  id: string
  message: string
  operations: AgentOperation[]
  descriptions: string[]
  /** Structured before/after data for human review. Older plans may omit it. */
  reviews?: AgentOperationReview[]
  /** Renderer-only selection carried into approval; omitted means approve all. */
  approvedOperationIndexes?: number[]
  createdAt: number
  /** Snapshot fingerprint used to reject approval after the author edits the work. */
  storeFingerprint?: string
}

/**
 * The content snapshot used by Agent rollback also keeps the renderer's
 * selection state.  The optional UI fields are deliberately optional so
 * history entries persisted before this contract was introduced remain
 * readable; restoring such entries simply leaves the current selection in
 * place.
 */
export type AgentSnapshot = Pick<Store, 'volumes' | 'chapters' | 'world' | 'characters' | 'items' | 'skills' | 'outline' | 'style' | 'resourceGroups' | 'worldEngine' | 'customModules' | 'memes' | 'contextBlocks' | 'contextGroups'> & {
  activePage?: string
  selectedChapterId?: string
  selectedVolumeId?: string
  selectedIds?: Record<string, string>
  selectedGroupIds?: Record<string, string>
  ungroupedCollapsed?: Record<string, boolean>
}

/**
 * A compact inverse patch for an Agent history entry.
 *
 * The patch transforms the post-change snapshot back into the pre-change
 * snapshot.  New entries may persist this instead of duplicating the complete
 * content snapshot; `snapshot` remains optional for backwards compatibility
 * with older .qy files and browser profiles.
 */
export type AgentHistoryPatchOperation = {
  op: 'add' | 'remove' | 'replace'
  /** JSON Pointer path relative to an AgentSnapshot. */
  path: string
  /** Value used by add/replace operations. */
  value?: unknown
}

export type AgentHistoryEntry = {
  id: string
  summary: string
  changes: string[]
  createdAt: number
  status: 'applied' | 'undone'
  /** Full pre-change snapshot retained by legacy entries. */
  snapshot?: AgentSnapshot
  /** Compact inverse patch for newer entries. */
  patch?: AgentHistoryPatchOperation[]
  /**
   * Where the change was approved. Older local profiles omit this field and
   * are treated as native Agent executions when they are loaded.
   */
  source?: 'agent' | 'console' | 'manual'
  /**
   * The reviewed operation diffs that were actually approved. Keeping these
   * separately from the rollback snapshot makes a persisted history entry
   * useful as an audit record without requiring the author to open the old
   * pending plan.
   */
  reviews?: AgentOperationReview[]
  /** Fingerprint of the work immediately after this Agent plan was applied. */
  afterFingerprint?: string
}





