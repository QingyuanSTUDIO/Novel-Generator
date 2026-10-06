import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { computed, nextTick, ref, watch } from 'vue'
import { createUnifiedSaveQueue } from '../src/composables/unifiedSave.ts'
import { useQyFileConflict } from '../src/composables/useQyFileConflict.ts'
import { syncAgentConversationMessages } from '../src/agent/conversationSync.ts'
import { agentPersistedMessageLimit, normalizeAgentActivities, normalizeAgentMessages } from '../src/agent/chatHistory.ts'
import { createAgentOperations, legacyStyleMetadataFields } from '../src/agent/operations.ts'
import { applyHistoryPatch, createInverseHistoryPatch } from '../src/agent/historyPatch.ts'
import { appendManualHistory } from '../src/agent/manualHistory.ts'
import { validateAgentResponse } from '../src/agent/validation.ts'
import { defaultStandardCreationPromptHints, normalizeStandardCreationPromptHints } from '../src/agent/resourceStructure.ts'
import { createPortfolioDocument, createPortfolioProject } from '../src/data/portfolio.ts'
import { externalizePortfolioDocumentImages } from '../src/data/characterAttachments.ts'
import { createDesktopProfile, parseDesktopProfile, profileProjectSession } from '../src/data/desktopProfile.ts'
import { seed, syncContextResourceItems } from '../src/data/seed.ts'
import { cloneThemeSettings, defaultThemeSettings, normalizeThemeSettings } from '../src/data/theme.ts'
import { canonicalTriggerField, normalizeResourceTriggers } from '../src/context/retrieval.ts'
import { contentFingerprint, createConsoleExecutor, matchesFingerprint } from '../src/console/execution.ts'
import { readModelSettings } from '../src/api/modelSettings.ts'

// Exercise App's real wiring without opening Electron or touching local data.
// Mutable state and UI/lifecycle dependencies are synthetic. Saving, approval,
// snapshots, validation and operations use production code; native file,
// profile, checkpoint and network boundaries use in-memory spies.
const appSource = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const script = appSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(script, 'App script setup must exist')
const parsed = ts.createSourceFile('App.ts', script, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

function functionSource(name) {
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration, `App.${name} must exist`)
  return declaration.getText(parsed)
}

function variableSource(name) {
  function binds(node) {
    if (ts.isIdentifier(node)) return node.text === name
    return (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node))
      && node.elements.some((item) => ts.isBindingElement(item) && binds(item.name))
  }
  const declaration = parsed.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => binds(item.name)))
  assert.ok(declaration, `App.${name} must exist`)
  return declaration.getText(parsed)
}

