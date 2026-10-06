import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDesktopProfile,
  DesktopProfileValidationError,
  isDesktopProfile,
  parseDesktopProfile,
  profileProjectSession,
} from '../src/data/desktopProfile.ts'
import { cloneThemeSettings, defaultThemeSettings } from '../src/data/theme.ts'
import { defaultStandardCreationPromptHints } from '../src/agent/resourceStructure.ts'

function sessionSource(label = 'a') {
  const message = { id: `message-${label}`, role: 'user', content: `对话 ${label}`, createdAt: 3 }
  return {
    selectedChapterId: `chapter-${label}`,
    selectedVolumeId: `volume-${label}`,
    selectedIds: { characters: `character-${label}` },
    agentProviderId: 'provider-one',
    writerProviderId: 'provider-two',
    worldEngineProviderId: '',
    agentMode: 'inspiration',
    agentHistory: [{
      id: `history-${label}`,
      summary: '原本的历史',
      changes: ['创建角色'],
      status: 'applied',
      createdAt: 2,
      source: 'console',
      reviews: [{
        operationIndex: 0,
        action: 'update_resource',
        kind: 'update',
        title: '角色卡',
        target: 'characters/character-a',
        diffs: [{ field: '性格', before: '谨慎', after: '坚定', status: 'changed' }],
      }],
      snapshot: { chapters: [{ id: `old-${label}`, content: '历史正文' }], style: [] },
      afterFingerprint: 'fingerprint',
    }],
    agentMessages: [message],
    agentConversations: [{ id: `conversation-${label}`, title: '我的对话', createdAt: 2, updatedAt: 3, messages: [message] }],
    activeAgentConversationId: `conversation-${label}`,
  }
}

function legacyState(label = 'a') {
  const session = sessionSource(label)
  const theme = cloneThemeSettings(defaultThemeSettings)
  theme.mode = 'dark'
  theme.dark.button = '#eebb11'
  const hints = defaultStandardCreationPromptHints()
  hints.character['性格'] = '保留用户自定义的性格说明。'
  return {
    version: 2,
    updatedAt: 42,
    currentProjectId: 'project-one',
    projects: [{
      id: 'project-one',
      title: `作品 ${label}`,
      snapshot: { ...session, store: { chapters: [{ content: '实时项目正文' }], world: [{ title: '实时世界书' }] } },
    }],
    store: {
      chapters: [{ content: '实时全局正文' }],
      world: [{ title: '实时世界书' }],
      style: [{ title: '实时文风规则' }],
      providers: [{ id: 'provider-one', title: '我的 API', tag: '可用', summary: '', enabled: true, fields: { 协议: 'OpenAI Compatible', 接口地址: 'https://example.test/v1', 'API Key': 'secret-key', 模型: 'model-one', 流式输出: 'true' } }],
      modelOptions: { 'provider-one': ['model-one', 'model-two'] },
    },
    currentWorkTitle: '不应写入设置的作品标题',
    style: [{ title: '不应重复写入的文风' }],
    sharedContent: { styleRules: [{ title: '不应重复写入的共享文风' }] },
    ui: {
      activePage: 'characters',
      agentPosition: { x: 31, y: 72 },
      selectedChapterId: 'latest-chapter',
      selectedVolumeId: 'latest-volume',
      selectedIds: { characters: 'latest-character' },
      agentProviderId: 'provider-latest',
      writerProviderId: 'provider-two',
      worldEngineProviderId: '',
      currentWorkTitle: '另一个不应写入设置的作品名',
    },
    ...session,
    agentHistoryLimit: 50,
    settings: {
      autoSaveSeconds: 30,
      formatIndentSpaces: 4,
      qyBackupCount: 0,
      theme,
      resourcePromptHints: hints,
      style: [{ title: '不应作为软件设置的文风' }],
      unknown: '不应透传额外设置',
    },
  }
}