function closeRegistrationSource() {
  let registration
  function visit(node) {
    if (ts.isExpressionStatement(node) && node.getText(parsed).startsWith('removeDesktopFlushListener =')) {
      registration = node.getText(parsed)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(registration, 'The desktop close callback must be registered')
  return registration
}

const saveFunctions = [
  'cloneSerializable',
  'syncActiveAgentConversation',
  'projectDataStore',
  'captureProjectSnapshot',
  'syncCurrentProjectRecord',
  'createCurrentPortfolioDocument',
  'persistedAppState',
  'enqueueRemotePersistence',
  'saveQyFile',
  'flushPersistence',
  'scheduleRemotePersistence',
  'scheduleAutoSave',
  'markDirty',
  'persist',
  'stopPendingSaveTimers',
  'hasPendingUnsavedChanges',
  'requestSaveGuard',
  'resolveSaveGuard',
  'withSaveGuard',
  'discardUnsavedChanges',
  'applyDesktopProfile',
  'normalizeProviderDefaults',
  'hydrateRemotePersistence',
  'restoreLastQyFile',
  'createNewQyFile',
  'promptResource',
  'agentPageForType',
  'resourceDefaults',
  'insertResource',
  'isApiConfigured',
  'updateAgentTask',
  'addAgentActivity',
  'updateAgentActivity',
  'addAgentResultMessage',
  'finishAgentActivities',
  'captureAgentSnapshot',
  'agentStoreFingerprint',
  'agentPlanFingerprint',
  'restoreAgentSnapshot',
  'beginManualHistory',
  'commitManualHistory',
  'addAgentHistory',
  'approveAgentPlan',
  'undoAgentHistory',
  'stageConsolePlan',
].map(functionSource).join('\n')
const dirtyWatchers = parsed.statements.filter((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(parsed) === 'watch'
  && node.getText(parsed).includes('markDirty('))
  .map((node) => `watcherStops.push(${node.expression.getText(parsed)})`)
  .join('\n')
const appSaveCode = ts.transpileModule(`
${saveFunctions}
${variableSource('applyAgentOperation')}
${variableSource('unifiedSaveQueue')}
${variableSource('qyConflict')}
${variableSource('consoleExecutor')}
function registerCloseCallback() { ${closeRegistrationSource()} }
${dirtyWatchers}
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

function syntheticStore() {
  const value = structuredClone(seed)
  value.chapters = [{
    id: 'chapter-test', title: 'Synthetic chapter', status: '草稿',
    content: 'Synthetic original content', wordCount: 26, volumeId: 'volume-test',
    taskGoal: '', cast: [],
  }]
  value.volumes = [{ id: 'volume-test', title: 'Synthetic volume', collapsed: false }]
  for (const collection of ['world', 'characters', 'items', 'skills', 'outline', 'style', 'providers']) {
    value[collection] = []
  }
  value.modelOptions = {}
  value.resourceGroups = { world: [], characters: [], items: [], skills: [], style: [] }
  syncContextResourceItems(value)
  return value
}

const testNavItems = [
  'writer', 'world', 'characters', 'items', 'skills', 'outline', 'worldEngine',
  'style', 'context', 'agent', 'console', 'api', 'json', 'custom', 'memes',
].map((key) => ({ key }))

const createHarness = new Function('dependencies', 'fixture', `
const {
  computed, ref, watch, nextTick, createUnifiedSaveQueue, syncAgentConversationMessages,
  normalizeAgentMessages, agentPersistedMessageLimit, createPortfolioDocument,
  createPortfolioProject, createDesktopProfile, cloneThemeSettings,
  externalizePortfolioDocumentImages,
  defaultThemeSettings, defaultStandardCreationPromptHints, workingStore,
  normalizeThemeSettings, normalizeStandardCreationPromptHints, parseDesktopProfile,
  profileProjectSession, syntheticStore,
  navItems,
  normalizeAgentActivities, createAgentOperations, legacyStyleMetadataFields,
  validateAgentResponse, syncContextResourceItems, canonicalTriggerField,
  normalizeResourceTriggers, contentFingerprint, createConsoleExecutor,
  matchesFingerprint, readModelSettings, useQyFileConflict, applyHistoryPatch,
  createInverseHistoryPatch, appendManualHistory,
} = dependencies
const fileWrites = [], profileWrites = [], closeResponses = [], openedFiles = [], checkpointWrites = [], searches = []
const timers = new Map(), watcherStops = []
let nextTimerId = 1, closeCallback, recentRefreshes = 0
let profileFailure = fixture.profileFailure
const consoleRuntime = {
  activeJobId: ref('synthetic-agent-job'), pendingJobId: ref(''),
  report() {},
  async checkpoint(jobId, result) {
    checkpointWrites.push({ jobId, result: structuredClone(result) })
    if (fixture.onCheckpoint) await fixture.onCheckpoint(jobId, result)
  },
  async suspend() { if (fixture.onSuspendConsole) await fixture.onSuspendConsole() },
}
const window = {
  setTimeout(callback, delay) {
    const id = nextTimerId++
    timers.set(id, { callback, delay })
    return id
  },
  clearTimeout(id) { timers.delete(id) },
  desktopFile: {
    async save(document, currentPath, options) {
      const call = { document: structuredClone(document), currentPath, options: { ...options } }
      fileWrites.push(call)
      if (fixture.onFileSave) return fixture.onFileSave(call, fileWrites.length)
      return fixture.cancel
        ? { canceled: true }
        : { canceled: false, path: fixture.savedPath || 'C:/synthetic/portfolio.qy', title: 'Synthetic portfolio', revision: 'sha256:' + String(fileWrites.length).padStart(64, '0') }
    },
  },
  desktopStorage: {
    onFlushRequest(callback) { closeCallback = callback; return () => {} },
    completeFlush(requestId, result) { closeResponses.push({ requestId, ...result }) },
  },
}
async function fetch(url, input) {
  if (url !== '/api/storage') throw new Error('Unexpected external request')
  if (input.method !== 'PUT') {
    if (fixture.hydrateError) throw new Error(fixture.hydrateError)
    return { status: 200, ok: true, json: async () => ({ ok: true, state: fixture.hydrateState ?? null }) }
  }
  const payload = JSON.parse(input.body)
  profileWrites.push(payload)
  if (profileFailure) return { status: 500, ok: false, json: async () => ({ ok: false, error: profileFailure }) }
  return { status: 200, ok: true, json: async () => ({ ok: true, updatedAt: payload.state.updatedAt }) }
}
function localApiUrl(value) { return value }
async function refreshRecentQyFiles() { recentRefreshes += 1 }
async function openRecentQyFile(path, options) {
  openedFiles.push({ path, options })
  if (fixture.openError) {
    qyFileError.value = fixture.openError
    return false
  }
  currentQyPath.value = path
  return true
}
function restoreAgentConversationState() { throw new Error('Unexpected synthetic conversation fallback') }
function persistGlobalSettings() {}
function restoreGlobalSettings() {}
function readLocalCache() { return null }
function applyThemeToDocument() {}
function clampAgentPosition(x, y) { return { x, y } }
function initializeBlankProject() {
  store.value = syntheticStore()
  store.value.chapters[0].content = ''
  projects.value = [{ id: 'project-test', title: '', createdAt: 1, updatedAt: 1, snapshot: captureProjectSnapshot() }]
}
function applyPersistedAppState(state) {
  if (state.store) store.value = cloneSerializable(state.store)
}
function restoreProjectRegistry(records, activeId) {
  projects.value = cloneSerializable(records)
  currentProjectId.value = activeId || records[0]?.id || ''
  const active = projects.value.find((record) => record.id === currentProjectId.value) || projects.value[0]
  if (active?.snapshot?.store) store.value = cloneSerializable(active.snapshot.store)
  if (active?.snapshot?.agentConversations) agentConversations.value = cloneSerializable(active.snapshot.agentConversations)
  if (active?.snapshot?.agentMessages) agentMessages.value = cloneSerializable(active.snapshot.agentMessages)
  return true
}
function migrateCurrentProject() {}
function createBlankProjectRecord(title) {
  const blank = syntheticStore()
  blank.chapters[0].content = ''
  return { id: 'project-new', title, createdAt: 1, updatedAt: 1, snapshot: captureProjectSnapshot(blank) }
}
function restoreProjectRecord(record) {
  restoreProjectRegistry([record], record.id)
  currentWorkTitle.value = record.title
}
function resetWorkRuntimeAfterFileOpen() {}
async function runAgentPrompt() { throw new Error('Unexpected model request in a local approval test') }
async function collectWebMemesForAgent(query, engine, limit, epoch, provider) {
  const call = { query, engine, limit, epoch, provider, signal: agentAbortController?.signal }
  searches.push(call)
  if (!fixture.onSearch) throw new Error('Unexpected network request in a local approval test')
  return fixture.onSearch(call)
}
function createMemeEntry() { throw new Error('Unexpected network result insertion in a local approval test') }
const isDesktopRuntime = true, desktopStorageHydrated = ref(true), remotePersistenceReady = ref(true)
const desktopStorageError = ref(''), remotePersistenceError = ref(''), remotePersistenceWarning = ref(''), qyFileError = ref('')
const qyFileBusy = ref(false), saveState = ref(fixture.dirty === false ? '已保存' : '未保存')
const currentQyPath = ref(fixture.filePath ?? 'C:/synthetic/portfolio.qy')
const currentQyRevision = ref(fixture.revision ?? 'sha256:' + 'a'.repeat(64))
const currentQyPortfolioId = ref('portfolio-test'), currentQyPortfolioTitle = ref('Synthetic portfolio')
const currentQyPortfolioCreatedAt = ref(1), qyBackupCount = ref(3)
const autoSaveSeconds = ref(fixture.autoSaveSeconds ?? 0)
let qyFileDirty = fixture.dirty !== false, autoSaveDirty = fixture.dirty !== false, profileDirty = false
let dirtyGeneration = 0, contentGeneration = 0, profileGeneration = 0
let suppressDirtyTracking = false, lastSavedAppState = null
let legacySessionSource = fixture.legacy ? { syntheticLegacyContent: true } : null
let saveWasCanceled = false, desktopFlushSucceeded = false, desktopFlushAbandoned = false
const desktopStorageFlushing = ref(false)
let remotePersistenceTimer, autoSaveTimer, removeDesktopFlushListener
let remotePersistenceQueue = Promise.resolve(), remoteRevision = 0, allowProjectDeletionUntilSaved = false
let profileSessions = {}, desktopProfile = null
let hydrationInProgress = false, desktopHydrationController, desktopHydrationTimeout, qyStartupRestoreAttempted = false
const projectsStorageKey = 'synthetic-projects', storageKey = 'synthetic-work'
const recentQyFiles = ref(fixture.recentFiles || [])
const pendingSaveStates = new Set(['未保存', '待自动保存', '保存中', '保存失败', '保存冲突', '文件冲突', '缓存失败'])
const saveGuardReason = ref(''), saveGuardError = ref(''), saveGuardOpen = ref(false), saveGuardBusy = ref(false)
let saveGuardResolver
const projectMenuOpen = ref(false), projectDeleteOpen = ref(false), projectRenameOpen = ref(false), agentOpen = ref(false)
const selectedGroupIds = ref({}), ungroupedCollapsed = ref({})
const store = ref(workingStore), projects = ref([])
const currentProjectId = ref('project-test'), currentWorkTitle = ref('Synthetic work')
const selectedChapterId = ref('chapter-test'), selectedVolumeId = ref('volume-test')
const selectedIds = ref({ world: '', characters: '', items: '', skills: '', outline: '', style: '', api: '' })
const activePage = ref('writer'), agentPosition = ref({ x: 10, y: 10 })
const agentProviderId = ref(''), writerProviderId = ref(''), worldEngineProviderId = ref('')
const agentMode = ref('writing'), agentHistory = ref([]), agentHistoryLimit = ref(20)
const agentPendingPlan = ref(null), agentBusy = ref(false), agentProvider = ref(undefined), defaultProvider = ref(undefined)
const agentActivities = ref([]), agentLiveResponse = ref(null), memeCandidates = ref([])
const agentTasks = ref([{ id: 'execute', state: 'queued' }, { id: 'report', state: 'queued' }])
let agentRunEpoch = 0, agentAbortController
const latestUndoableHistoryId = computed(() => agentHistory.value.find((entry) => entry.status === 'applied')?.id ?? '')
const activeChapter = computed(() => store.value.chapters.find((chapter) => chapter.id === selectedChapterId.value))
const chapterSearch = ref(''), candidate = ref('')
const activeGroupPage = computed(() => ['world', 'characters', 'items', 'skills', 'style'].includes(activePage.value) ? activePage.value : null)
const activeGroups = computed(() => activeGroupPage.value ? store.value.resourceGroups[activeGroupPage.value] : [])
const selectedGroupId = computed(() => activeGroupPage.value ? selectedGroupIds.value[activeGroupPage.value] : '')
const isGenerating = ref(false), paragraphEdit = ref(null), worldEngineBusy = ref(false), memeSearchBusy = ref(false)
const message = { id: 'message-test', role: 'assistant', content: 'Synthetic conversation', createdAt: 1 }
const agentMessages = ref([message])
const agentConversations = ref([{
  id: 'conversation-test', title: 'Synthetic conversation', createdAt: 1, updatedAt: 1, messages: [message],
}])
const activeAgentConversationId = ref('conversation-test')
const globalStyleRules = ref([]), globalStyleGroups = ref([])
const formatIndentSpaces = ref(2), themeSettings = ref(cloneThemeSettings(defaultThemeSettings))
const standardCreationPromptHints = ref(defaultStandardCreationPromptHints())
${appSaveCode}
projects.value = [{
  id: 'project-test', title: 'Synthetic work', createdAt: 1, updatedAt: 1,
  snapshot: captureProjectSnapshot(),
}]
registerCloseCallback()
return {
  fileWrites, profileWrites, closeResponses, openedFiles, checkpointWrites, searches,
  saveQyFile, flushPersistence, captureProjectSnapshot, persistedAppState,
  createCurrentPortfolioDocument, markDirty, persist,
  hydrateRemotePersistence, restoreLastQyFile, withSaveGuard, resolveSaveGuard, discardUnsavedChanges,
  createNewQyFile,
  dismissFileConflict: () => qyConflict.dismiss(),
  reportFileConflict: (value) => qyConflict.report(value),
  resolveConflictSaveAs: () => qyConflict.saveAs(),
  approveAgentPlan, undoAgentHistory, agentStoreFingerprint, agentPlanFingerprint,
  insertResource,
  executeConsole: consoleExecutor.execute,
  async prepareAgentPlan(operations, options = {}) {
    const plan = {
      id: 'synthetic-agent-plan', message: 'Synthetic approved change', operations: structuredClone(operations),
      descriptions: [], createdAt: 1,
      storeFingerprint: options.fingerprint ?? await contentFingerprint(agentPlanFingerprint()),
    }
    agentPendingPlan.value = plan
    return structuredClone(plan)
  },
  cancelAgentRequest: () => consoleExecutor.execute({ action: 'cancel', job: { id: 'synthetic-agent-job' } }),
  addProvider: (provider) => { store.value.providers.push(provider); agentProvider.value = store.value.providers.at(-1) },
  setSelectedChapter: (id) => { selectedChapterId.value = id },
  switchProjectIdentity: (id) => { currentProjectId.value = id },
  switchPortfolioFileIdentity: (identity) => {
    if (identity.path !== undefined) currentQyPath.value = identity.path
    if (identity.portfolioId !== undefined) currentQyPortfolioId.value = identity.portfolioId
    if (identity.revision !== undefined) currentQyRevision.value = identity.revision
  },
  currentStore: () => cloneSerializable(store.value),
  uiState: () => ({
    activePage: activePage.value,
    selectedChapterId: selectedChapterId.value,
    selectedVolumeId: selectedVolumeId.value,
    selectedIds: cloneSerializable(selectedIds.value),
    selectedGroupIds: cloneSerializable(selectedGroupIds.value),
    ungroupedCollapsed: cloneSerializable(ungroupedCollapsed.value),
  }),
  setUiState: (next) => {
    if (next.activePage !== undefined) activePage.value = next.activePage
    if (next.selectedChapterId !== undefined) selectedChapterId.value = next.selectedChapterId
    if (next.selectedVolumeId !== undefined) selectedVolumeId.value = next.selectedVolumeId
    if (next.selectedIds !== undefined) selectedIds.value = cloneSerializable(next.selectedIds)
    if (next.selectedGroupIds !== undefined) selectedGroupIds.value = cloneSerializable(next.selectedGroupIds)
    if (next.ungroupedCollapsed !== undefined) ungroupedCollapsed.value = cloneSerializable(next.ungroupedCollapsed)
  },
  agentState: () => ({
    busy: agentBusy.value, pending: cloneSerializable(agentPendingPlan.value),
    history: cloneSerializable(agentHistory.value), activities: cloneSerializable(agentActivities.value),
  }),
  conversationMessages: () => agentConversations.value[0].messages,
  conversationContent: () => agentMessages.value[0].content,
  setContent: (content) => { store.value.chapters[0].content = content },
  setConversationContent: (content) => { agentMessages.value[0].content = content },
  setProfileFailure: (error) => { profileFailure = error },
  setSchemaVersion: (value) => { store.value.schemaVersion = value },
  content: () => store.value.chapters[0].content,
  baselineContent: () => lastSavedAppState?.store.chapters[0].content,
  async close() { await closeCallback('synthetic-close-request') },
  async runTimer(delay) {
    const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay)
    if (!entry) return false
    timers.delete(entry[0])
    await entry[1].callback()
    await unifiedSaveQueue.waitForPending()
    return true
  },
  pending: () => unifiedSaveQueue.pendingCount(),
  metadata: () => ({
    qyFileDirty, autoSaveDirty, profileDirty, dirtyGeneration, saveWasCanceled,
    busy: qyFileBusy.value, state: saveState.value, path: currentQyPath.value,
    fileError: qyFileError.value, profileError: remotePersistenceError.value,
    fileRevision: currentQyRevision.value, fileConflict: cloneSerializable(qyConflict.conflict.value), conflictOpen: qyConflict.open.value,
    flushing: desktopStorageFlushing.value, recentRefreshes,
    hydrated: desktopStorageHydrated.value, ready: remotePersistenceReady.value,
    portfolioId: currentQyPortfolioId.value, startupRestoreAttempted: qyStartupRestoreAttempted,
    legacyRetained: Boolean(legacySessionSource), guardOpen: saveGuardOpen.value,
    scheduledDelays: [...timers.values()].map(({ delay }) => delay),
  }),
  dispose() {
    watcherStops.forEach((stop) => stop())
    timers.clear()
  },
}
`)

function harness(t, fixture = {}) {
  const probe = createHarness({
    computed, ref, watch, nextTick, createUnifiedSaveQueue, useQyFileConflict, syncAgentConversationMessages,
    normalizeAgentMessages, agentPersistedMessageLimit, createPortfolioDocument,
    createPortfolioProject, createDesktopProfile, cloneThemeSettings,
    externalizePortfolioDocumentImages,
    defaultThemeSettings, defaultStandardCreationPromptHints, workingStore: syntheticStore(),
    normalizeThemeSettings, normalizeStandardCreationPromptHints, parseDesktopProfile,
    profileProjectSession, syntheticStore,
    navItems: testNavItems,
    normalizeAgentActivities, createAgentOperations, legacyStyleMetadataFields,
    validateAgentResponse, syncContextResourceItems, canonicalTriggerField,
    normalizeResourceTriggers, contentFingerprint, createConsoleExecutor,
    matchesFingerprint, readModelSettings, applyHistoryPatch, createInverseHistoryPatch, appendManualHistory,
  }, fixture)
  t.after(() => probe.dispose())
  return probe
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function approvalJob(plan, overrides = {}) {
  return {
    id: 'synthetic-agent-job', kind: 'plan',
    target: {
      portfolioId: 'portfolio-test', projectId: 'project-test',
      chapterId: 'chapter-test', conversationId: 'conversation-test',
    },
    prompt: '', mode: 'writing', status: 'awaiting_approval',
    createdAt: 1, updatedAt: 1, events: [],
    result: { status: 'awaiting_approval', plan },
    ...overrides,
  }
}

function appendOperation() {
  return { action: 'append_chapter', chapterId: 'chapter-test', content: 'Synthetic Agent addition' }
}

function searchOperation() {
  return { action: 'search_web_memes', engine: 'bing', query: 'Synthetic research query', limit: 2 }
}

function syntheticProvider() {
  return {
    id: 'synthetic-provider', title: 'Synthetic provider', summary: '', tag: '',
    fields: {
      接口地址: 'https://synthetic.invalid/v1',
      'API Key': 'synthetic-not-a-real-key',
      模型: 'synthetic-model', 状态: '已保存', 协议: 'OpenAI Compatible',
    },
  }
}

test('App manual save writes .qy even when automatic saving is disabled', async (t) => {
  const probe = harness(t, { autoSaveSeconds: 0 })
  assert.equal(await probe.saveQyFile(), true, JSON.stringify(probe.metadata()))
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.profileWrites.length, 1)
  assert.equal(probe.fileWrites[0].document.projects[0].content.chapters[0].content, 'Synthetic original content')
  assert.deepEqual(probe.fileWrites[0].options, {
    saveAs: false,
    backupCount: 3,
    expectedRevision: 'sha256:' + 'a'.repeat(64),
    attachments: [],
  })
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().autoSaveDirty, false)
  assert.equal(probe.metadata().state, '已保存')
  assert.equal(probe.profileWrites[0].state.kind, 'desktop-profile')
  assert.equal('store' in probe.profileWrites[0].state, false)
  assert.equal('projects' in probe.profileWrites[0].state, false)
})

test('App manual outline creation records hierarchy metadata in the same history checkpoint', async (t) => {
  const probe = harness(t, { dirty: false })
  const created = probe.insertResource(
    'outline',
    'Synthetic volume outline',
    'Synthetic outline summary',
    undefined,
    (item) => {
      item.outlineType = 'volume'
      item.outlineParentId = 'outline-book'
      item.outlineStartChapterId = 'chapter-test'
      item.outlineEndChapterId = 'chapter-test'
    },
  )

  const stored = probe.currentStore().outline.find((item) => item.id === created.id)
  assert.deepEqual({
    outlineType: stored.outlineType,
    outlineParentId: stored.outlineParentId,
    outlineStartChapterId: stored.outlineStartChapterId,
    outlineEndChapterId: stored.outlineEndChapterId,
  }, {
    outlineType: 'volume',
    outlineParentId: 'outline-book',
    outlineStartChapterId: 'chapter-test',
    outlineEndChapterId: 'chapter-test',
  })
  assert.equal(probe.agentState().history.length, 1)
  assert.match(probe.agentState().history[0].summary, /手动创建Synthetic volume outline/)

  const historyId = probe.agentState().history[0].id
  probe.undoAgentHistory(historyId)
  await nextTick()
  assert.equal(probe.currentStore().outline.some((item) => item.id === created.id), false)
  assert.equal(probe.agentState().history[0].status, 'undone')
})

test('App profile-only save cannot mark unsaved portfolio content as saved', async (t) => {
  const probe = harness(t, { autoSaveSeconds: 0 })
  probe.markDirty(false)
  assert.equal(await probe.flushPersistence(false, { profileOnly: true, allowDialog: false }), true, JSON.stringify(probe.metadata()))
  assert.equal(probe.fileWrites.length, 0)
  assert.equal(probe.profileWrites.length, 1)
  assert.equal(probe.metadata().profileDirty, false)
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.metadata().autoSaveDirty, true)
  assert.notEqual(probe.metadata().state, '已保存')
})

test('App canceled first save keeps dirty content and does not report a storage error', async (t) => {
  const probe = harness(t, { filePath: '', autoSaveSeconds: 0, cancel: true })
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.fileWrites[0].currentPath, undefined)
  assert.equal(probe.profileWrites.length, 0)
  assert.equal(probe.metadata().path, '')
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.metadata().autoSaveDirty, true)
  assert.equal(probe.metadata().saveWasCanceled, true)
  assert.equal(probe.metadata().busy, false)
  assert.equal(probe.metadata().fileError, '')
  assert.equal(probe.metadata().profileError, '')
})

test('App snapshot capture is idempotent for an unchanged reactive Agent conversation', async (t) => {
  const probe = harness(t, { dirty: false })
  const beforeMessages = probe.conversationMessages()
  for (let index = 0; index < 3; index += 1) {
    probe.captureProjectSnapshot()
    probe.createCurrentPortfolioDocument()
    probe.persistedAppState()
    await nextTick()
  }
  assert.equal(probe.conversationMessages(), beforeMessages)
  assert.equal(probe.metadata().dirtyGeneration, 0)
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().autoSaveDirty, false)
  assert.equal(probe.metadata().profileDirty, false)
})

test('App conversation edits update profile once, and subsequent capture no longer creates fake edits', async (t) => {
  const probe = harness(t, { dirty: false })
  probe.setConversationContent('Synthetic actual edit')
  await nextTick()
  assert.equal(probe.metadata().profileDirty, true)
  assert.equal(probe.metadata().qyFileDirty, false)
  const generationAfterEdit = probe.metadata().dirtyGeneration
  for (let index = 0; index < 3; index += 1) {
    probe.persistedAppState()
    await nextTick()
  }
  assert.equal(probe.metadata().dirtyGeneration, generationAfterEdit)
  assert.equal(await probe.flushPersistence(false, { profileOnly: true, allowDialog: false }), true, JSON.stringify(probe.metadata()))
  assert.equal(probe.metadata().autoSaveDirty, false)
  assert.equal(probe.metadata().state, '已保存')
})

test('App automatic save reaches the same queue and writes the current .qy snapshot', async (t) => {
  const probe = harness(t, { dirty: false, autoSaveSeconds: 5 })
  probe.setContent('Synthetic automatic edit')
  await nextTick()
  assert.ok(probe.metadata().scheduledDelays.includes(5000))
  assert.equal(await probe.runTimer(5000), true)
  assert.equal(await probe.runTimer(250), true)
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.fileWrites[0].document.projects[0].content.chapters[0].content, 'Synthetic automatic edit')
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().state, '已保存')
})

test('App writes a new snapshot for a real edit during Save As without opening a second Save As dialog', async (t) => {
  const firstStarted = deferred()
  const firstFinish = deferred()
  const probe = harness(t, {
    async onFileSave(_call, count) {
      if (count === 1) {
        firstStarted.resolve()
        await firstFinish.promise
      }
      return { canceled: false, path: 'C:/synthetic/renamed.qy', title: 'Renamed synthetic portfolio' }
    },
  })
  const saving = probe.saveQyFile(true)
  await Promise.race([
    firstStarted.promise,
    saving.then(() => { throw new Error(`Save As ended before the native boundary: ${JSON.stringify(probe.metadata())}`) }),
  ])
  probe.setContent('Synthetic edit during Save As')
  await nextTick()
  firstFinish.resolve()
  assert.equal(await saving, true)
  assert.equal(probe.fileWrites.length, 2)
  assert.deepEqual(probe.fileWrites.map(({ options }) => options.saveAs), [true, false])
  assert.equal(probe.fileWrites[1].currentPath, 'C:/synthetic/renamed.qy')
  assert.equal(probe.fileWrites[1].document.projects[0].content.chapters[0].content, 'Synthetic edit during Save As')
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().state, '已保存')
})

test('App close callback uses unified saving and reports confirmation after .qy and profile writes', async (t) => {
  const probe = harness(t, { autoSaveSeconds: 0 })
  await probe.close()
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.profileWrites.length, 1)
  assert.deepEqual(probe.closeResponses, [{
    requestId: 'synthetic-close-request', saved: true, canceled: false, error: undefined,
  }])
  assert.equal(probe.metadata().flushing, false)
  assert.equal(probe.metadata().qyFileDirty, false)
})

test('App close callback reports canceled first save instead of an empty-error failure', async (t) => {
  const probe = harness(t, { filePath: '', cancel: true })
  await probe.close()
  assert.deepEqual(probe.closeResponses, [{
    requestId: 'synthetic-close-request', saved: false, canceled: true, error: undefined,
  }])
  assert.equal(probe.metadata().flushing, false)
  assert.equal(probe.metadata().qyFileDirty, true)
})

test('App menus, editor save, automatic save and close route through the same save queue', () => {
  const template = appSource.split('</script>')[1]
  assert.match(template, /@save-file="saveQyFile\(\)"/)
  assert.match(template, /@save-as-file="saveQyFile\(true\)"/)
  const writerSource = fs.readFileSync(new URL('../src/components/WriterWorkspace.vue', import.meta.url), 'utf8')
  const editorActions = writerSource.match(/class="editor-actions"([\s\S]*?)<\/div>/)?.[1]
  assert.ok(editorActions)
  assert.match(editorActions, /@click="emit\('save-file'\)"/)
  assert.doesNotMatch(editorActions, /@click="emit\('persist'/)
  assert.match(functionSource('saveQyFile'), /return flushPersistence\(false, \{ saveAs, allowDialog: true \}\)/)
  assert.match(functionSource('flushPersistence'), /unifiedSaveQueue\.save\(/)
  assert.match(functionSource('scheduleRemotePersistence'), /flushPersistence\(false,/)
  assert.match(closeRegistrationSource(), /await flushPersistence\(\)/)
  const titleBar = fs.readFileSync(new URL('../src/components/DesktopTitleBar.vue', import.meta.url), 'utf8')
  const saveButton = titleBar.match(/<button[^>]*@click="[^"]*emit\('saveFile'\)[^"]*"[\s\S]*?<\/button>/)?.[0]
  assert.ok(saveButton)
  assert.doesNotMatch(saveButton, /:disabled="[^"]*!props\.filePath/)
})

test('App legacy work without a .qy path is never replaced by a settings-only profile write', async (t) => {
  const probe = harness(t, { filePath: '', legacy: true, autoSaveSeconds: 5 })
  probe.markDirty(false)
  assert.equal(await probe.flushPersistence(false, { profileOnly: true, allowDialog: false }), false)
  assert.equal(probe.fileWrites.length, 0)
  assert.equal(probe.profileWrites.length, 0)
  assert.equal(probe.metadata().legacyRetained, true)
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.match(probe.metadata().fileError, /先保存.*\.qy/)
})

test('App legacy work without a .qy path is preserved when automatic saving runs', async (t) => {
  const probe = harness(t, { filePath: '', legacy: true, autoSaveSeconds: 5 })
  probe.markDirty(false)
  assert.equal(await probe.runTimer(5000), true)
  assert.equal(await probe.runTimer(250), true)
  assert.equal(probe.fileWrites.length, 0)
  assert.equal(probe.profileWrites.length, 0)
  assert.equal(probe.metadata().legacyRetained, true)
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.metadata().saveWasCanceled, true)
})

test('App legacy restoration does not replace unexported work with an arbitrary recent file', async (t) => {
  const probe = harness(t, {
    filePath: '', legacy: true,
    recentFiles: [{ path: 'C:/synthetic/outdated.qy', title: 'Outdated synthetic export', updatedAt: 1 }],
  })
  assert.equal(await probe.restoreLastQyFile(), true)
  assert.equal(probe.openedFiles.length, 0)
  assert.equal(probe.metadata().recentRefreshes, 0)
  assert.equal(probe.content(), 'Synthetic original content')
  assert.equal(probe.metadata().legacyRetained, true)
})

test('App records a confirmed .qy baseline even when the independent profile write fails', async (t) => {
  const probe = harness(t, { profileFailure: 'Synthetic profile disk failure' })
  probe.setContent('Synthetic content confirmed in .qy')
  await nextTick()
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.baselineContent(), 'Synthetic content confirmed in .qy')
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().profileDirty, true)
  assert.equal(probe.metadata().autoSaveDirty, true)
  assert.match(probe.metadata().profileError, /作品已写入 \.qy/)

  probe.setContent('Synthetic later unsaved content')
  await nextTick()
  await probe.discardUnsavedChanges()
  assert.equal(probe.content(), 'Synthetic content confirmed in .qy')
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().autoSaveDirty, false)
})

test('App reload failure clears the prior file identity and cannot save a blank work over its old path', async (t) => {
  const profile = createDesktopProfile({
    updatedAt: 10,
    store: { providers: [], modelOptions: {} },
    settings: {
      autoSaveSeconds: 0, formatIndentSpaces: 2, qyBackupCount: 3,
      theme: cloneThemeSettings(defaultThemeSettings),
      resourcePromptHints: defaultStandardCreationPromptHints(),
    },
  }, { portfolioId: 'portfolio-missing', filePath: 'C:/synthetic/missing.qy' })
  const probe = harness(t, {
    filePath: 'C:/synthetic/old.qy', dirty: false,
    hydrateState: profile, openError: 'Synthetic missing portfolio file',
  })
  await probe.hydrateRemotePersistence()
  assert.equal(probe.metadata().path, '')
  assert.equal(probe.metadata().portfolioId, '')
  assert.equal(probe.metadata().hydrated, false)
  assert.equal(probe.metadata().ready, false)
  assert.deepEqual(probe.openedFiles, [{
    path: 'C:/synthetic/missing.qy', options: { startup: true },
  }])
  probe.persist()
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(probe.fileWrites.length, 0)
  assert.equal(probe.profileWrites.length, 0)
  assert.equal(await probe.runTimer(250), false)
})

test('App save guard drains queued writes and cancels pending timers before switching work', async (t) => {
  const started = deferred()
  const finish = deferred()
  const probe = harness(t, {
    autoSaveSeconds: 5,
    async onFileSave() {
      started.resolve()
      await finish.promise
      return { canceled: false, path: 'C:/synthetic/portfolio.qy' }
    },
  })
  const saving = probe.saveQyFile()
  await started.promise
  probe.persist({ profileOnly: true })
  assert.ok(probe.metadata().scheduledDelays.includes(250))
  let switched = false
  const switching = probe.withSaveGuard('synthetic switch', () => { switched = true })
  await nextTick()
  assert.equal(switched, false)
  assert.deepEqual(probe.metadata().scheduledDelays, [])
  finish.resolve()
  assert.equal(await saving, true)
  assert.equal(await switching, true)
  assert.equal(switched, true)
  assert.equal(probe.pending(), 0)
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.profileWrites.length, 1)
})

test('App profile-only capture can save valid settings while the editable portfolio is temporarily invalid', async (t) => {
  const probe = harness(t)
  probe.setSchemaVersion(Number.NaN)
  assert.equal(await probe.flushPersistence(false, { profileOnly: true, allowDialog: false }), true, JSON.stringify(probe.metadata()))
  assert.equal(probe.fileWrites.length, 0)
  assert.equal(probe.profileWrites.length, 1)
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.metadata().autoSaveDirty, true)
})

test('App reload and discard contain the explicit file and confirmed-session safety boundaries', () => {
  const hydration = functionSource('hydrateRemotePersistence')
  assert.ok(hydration.indexOf('await unifiedSaveQueue.waitForPending()') < hydration.indexOf("currentQyPath.value = ''"))
  assert.ok(hydration.indexOf("currentQyPath.value = ''") < hydration.indexOf("fetch(localApiUrl('/api/storage')"))
  assert.match(hydration, /qyStartupRestoreAttempted = false/)
  assert.match(hydration, /profileState\?\.activePortfolio && restored === false/)
  assert.match(hydration, /desktopStorageHydrated\.value = false/)
  assert.match(hydration, /if \(!remoteState \|\| currentQyPath\.value\) persist\(\{ profileOnly: true \}\)/)
  const guard = functionSource('withSaveGuard')
  assert.equal((guard.match(/await unifiedSaveQueue\.waitForPending\(\)/g) ?? []).length, 2)
  assert.match(guard, /await discardUnsavedChanges\(\)/)
  const discard = functionSource('discardUnsavedChanges')
  assert.match(discard, /const baseline = lastSavedAppState/)
  assert.match(discard, /applyDesktopProfile\(desktopProfile\)/)
  assert.match(discard, /profileProjectSession\(desktopProfile, currentQyPortfolioId\.value, project\.id\)/)
  assert.match(discard, /await nextTick\(\)/)
})

test('App discarding a new portfolio restores its blank baseline without returning to the previous file', async (t) => {
  const probe = harness(t)
  assert.equal(await probe.saveQyFile(), true)
  assert.equal(probe.baselineContent(), 'Synthetic original content')
  await probe.createNewQyFile()
  assert.equal(probe.metadata().path, '')
  assert.equal(probe.baselineContent(), '')
  assert.equal(probe.content(), '')
  probe.setContent('Synthetic unsaved new work')
  await nextTick()
  await probe.discardUnsavedChanges()
  assert.equal(probe.content(), '')
  assert.equal(probe.metadata().path, '')
  assert.equal(probe.metadata().portfolioId, '')
  assert.equal(probe.metadata().state, '未建立 .qy 文件')
  assert.equal(probe.fileWrites.length, 1)
})

test('App discarding work edits keeps the latest confirmed profile conversation rather than its older file baseline', async (t) => {
  const probe = harness(t)
  assert.equal(await probe.saveQyFile(), true)
  probe.setConversationContent('Synthetic conversation confirmed in profile')
  await nextTick()
  assert.equal(await probe.flushPersistence(false, { profileOnly: true, allowDialog: false }), true)
  assert.equal(probe.profileWrites.at(-1).state.projectSessions['portfolio-test:project-test'].agentMessages[0].content,
    'Synthetic conversation confirmed in profile')

  probe.setConversationContent('Synthetic later unconfirmed conversation')
  probe.setContent('Synthetic later unsaved content')
  await nextTick()
  await probe.discardUnsavedChanges()
  assert.equal(probe.content(), 'Synthetic original content')
  assert.equal(probe.conversationContent(), 'Synthetic conversation confirmed in profile')
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().autoSaveDirty, false)
})

test('App approval durably checkpoints its applied change and undo record before unified saving', async (t) => {
  const checkpointStarted = deferred()
  const checkpointFinish = deferred()
  t.after(checkpointFinish.resolve)
  const order = []
  const probe = harness(t, {
    dirty: false,
    async onCheckpoint() {
      order.push('checkpoint-started')
      checkpointStarted.resolve()
      await checkpointFinish.promise
      order.push('checkpoint-finished')
    },
    async onFileSave() {
      order.push('file-save')
      return { canceled: false, path: 'C:/synthetic/portfolio.qy' }
    },
  })
  const plan = await probe.prepareAgentPlan([appendOperation()])
  const execution = probe.executeConsole({ action: 'approve', job: approvalJob(plan) })
  await Promise.race([
    checkpointStarted.promise,
    execution.then((result) => { throw new Error(`Approval never reached checkpoint: ${JSON.stringify(result)}`) }),
  ])

  assert.equal(probe.content(), 'Synthetic original content\n\nSynthetic Agent addition')
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.agentState().history[0].status, 'applied')
  assert.equal(probe.agentState().pending, null)
  assert.equal(probe.checkpointWrites.length, 1)
  assert.match(probe.checkpointWrites[0].result.afterFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal(probe.fileWrites.length, 0)
  assert.equal(probe.profileWrites.length, 0)

  checkpointFinish.resolve()
  const result = await execution
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.applied, true)
  assert.deepEqual(order, ['checkpoint-started', 'checkpoint-finished', 'file-save'])
  assert.equal(probe.fileWrites[0].document.projects[0].content.chapters[0].content, probe.content())
  const savedHistory = probe.profileWrites[0].state.projectSessions['portfolio-test:project-test'].agentHistory
  assert.equal(savedHistory.length, 1)
  assert.equal(savedHistory[0].id, plan.id)
  assert.equal(savedHistory[0].source, 'console')
  assert.equal(savedHistory[0].snapshot.chapters[0].content, 'Synthetic original content')
  assert.ok(savedHistory[0].patch?.length > 0)
  assert.deepEqual(Object.keys(savedHistory[0].snapshot), ['chapters'])
  assert.equal(savedHistory[0].snapshot.world, undefined)
  assert.equal(probe.metadata().qyFileDirty, false)
})

test('App approval executes only the selected operations and keeps the normal checkpoint flow', async (t) => {
  const probe = harness(t, { dirty: false })
  const plan = await probe.prepareAgentPlan([
    appendOperation(),
    { action: 'append_chapter', chapterId: 'missing-synthetic-chapter', content: 'Must be skipped' },
  ])
  const result = await probe.executeConsole({ action: 'approve', operationIndexes: [0], job: approvalJob(plan) })

  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.applied, true)
  assert.equal(probe.content(), 'Synthetic original content\n\nSynthetic Agent addition')
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.checkpointWrites.length, 1)
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.agentState().pending, null)
})

test('App approval keeps applied content and its usable undo record when the .qy write fails', async (t) => {
  const probe = harness(t, {
    dirty: false,
    onFileSave: () => ({ canceled: false, error: 'Synthetic .qy disk failure' }),
  })
  const plan = await probe.prepareAgentPlan([appendOperation()])
  const result = await probe.executeConsole({ action: 'approve', job: approvalJob(plan) })

  assert.equal(result.status, 'failed')
  assert.equal(result.applied, true)
  assert.match(result.error, /Synthetic \.qy disk failure/)
  assert.equal(probe.content(), 'Synthetic original content\n\nSynthetic Agent addition')
  assert.equal(probe.checkpointWrites.length, 1)
  assert.equal(probe.profileWrites.length, 0)
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.agentState().history[0].status, 'applied')
  assert.equal(probe.agentState().pending, null)
  assert.equal(probe.metadata().qyFileDirty, true)

  probe.undoAgentHistory(plan.id)
  await nextTick()
  assert.equal(probe.content(), 'Synthetic original content')
  assert.equal(probe.agentState().history[0].status, 'undone')
  assert.equal(probe.fileWrites.length, 1)
})

test('App recovery of an applied failed approval saves once without appending or recording the operation again', async (t) => {
  const probe = harness(t, {
    dirty: false,
    onFileSave: (_call, count) => count === 1
      ? { canceled: false, error: 'Synthetic first write failure' }
      : { canceled: false, path: 'C:/synthetic/portfolio.qy' },
  })
  const plan = await probe.prepareAgentPlan([appendOperation()])
  const input = approvalJob(plan)
  const failed = await probe.executeConsole({ action: 'approve', job: input })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.applied, true)

  const recovered = await probe.executeConsole({
    action: 'run', job: { ...input, status: 'failed', result: failed },
  })
  assert.equal(recovered.status, 'completed', recovered.error)
  assert.equal(recovered.applied, true)
  assert.equal(probe.content(), 'Synthetic original content\n\nSynthetic Agent addition')
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.checkpointWrites.length, 1)
  assert.equal(probe.searches.length, 0)
  assert.equal(probe.fileWrites.length, 2)
  assert.equal(probe.fileWrites[1].document.projects[0].content.chapters[0].content, probe.content())
  assert.equal(probe.metadata().qyFileDirty, false)
})

test('App approval retains a confirmed .qy baseline and applied undo record when profile saving fails', async (t) => {
  const probe = harness(t, { dirty: false, profileFailure: 'Synthetic profile disk failure' })
  const plan = await probe.prepareAgentPlan([appendOperation()])
  const result = await probe.executeConsole({ action: 'approve', job: approvalJob(plan) })

  assert.equal(result.status, 'failed')
  assert.equal(result.applied, true)
  assert.match(result.error, /作品已写入 \.qy/)
  assert.equal(probe.content(), 'Synthetic original content\n\nSynthetic Agent addition')
  assert.equal(probe.baselineContent(), probe.content())
  assert.equal(probe.checkpointWrites.length, 1)
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.agentState().history[0].status, 'applied')
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().profileDirty, true)
})

test('App checkpoint failure preserves committed work and can recover saving without replaying the change', async (t) => {
  const probe = harness(t, {
    dirty: false,
    onCheckpoint: () => { throw new Error('Synthetic checkpoint disk failure') },
  })
  const plan = await probe.prepareAgentPlan([appendOperation()])
  const input = approvalJob(plan)
  const failed = await probe.executeConsole({ action: 'approve', job: input })

  assert.equal(failed.status, 'failed')
  assert.equal(failed.applied, true)
  assert.match(failed.error, /Synthetic checkpoint disk failure/)
  assert.match(failed.afterFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal(probe.content(), 'Synthetic original content\n\nSynthetic Agent addition')
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.fileWrites.length, 0)
  assert.equal(probe.metadata().qyFileDirty, true)

  const recovered = await probe.executeConsole({
    action: 'run', job: { ...input, status: 'failed', result: failed },
  })
  assert.equal(recovered.status, 'completed', recovered.error)
  assert.equal(probe.content(), 'Synthetic original content\n\nSynthetic Agent addition')
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.checkpointWrites.length, 1)
  assert.equal(probe.fileWrites.length, 1)
})

test('App refuses stale approval after author edits without overwriting those edits', async (t) => {
  const probe = harness(t, { dirty: false })
  await probe.prepareAgentPlan([appendOperation()])
  probe.setContent('Synthetic author edit after planning')
  await nextTick()
  const result = await probe.approveAgentPlan()

  assert.equal(result.status, 'failed')
  assert.notEqual(result.applied, true)
  assert.match(result.error, /作品或当前章节发生变化/)
  assert.equal(probe.content(), 'Synthetic author edit after planning')
  assert.equal(probe.agentState().pending, null)
  assert.equal(probe.agentState().history.length, 0)
  assert.equal(probe.checkpointWrites.length, 0)
  assert.equal(probe.fileWrites.length, 0)
})

test('App cancellation during approval fingerprinting commits no changes and clears the pending plan', async (t) => {
  const probe = harness(t, { dirty: false })
  await probe.prepareAgentPlan([appendOperation()])
  const execution = probe.approveAgentPlan()
  await probe.cancelAgentRequest()
  const result = await execution

  assert.equal(result.status, 'failed')
  assert.notEqual(result.applied, true)
  assert.match(result.error, /任务已停止或作品已切换/)
  assert.equal(probe.content(), 'Synthetic original content')
  assert.equal(probe.agentState().busy, false)
  assert.equal(probe.agentState().pending, null)
  assert.equal(probe.agentState().history.length, 0)
  assert.equal(probe.checkpointWrites.length, 0)
  assert.equal(probe.fileWrites.length, 0)
})

test('App retrieval preparation applies no earlier operations when the author edits or cancels', async (t) => {
  for (const reason of ['author-edit', 'cancel']) {
    await t.test(reason, async (subtest) => {
      const started = deferred()
      const finish = deferred()
      subtest.after(finish.resolve)
      const probe = harness(subtest, {
        dirty: false,
        async onSearch() {
          started.resolve()
          await finish.promise
          return { queries: ['synthetic'], entries: [] }
        },
      })
      probe.addProvider(syntheticProvider())
      await nextTick()
      await probe.prepareAgentPlan([appendOperation(), searchOperation()])
      const execution = probe.approveAgentPlan()
      await Promise.race([
        started.promise,
        execution.then((result) => { throw new Error(`Approval never reached retrieval: ${JSON.stringify(result)}`) }),
      ])

      assert.equal(probe.content(), 'Synthetic original content')
      assert.equal(probe.agentState().history.length, 0)
      assert.equal(probe.fileWrites.length, 0)
      if (reason === 'author-edit') {
        probe.setContent('Synthetic author edit during retrieval')
        await nextTick()
      } else {
        await probe.cancelAgentRequest()
        assert.equal(probe.searches[0].signal.aborted, true)
      }
      finish.resolve()
      const result = await execution

      assert.equal(result.status, 'failed')
      assert.notEqual(result.applied, true)
      assert.match(result.error, reason === 'author-edit' ? /作品资料或当前章节发生变化/ : /任务已停止或作品已切换/)
      assert.equal(probe.content(), reason === 'author-edit' ? 'Synthetic author edit during retrieval' : 'Synthetic original content')
      assert.equal(probe.agentState().pending, null)
      assert.equal(probe.agentState().history.length, 0)
      assert.equal(probe.checkpointWrites.length, 0)
      assert.equal(probe.fileWrites.length, 0)
    })
  }
})

test('App failed synchronous plan operation rolls back earlier operations without creating a save checkpoint', async (t) => {
  const probe = harness(t, { dirty: false })
  const before = probe.agentStoreFingerprint()
  await probe.prepareAgentPlan([
    appendOperation(),
    { action: 'append_chapter', chapterId: 'missing-synthetic-chapter', content: 'Must never be applied' },
  ])
  const result = await probe.approveAgentPlan()

  assert.equal(result.status, 'failed')
  assert.notEqual(result.applied, true)
  assert.match(result.error, /没有可写入的章节/)
  assert.equal(probe.agentStoreFingerprint(), before)
  assert.equal(probe.content(), 'Synthetic original content')
  assert.equal(probe.agentState().history.length, 0)
  assert.equal(probe.checkpointWrites.length, 0)
  assert.equal(probe.fileWrites.length, 0)
})

test('App failed Agent execution restores the pre-plan page and selection state', async (t) => {
  const probe = harness(t, { dirty: false })
  const beforeUi = {
    activePage: 'characters',
    selectedChapterId: 'chapter-test',
    selectedVolumeId: 'volume-test',
    selectedIds: { world: '', characters: 'character-before', items: '', skills: '', outline: '', style: '', api: '' },
    selectedGroupIds: { characters: 'characters-group-before' },
    ungroupedCollapsed: { characters: true },
  }
  probe.setUiState(beforeUi)
  await probe.prepareAgentPlan([
    {
      action: 'create_resource',
      resourceType: 'character',
      title: '临时角色',
      includeAllFields: true,
      fields: {
        触发策略: '', 触发键: '', 角色身份: '配角', 性别: '', 种族: '',
        性格: '', 外貌: '', 人物动机: '', 当前状态: '', 已知信息: '', 尚未知晓: '', 说话习惯: '',
      },
    },
    { action: 'create_volume', title: '临时分卷' },
    { action: 'append_chapter', chapterId: 'missing-synthetic-chapter', content: 'Must never be applied' },
  ])
  const result = await probe.approveAgentPlan()

  assert.equal(result.status, 'failed')
  assert.equal(probe.uiState().activePage, beforeUi.activePage)
  assert.deepEqual(probe.uiState().selectedIds, beforeUi.selectedIds)
  assert.deepEqual(probe.uiState().selectedGroupIds, beforeUi.selectedGroupIds)
  assert.deepEqual(probe.uiState().ungroupedCollapsed, beforeUi.ungroupedCollapsed)
  assert.equal(probe.uiState().selectedChapterId, beforeUi.selectedChapterId)
  assert.equal(probe.uiState().selectedVolumeId, beforeUi.selectedVolumeId)
})

test('Undoing an Agent plan restores the page and selection state captured before the change', async (t) => {
  const probe = harness(t, { dirty: false })
  const beforeUi = {
    activePage: 'characters',
    selectedChapterId: 'chapter-test',
    selectedVolumeId: 'volume-test',
    selectedIds: { world: '', characters: 'character-before', items: '', skills: '', outline: '', style: '', api: '' },
    selectedGroupIds: { characters: 'characters-group-before' },
    ungroupedCollapsed: { characters: true },
  }
  probe.setUiState(beforeUi)
  const plan = await probe.prepareAgentPlan([{
    action: 'create_resource',
    resourceType: 'character',
    title: '可撤销角色',
    includeAllFields: true,
    fields: {
      触发策略: '', 触发键: '', 角色身份: '配角', 性别: '', 种族: '',
      性格: '', 外貌: '', 人物动机: '', 当前状态: '', 已知信息: '', 尚未知晓: '', 说话习惯: '',
    },
  }])
  const result = await probe.approveAgentPlan()
  assert.equal(result.status, 'completed', result.error)
  assert.notDeepEqual(probe.uiState().selectedIds, beforeUi.selectedIds)

  probe.undoAgentHistory(plan.id)
  await nextTick()
  assert.deepEqual(probe.uiState().selectedIds, beforeUi.selectedIds)
  assert.deepEqual(probe.uiState().selectedGroupIds, beforeUi.selectedGroupIds)
  assert.deepEqual(probe.uiState().ungroupedCollapsed, beforeUi.ungroupedCollapsed)
  assert.equal(probe.uiState().activePage, beforeUi.activePage)
  assert.equal(probe.uiState().selectedChapterId, beforeUi.selectedChapterId)
  assert.equal(probe.uiState().selectedVolumeId, beforeUi.selectedVolumeId)
})

test('App can approve a local resource plan even after its generating API preset was removed', async (t) => {
  const probe = harness(t, { dirty: false })
  const plan = await probe.prepareAgentPlan([{
    action: 'create_resource', resourceType: 'world', title: 'Synthetic world entry',
    summary: 'Synthetic resource summary',
    includeAllFields: true,
    fields: {
      触发策略: '',
      触发键: '',
      内容: 'Synthetic world detail',
      适用范围: '',
      状态: '',
    },
  }])
  const result = await probe.executeConsole({
    action: 'approve', job: approvalJob(plan, { providerId: 'deleted-synthetic-provider' }),
  })

  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.applied, true)
  assert.equal(probe.currentStore().world.length, 1)
  assert.equal(probe.currentStore().world[0].title, 'Synthetic world entry')
  assert.equal(probe.currentStore().world[0].fields.内容, 'Synthetic world detail')
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.checkpointWrites.length, 1)
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.searches.length, 0)
})

test('App rejects a retrieval plan with no usable API before any network request or project write', async (t) => {
  for (const providerId of [undefined, 'deleted-synthetic-provider']) {
    await t.test(providerId ?? 'no-default-provider', async (subtest) => {
      const probe = harness(subtest, { dirty: false })
      const plan = await probe.prepareAgentPlan([appendOperation(), searchOperation()])
      const result = await probe.executeConsole({
        action: 'approve', job: approvalJob(plan, { providerId }),
      })

      assert.equal(result.status, 'failed')
      assert.notEqual(result.applied, true)
      assert.match(result.error, providerId ? /API 预设已删除或不可用/ : /联网整理需要先配置可用的 API/)
      assert.equal(probe.content(), 'Synthetic original content')
      assert.equal(probe.agentState().history.length, 0)
      assert.equal(probe.searches.length, 0)
      assert.equal(probe.checkpointWrites.length, 0)
      assert.equal(probe.fileWrites.length, 0)
    })
  }
})

test('App refuses saving the committed approval into a different work switched during checkpointing', async (t) => {
  const started = deferred()
  const finish = deferred()
  t.after(finish.resolve)
  const probe = harness(t, {
    dirty: false,
    async onCheckpoint() {
      started.resolve()
      await finish.promise
    },
  })
  const plan = await probe.prepareAgentPlan([appendOperation()])
  const execution = probe.executeConsole({ action: 'approve', job: approvalJob(plan) })
  await Promise.race([
    started.promise,
    execution.then((result) => { throw new Error(`Approval never reached checkpoint: ${JSON.stringify(result)}`) }),
  ])
  probe.switchProjectIdentity('another-synthetic-project')
  finish.resolve()
  const result = await execution

  assert.equal(result.status, 'failed')
  assert.equal(result.applied, true)
  assert.match(result.error, /保存前作品已切换/)
  assert.equal(probe.content(), 'Synthetic original content\n\nSynthetic Agent addition')
  assert.equal(probe.agentState().history.length, 1)
  assert.equal(probe.checkpointWrites.length, 1)
  assert.equal(probe.fileWrites.length, 0)
})

function diskConflict(path = 'C:/synthetic/portfolio.qy') {
  return {
    path, expectedRevision: 'sha256:' + 'a'.repeat(64),
    actualRevision: 'sha256:' + 'b'.repeat(64), kind: 'modified',
  }
}

test('App carries the opened file revision and advances it only after confirmed saving', async (t) => {
  const probe = harness(t)
  assert.equal(await probe.saveQyFile(), true)
  const firstRevision = probe.metadata().fileRevision
  probe.setContent('New synthetic revision')
  await nextTick()
  assert.equal(await probe.saveQyFile(), true)
  assert.equal(probe.fileWrites[0].options.expectedRevision, 'sha256:' + 'a'.repeat(64))
  assert.equal(probe.fileWrites[1].options.expectedRevision, firstRevision)
  assert.notEqual(probe.metadata().fileRevision, firstRevision)
})

test('App disk conflict preserves edits and stops repeated manual and automatic file writes', async (t) => {
  const probe = harness(t, {
    autoSaveSeconds: 5,
    onFileSave: async () => ({ canceled: false, conflict: diskConflict(), error: 'External file changed' }),
  })
  probe.setContent('Synthetic unsaved edits')
  await nextTick()
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(probe.metadata().state, '文件冲突')
  assert.equal(probe.metadata().conflictOpen, true)
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.metadata().fileRevision, 'sha256:' + 'a'.repeat(64))
  assert.equal(probe.profileWrites.length, 0)
  probe.dismissFileConflict()
  probe.setContent('More synthetic unsaved edits')
  await nextTick()
  assert.equal(await probe.runTimer(5000), false)
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(probe.metadata().conflictOpen, true)
  assert.equal(probe.content(), 'More synthetic unsaved edits')
  assert.equal(probe.fileWrites.length, 1)
})

test('App settings-only save retains a disk conflict without attempting another portfolio write', async (t) => {
  const probe = harness(t, {
    onFileSave: async () => ({ canceled: false, conflict: diskConflict(), error: 'External file changed' }),
  })
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(await probe.flushPersistence(false, { profileOnly: true }), true)
  assert.equal(probe.metadata().state, '文件冲突')
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.fileWrites.length, 1)
  assert.equal(probe.profileWrites.length, 1)
})

test('App resolves a disk conflict through Save As and keeps the latest editable content', async (t) => {
  const probe = harness(t, {
    onFileSave: async (_call, number) => number === 1
      ? { canceled: false, conflict: diskConflict(), error: 'External file changed' }
      : { canceled: false, path: 'C:/synthetic/new-copy.qy', revision: 'sha256:' + 'c'.repeat(64) },
  })
  assert.equal(await probe.saveQyFile(), false)
  probe.dismissFileConflict()
  probe.setContent('Keep these synthetic edits')
  await nextTick()
  assert.equal(await probe.resolveConflictSaveAs(), true)
  assert.equal(probe.fileWrites[1].options.saveAs, true)
  assert.equal(probe.fileWrites[1].document.projects[0].content.chapters[0].content, 'Keep these synthetic edits')
  assert.equal(probe.metadata().path, 'C:/synthetic/new-copy.qy')
  assert.equal(probe.metadata().fileConflict, null)
  assert.equal(probe.metadata().state, '已保存')
})

test('App conflict Save As recaptures edits made during the copy and continues writing the new target', async (t) => {
  const copyStarted = deferred()
  const finishCopy = deferred()
  const copyRevision = 'sha256:' + 'c'.repeat(64)
  const finalRevision = 'sha256:' + 'd'.repeat(64)
  const copyPath = 'C:/synthetic/new-copy.qy'
  const probe = harness(t, {
    onFileSave: async (_call, number) => {
      if (number === 1) return { canceled: false, conflict: diskConflict(), error: 'External file changed' }
      if (number === 2) {
        copyStarted.resolve()
        await finishCopy.promise
      }
      return { canceled: false, path: copyPath, revision: number === 2 ? copyRevision : finalRevision }
    },
  })
  probe.setContent('Synthetic draft before resolving the conflict')
  await nextTick()
  assert.equal(await probe.saveQyFile(), false)
  const savingCopy = probe.resolveConflictSaveAs()
  await copyStarted.promise
  probe.setContent('Synthetic latest edit while the new copy is writing')
  await nextTick()
  finishCopy.resolve()
  assert.equal(await savingCopy, true)
  assert.equal(probe.fileWrites.length, 3, 'the latest generation must reach the newly saved file')
  assert.equal(probe.fileWrites[1].options.saveAs, true)
  assert.equal(probe.fileWrites[1].document.projects[0].content.chapters[0].content, 'Synthetic draft before resolving the conflict')
  assert.equal(probe.fileWrites[2].options.saveAs, false, 'the retry reuses the new file without reopening the picker')
  assert.equal(probe.fileWrites[2].currentPath, copyPath)
  assert.equal(probe.fileWrites[2].options.expectedRevision, copyRevision)
  assert.equal(probe.fileWrites[2].document.projects[0].content.chapters[0].content, 'Synthetic latest edit while the new copy is writing')
  assert.equal(probe.metadata().path, copyPath)
  assert.equal(probe.metadata().fileRevision, finalRevision)
  assert.equal(probe.metadata().fileConflict, null)
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().state, '已保存')
})

test('App ignores an old conflict Save As reply after a newer conflict is reported', async (t) => {
  const copyStarted = deferred()
  const finishCopy = deferred()
  const newerConflict = { ...diskConflict(), actualRevision: 'sha256:' + 'e'.repeat(64) }
  const probe = harness(t, {
    onFileSave: async (_call, number) => {
      if (number === 1) return { canceled: false, conflict: diskConflict(), error: 'Original external file change' }
      copyStarted.resolve()
      await finishCopy.promise
      return { canceled: false, path: 'C:/synthetic/stale-copy.qy', revision: 'sha256:' + 'c'.repeat(64) }
    },
  })
  probe.setContent('Synthetic draft protected by the newer conflict')
  await nextTick()
  assert.equal(await probe.saveQyFile(), false)
  const savingCopy = probe.resolveConflictSaveAs()
  await copyStarted.promise
  probe.reportFileConflict(newerConflict)
  finishCopy.resolve()
  assert.equal(await savingCopy, false)
  assert.deepEqual(probe.metadata().fileConflict, newerConflict, 'the stale reply cannot clear a later report')
  assert.equal(probe.metadata().conflictOpen, true)
  assert.equal(probe.metadata().path, 'C:/synthetic/portfolio.qy', 'the stale copy must not become the active file')
  assert.equal(probe.metadata().fileRevision, 'sha256:' + 'a'.repeat(64))
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.content(), 'Synthetic draft protected by the newer conflict')
  assert.equal(probe.baselineContent(), undefined, 'ignored replies cannot replace the confirmed baseline')
  assert.equal(probe.profileWrites.length, 0, 'ignored replies cannot update local profile bindings')
})

test('App invalidates a queued conflict Save As before native writing when a newer conflict arrives', async (t) => {
  const newerConflict = { ...diskConflict(), actualRevision: 'sha256:' + 'e'.repeat(64) }
  const probe = harness(t, {
    onFileSave: async (_call, number) => number === 1
      ? { canceled: false, conflict: diskConflict(), error: 'Original external file change' }
      : { canceled: false, path: 'C:/synthetic/stale-copy.qy', revision: 'sha256:' + 'c'.repeat(64) },
  })
  probe.setContent('Synthetic edits retained while replacing the queued conflict')
  await nextTick()
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(probe.fileWrites.length, 1)
  const savingCopy = probe.resolveConflictSaveAs()
  // No await here: replace the report in the same turn, before the shared
  // queue begins its write or a native picker can be requested.
  probe.reportFileConflict(newerConflict)
  assert.equal(await savingCopy, false)
  assert.equal(probe.fileWrites.length, 1, 'the invalidated Save As must not request native writing')
  assert.deepEqual(probe.metadata().fileConflict, newerConflict)
  assert.equal(probe.metadata().conflictOpen, true)
  assert.equal(probe.metadata().path, 'C:/synthetic/portfolio.qy')
  assert.equal(probe.metadata().fileRevision, 'sha256:' + 'a'.repeat(64))
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.content(), 'Synthetic edits retained while replacing the queued conflict')
  assert.equal(probe.baselineContent(), undefined)
  assert.equal(probe.profileWrites.length, 0)
})

test('App ignores an old save reply when the portfolio identity or file path changes during writing', async (t) => {
  for (const changed of ['path', 'portfolioId']) {
    await t.test(changed, async (t) => {
      const writeStarted = deferred()
      const finishWrite = deferred()
      const newRevision = 'sha256:' + 'f'.repeat(64)
      const probe = harness(t, {
        onFileSave: async () => {
          writeStarted.resolve()
          await finishWrite.promise
          return { canceled: false, path: 'C:/synthetic/portfolio.qy', revision: 'sha256:' + 'c'.repeat(64) }
        },
      })
      const saving = probe.saveQyFile()
      await writeStarted.promise
      const identity = changed === 'path'
        ? { path: 'C:/synthetic/other-portfolio.qy', revision: newRevision }
        : { portfolioId: 'other-portfolio-test', revision: newRevision }
      probe.switchPortfolioFileIdentity(identity)
      probe.setContent('Synthetic new target content that the old reply must not replace')
      await nextTick()
      finishWrite.resolve()
      assert.equal(await saving, false)
      assert.equal(probe.metadata().path, identity.path || 'C:/synthetic/portfolio.qy')
      assert.equal(probe.metadata().portfolioId, identity.portfolioId || 'portfolio-test')
      assert.equal(probe.metadata().fileRevision, newRevision, 'the old file revision cannot be assigned to a new target')
      assert.equal(probe.metadata().qyFileDirty, true)
      assert.equal(probe.content(), 'Synthetic new target content that the old reply must not replace')
      assert.equal(probe.baselineContent(), undefined)
      assert.equal(probe.profileWrites.length, 0)
      assert.equal(probe.metadata().fileConflict, null)
    })
  }
})

test('App conflict Save As keeps the new copy writable after saving a newer generation fails', async (t) => {
  const copyStarted = deferred()
  const finishCopy = deferred()
  const copyPath = 'C:/synthetic/new-copy.qy'
  const copyRevision = 'sha256:' + 'c'.repeat(64)
  const retryRevision = 'sha256:' + 'd'.repeat(64)
  const probe = harness(t, {
    onFileSave: async (_call, number) => {
      if (number === 1) return { canceled: false, conflict: diskConflict(), error: 'External file changed' }
      if (number === 2) {
        copyStarted.resolve()
        await finishCopy.promise
        return { canceled: false, path: copyPath, revision: copyRevision }
      }
      if (number === 3) return { canceled: false, error: 'Synthetic follow-up disk failure' }
      return { canceled: false, path: copyPath, revision: retryRevision }
    },
  })
  probe.setContent('Synthetic draft confirmed in the new copy')
  await nextTick()
  assert.equal(await probe.saveQyFile(), false)
  const savingCopy = probe.resolveConflictSaveAs()
  await copyStarted.promise
  probe.setContent('Synthetic latest edits that must survive a failed follow-up')
  await nextTick()
  finishCopy.resolve()
  assert.equal(await savingCopy, false)
  assert.equal(probe.metadata().path, copyPath)
  assert.equal(probe.metadata().fileRevision, copyRevision, 'a failed follow-up cannot advance the disk revision')
  assert.equal(probe.metadata().fileConflict, null, 'the former source conflict was resolved by the confirmed copy')
  assert.equal(probe.metadata().conflictOpen, false)
  assert.equal(probe.metadata().qyFileDirty, true)
  assert.equal(probe.metadata().state, '保存失败')
  assert.match(probe.metadata().fileError, /follow-up disk failure/)
  assert.equal(probe.baselineContent(), 'Synthetic draft confirmed in the new copy')
  assert.equal(probe.content(), 'Synthetic latest edits that must survive a failed follow-up')
  assert.equal(probe.fileWrites[2].currentPath, copyPath)
  assert.equal(probe.fileWrites[2].options.expectedRevision, copyRevision)

  assert.equal(await probe.saveQyFile(), true, 'ordinary Save can retry the new target')
  assert.equal(probe.fileWrites.length, 4)
  assert.equal(probe.fileWrites[3].currentPath, copyPath)
  assert.equal(probe.fileWrites[3].options.saveAs, false)
  assert.equal(probe.fileWrites[3].options.expectedRevision, copyRevision)
  assert.equal(probe.fileWrites[3].document.projects[0].content.chapters[0].content, 'Synthetic latest edits that must survive a failed follow-up')
  assert.equal(probe.metadata().fileRevision, retryRevision)
  assert.equal(probe.metadata().fileConflict, null)
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().state, '已保存')
})

test('App conflict Save As resolves the source conflict when the copy succeeds but profile saving fails', async (t) => {
  const copyPath = 'C:/synthetic/new-copy.qy'
  const copyRevision = 'sha256:' + 'c'.repeat(64)
  const nextRevision = 'sha256:' + 'd'.repeat(64)
  const probe = harness(t, {
    profileFailure: 'Synthetic profile failure after confirmed copy',
    onFileSave: async (_call, number) => number === 1
      ? { canceled: false, conflict: diskConflict(), error: 'External file changed' }
      : { canceled: false, path: copyPath, revision: number === 2 ? copyRevision : nextRevision },
  })
  probe.setContent('Synthetic edits safely written into the new copy')
  await nextTick()
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(await probe.resolveConflictSaveAs(), false)
  assert.equal(probe.metadata().path, copyPath)
  assert.equal(probe.metadata().fileRevision, copyRevision)
  assert.equal(probe.metadata().fileConflict, null)
  assert.equal(probe.metadata().conflictOpen, false)
  assert.equal(probe.metadata().qyFileDirty, false)
  assert.equal(probe.metadata().profileDirty, true)
  assert.equal(probe.metadata().autoSaveDirty, true)
  assert.equal(probe.metadata().state, '保存失败')
  assert.match(probe.metadata().profileError, /作品已写入 \.qy/)
  assert.match(probe.metadata().profileError, /profile failure after confirmed copy/)
  assert.equal(probe.baselineContent(), 'Synthetic edits safely written into the new copy')
  assert.equal(probe.content(), 'Synthetic edits safely written into the new copy')

  probe.setProfileFailure(undefined)
  assert.equal(await probe.flushPersistence(false, { profileOnly: true }), true)
  assert.equal(probe.fileWrites.length, 2, 'retrying the independent profile must not rewrite the portfolio')
  assert.equal(probe.metadata().profileDirty, false)
  assert.equal(probe.metadata().state, '已保存')

  probe.setContent('Synthetic later edits saved normally to the copy')
  await nextTick()
  assert.equal(await probe.saveQyFile(), true)
  assert.equal(probe.fileWrites[2].currentPath, copyPath)
  assert.equal(probe.fileWrites[2].options.saveAs, false)
  assert.equal(probe.fileWrites[2].options.expectedRevision, copyRevision)
  assert.equal(probe.fileWrites[2].document.projects[0].content.chapters[0].content, 'Synthetic later edits saved normally to the copy')
  assert.equal(probe.metadata().fileRevision, nextRevision)
  assert.equal(probe.metadata().fileConflict, null)
  assert.equal(probe.metadata().qyFileDirty, false)
})

test('App canceled conflict Save As retains the original target and dirty edits', async (t) => {
  const probe = harness(t, {
    onFileSave: async (_call, number) => number === 1
      ? { canceled: false, conflict: diskConflict(), error: 'External file changed' }
      : { canceled: true },
  })
  assert.equal(await probe.saveQyFile(), false)
  assert.equal(await probe.resolveConflictSaveAs(), false)
  assert.equal(probe.metadata().path, 'C:/synthetic/portfolio.qy')
  assert.ok(probe.metadata().fileConflict)
  assert.equal(probe.metadata().qyFileDirty, true)
})

test('App closing during disk conflict cancels close and exposes the conflict choices', async (t) => {
  const probe = harness(t, {
    onFileSave: async () => ({ canceled: false, conflict: diskConflict(), error: 'External file changed' }),
  })
  await probe.close()
  assert.equal(probe.closeResponses[0].saved, false)
  assert.equal(probe.closeResponses[0].canceled, true)
  assert.equal(probe.metadata().conflictOpen, true)
  assert.equal(probe.metadata().flushing, false)
  assert.equal(probe.metadata().qyFileDirty, true)
})