test('desktop profile retains API presets and all global settings without real-time work copies', () => {
  const state = legacyState()
  const before = structuredClone(state)
  const profile = createDesktopProfile(state, { portfolioId: 'portfolio-a', filePath: 'E:\\Books\\a.qy' })

  assert.equal(profile.version, 1)
  assert.equal(profile.kind, 'desktop-profile')
  assert.equal(profile.updatedAt, 42)
  assert.deepEqual(profile.providers, state.store.providers)
  assert.deepEqual(profile.modelOptions, state.store.modelOptions)
  assert.equal(profile.settings.autoSaveSeconds, 30)
  assert.equal(profile.settings.formatIndentSpaces, 4)
  assert.equal(profile.settings.qyBackupCount, 0)
  assert.deepEqual(profile.settings.theme, state.settings.theme)
  assert.deepEqual(profile.settings.resourcePromptHints, state.settings.resourcePromptHints)
  assert.deepEqual(profile.ui, { activePage: 'characters', agentPosition: { x: 31, y: 72 } })
  assert.deepEqual(profile.activePortfolio, { id: 'portfolio-a', path: 'E:\\Books\\a.qy' })
  const session = profileProjectSession(profile, 'portfolio-a', 'project-one')
  assert.equal(session.selectedChapterId, 'latest-chapter')
  assert.equal(session.agentProviderId, 'provider-latest')
  assert.deepEqual(session.agentHistory, state.agentHistory)
  assert.equal(session.agentHistory[0].source, 'console')
  assert.equal(session.agentHistory[0].reviews[0].diffs[0].field, '性格')
  assert.deepEqual(session.agentConversations, state.agentConversations)
  assert.equal('store' in profile, false)
  assert.equal('projects' in profile, false)
  assert.equal('currentWorkTitle' in profile, false)
  assert.equal('sharedContent' in profile, false)
  assert.equal('style' in profile.settings, false)
  assert.equal('store' in session, false)
  assert.equal(JSON.stringify(profile).includes('实时'), false)
  assert.equal(JSON.stringify(profile).includes('不应'), false)
  assert.equal(JSON.stringify(profile).includes('历史正文'), true)
  assert.deepEqual(state, before)
  profile.providers[0].fields['API Key'] = 'changed'
  session.agentHistory[0].snapshot.chapters[0].content = 'changed history'
  assert.deepEqual(state, before)
  assert.equal(profile.projectSessions['portfolio-a:project-one'].agentHistory[0].snapshot.chapters[0].content, '历史正文')
})

test('composite sessions preserve another portfolio and isolate identical project IDs', () => {
  const first = createDesktopProfile(legacyState('a'), { portfolioId: 'portfolio-a', filePath: 'E:\\Books\\a.qy' })
  const previous = structuredClone(first.projectSessions)
  const second = createDesktopProfile(legacyState('b'), {
    portfolioId: 'portfolio-b',
    filePath: 'E:\\Books\\b.qy',
    previousSessions: first.projectSessions,
  })
  assert.deepEqual(Object.keys(second.projectSessions), ['portfolio-a:project-one', 'portfolio-b:project-one'])
  assert.deepEqual(first.projectSessions, previous)
  assert.equal(profileProjectSession(second, 'portfolio-a', 'project-one').agentMessages[0].content, '对话 a')
  assert.equal(profileProjectSession(second, 'portfolio-b', 'project-one').agentMessages[0].content, '对话 b')
  assert.equal(profileProjectSession(second, 'portfolio-missing', 'project-one'), undefined)
})

test('save as keeps sessions for the same portfolio identity and only changes its file path', () => {
  const state = legacyState()
  const first = createDesktopProfile(state, { portfolioId: 'portfolio-a', filePath: 'E:\\Books\\a.qy' })
  const savedAs = createDesktopProfile(state, {
    portfolioId: 'portfolio-a',
    filePath: 'E:\\Books\\a-copy.qy',
    previousSessions: first.projectSessions,
  })
  assert.deepEqual(savedAs.projectSessions, first.projectSessions)
  assert.equal(savedAs.activePortfolio.path, 'E:\\Books\\a-copy.qy')
})

test('empty profile defaults are complete and no identity creates no unscoped project session', () => {
  const profile = createDesktopProfile({})
  assert.equal(profile.activePortfolio, null)
  assert.deepEqual(profile.projectSessions, {})
  assert.deepEqual(profile.settings.theme, defaultThemeSettings)
  assert.deepEqual(profile.settings.resourcePromptHints, defaultStandardCreationPromptHints())
  assert.equal(isDesktopProfile(profile), true)

  const unscoped = createDesktopProfile(legacyState())
  assert.deepEqual(unscoped.projectSessions, {})
})

test('profile creation saves inactive work session metadata without copying their content', () => {
  const state = legacyState('a')
  state.projects.push({ id: 'project-two', title: '第二部', snapshot: { ...sessionSource('b'), store: { chapters: [{ content: '实时第二部正文' }] } } })
  const profile = createDesktopProfile(state, { portfolioId: 'portfolio-a', filePath: 'a.qy' })
  assert.equal(profileProjectSession(profile, 'portfolio-a', 'project-two').selectedChapterId, 'chapter-b')
  assert.equal('store' in profile.projectSessions['portfolio-a:project-two'], false)
})

test('parsing rejects corrupt profile structures and forbidden live work fields', () => {
  const profile = createDesktopProfile(legacyState(), { portfolioId: 'portfolio-a', filePath: 'a.qy' })
  const mutations = [
    (value) => { value.version = 2 },
    (value) => { value.kind = 'qy' },
    (value) => { value.providers = null },
    (value) => { value.providers[0].fields['API Key'] = 42 },
    (value) => { value.modelOptions['provider-one'] = 'model-one' },
    (value) => { delete value.settings.qyBackupCount },
    (value) => { value.settings.theme.dark.button = 'bad-color' },
    (value) => { value.settings.resourcePromptHints.character['性格'] = 42 },
    (value) => { value.ui.agentPosition.x = '31' },
    (value) => { value.activePortfolio.path = '' },
    (value) => { value.projectSessions['portfolio-a:project-one'].agentMessages = 'bad messages' },
    (value) => { value.projectSessions['portfolio-a:project-one'].activeAgentConversationId = 'missing' },
    (value) => { value.projectSessions['portfolio-a:project-one'].agentHistory[0].snapshot = {} },
    (value) => { value.projectSessions['portfolio-a:project-one'].agentHistory[0].source = 'unknown' },
    (value) => { value.projectSessions['portfolio-a:project-one'].agentHistory[0].reviews[0].diffs[0].status = 'unknown' },
    (value) => { value.store = { chapters: [] } },
    (value) => { value.projects = [] },
    (value) => { value.projectSessions['portfolio-a:project-one'].store = { chapters: [] } },
    (value) => { value.settings.style = [] },
  ]
  for (const mutate of mutations) {
    const corrupted = structuredClone(profile)
    mutate(corrupted)
    assert.equal(isDesktopProfile(corrupted), false)
    assert.throws(() => parseDesktopProfile(corrupted), DesktopProfileValidationError)
  }
  assert.throws(() => parseDesktopProfile(null), DesktopProfileValidationError)
  assert.throws(() => parseDesktopProfile({}), DesktopProfileValidationError)
})

test('profile parsing returns an independent copy and preserves full working records', () => {
  const profile = createDesktopProfile(legacyState(), { portfolioId: 'portfolio-a', filePath: 'a.qy' })
  const parsed = parseDesktopProfile(profile)
  assert.deepEqual(parsed, profile)
  parsed.projectSessions['portfolio-a:project-one'].agentMessages[0].content = 'changed'
  parsed.settings.theme.dark.button = '#ffffff'
  assert.equal(profile.projectSessions['portfolio-a:project-one'].agentMessages[0].content, '对话 a')
  assert.equal(profile.settings.theme.dark.button, '#eebb11')
})

test('desktop profile accepts compact patch-only Agent history entries', () => {
  const state = legacyState('patch')
  delete state.agentHistory[0].snapshot
  state.agentHistory[0].patch = [{ op: 'replace', path: '/chapters/0/content', value: '历史正文' }]
  const profile = createDesktopProfile(state, { portfolioId: 'portfolio-patch', filePath: 'patch.qy' })
  const session = profileProjectSession(profile, 'portfolio-patch', 'project-one')
  assert.equal(session.agentHistory[0].snapshot, undefined)
  assert.deepEqual(session.agentHistory[0].patch, state.agentHistory[0].patch)
  assert.equal(isDesktopProfile(profile), true)
})
