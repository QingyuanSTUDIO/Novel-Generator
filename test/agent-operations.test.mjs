import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computed, ref } from 'vue'
import { createAgentOperations } from '../src/agent/operations.ts'

function createStore() {
  return {
    schemaVersion: 8,
    volumes: [{ id: 'volume-1', title: '第一卷', collapsed: false }],
    chapters: [{ id: 'ch-8', title: '08 当前章节', status: '草稿', content: '正文', wordCount: 2, volumeId: 'volume-1' }],
    world: [],
    characters: [{ id: 'char-shen', title: '沈砚', tag: '主角', summary: '', fields: { 角色身份: '主角' } }],
    items: [],
    skills: [],
    outline: [],
    style: [],
    providers: [],
    modelOptions: {},
    contextBlocks: [],
    resourceGroups: { world: [], characters: [], items: [], skills: [], style: [] },
  }
}

function createOperations(storeState = createStore(), insertResource = () => { throw new Error('not used in this test') }) {
  const store = ref(storeState)
  const activeChapter = computed(() => store.value.chapters.find((chapter) => chapter.id === 'ch-8'))
  const selectedGroupIds = ref({ world: '', characters: '', items: '', skills: '', style: '' })
  const selectedVolumeId = ref('volume-1')
  const selectedChapterId = ref('ch-8')
  const chapterSearch = ref('线索')
  const candidate = ref('候选正文')
  const pages = { world: 'world', character: 'characters', item: 'items', skill: 'skills', outline: 'outline', world_event: 'worldEngine', style: 'style' }
  const operations = createAgentOperations({
    store,
    activeChapter,
    selectedGroupIds,
    selectedVolumeId,
    selectedChapterId,
    chapterSearch,
    candidate,
    agentPageForType: (type) => pages[type],
    insertResource,
  })
  return { store, selectedGroupIds, chapterSearch, candidate, operations }
}

test('creates, assigns and removes a resource group while preserving its cards', () => {
  const { store, selectedGroupIds, operations } = createOperations()

  operations.applyAgentOperation({ action: 'create_resource_group', collection: 'characters', title: '主要角色' })
  const group = store.value.resourceGroups.characters[0]
  selectedGroupIds.value.characters = group.id
  operations.applyAgentOperation({ action: 'move_resource_to_group', collection: 'characters', target: 'char-shen', groupTarget: '主要角色' })

  assert.equal(store.value.characters.find((item) => item.id === 'char-shen').groupId, group.id)
  operations.applyAgentOperation({ action: 'delete_resource_group', collection: 'characters', target: group.id })

  assert.equal(store.value.resourceGroups.characters.length, 0)
  assert.equal(store.value.characters.find((item) => item.id === 'char-shen').groupId, undefined)
  assert.equal(selectedGroupIds.value.characters, '')
})

test('creates a chapter in the selected volume and clears chapter search and candidate', () => {
  const { store, chapterSearch, candidate, operations } = createOperations()

  operations.applyAgentOperation({ action: 'create_chapter', title: '09 新的章节' })

  const created = store.value.chapters.at(-1)
  assert.equal(created.title, '09 新的章节')
  assert.equal(created.volumeId, 'volume-1')
  assert.equal(store.value.volumes[0].collapsed, false)
  assert.equal(chapterSearch.value, '')
  assert.equal(candidate.value, '')
})

test('blocks updates to an entirely locked resource and preserves its data', () => {
  const lockedCharacter = {
    id: 'char-locked',
    title: '锁定角色',
    tag: '配角',
    summary: '原摘要',
    fields: { 角色身份: '配角', 状态: '正常' },
    reviewStatus: 'pending',
    lockedAll: true,
  }
  const storeState = createStore()
  storeState.characters.push(lockedCharacter)
  const { operations } = createOperations(storeState)

  assert.throws(() => operations.applyAgentOperation({
    action: 'update_resource',
    resourceType: 'character',
    target: 'char-locked',
    title: '被改名',
    summary: '被改摘要',
    fields: { 状态: '受伤' },
    reviewStatus: 'complete',
  }), /整体锁定/)
  assert.equal(lockedCharacter.title, '锁定角色')
  assert.equal(lockedCharacter.summary, '原摘要')
  assert.equal(lockedCharacter.fields['状态'], '正常')
  assert.equal(lockedCharacter.reviewStatus, 'pending')
})

test('review status lock blocks only the status change while unlocked status remains agent-editable', () => {
  const character = {
    id: 'char-review',
    title: '林舟',
    tag: '主角',
    summary: '旧摘要',
    fields: { 角色身份: '主角' },
    reviewStatus: 'pending',
    reviewStatusLocked: true,
  }
  const storeState = createStore()
  storeState.characters.push(character)
  const { operations } = createOperations(storeState)

  const lockedResult = operations.applyAgentOperation({
    action: 'update_resource',
    resourceType: 'character',
    target: 'char-review',
    summary: '新摘要',
    reviewStatus: 'complete',
  })
  assert.match(lockedResult, /跳过锁定内容：校对状态/)
  assert.equal(character.summary, '新摘要')
  assert.equal(character.reviewStatus, 'pending')

  character.reviewStatusLocked = false
  operations.applyAgentOperation({
    action: 'update_resource',
    resourceType: 'character',
    target: 'char-review',
    reviewStatus: 'complete',
  })
  assert.equal(character.reviewStatus, 'complete')
})

test('an entirely locked resource cannot be moved or implicitly ungrouped by deleting its group', () => {
  const storeState = createStore()
  const group = { id: 'characters-group-1', title: '角色组', collapsed: false }
  storeState.resourceGroups.characters.push(group)
  storeState.characters[0].groupId = group.id
  storeState.characters[0].lockedAll = true
  const { operations } = createOperations(storeState)

  assert.throws(() => operations.applyAgentOperation({
    action: 'move_resource_to_group',
    collection: 'characters',
    target: 'char-shen',
    groupTarget: null,
  }), /整体锁定/)
  assert.throws(() => operations.applyAgentOperation({
    action: 'delete_resource_group',
    collection: 'characters',
    target: group.id,
  }), /已锁定条目/)
  assert.equal(storeState.characters[0].groupId, group.id)
  assert.equal(storeState.resourceGroups.characters.length, 1)
})

test('agent-created resources are marked with their creation source', () => {
  const storeState = createStore()
  const created = { id: 'item-1', title: '铜钥匙', tag: '', summary: '', fields: {} }
  const { operations } = createOperations(storeState, () => {
    storeState.items.push(created)
    return created
  })

  operations.applyAgentOperation({ action: 'create_resource', resourceType: 'item', title: '铜钥匙' })
  assert.equal(created.creationSource, 'agent')
})

test('normalizes English world-book fields and always strategy during creation', () => {
  const storeState = createStore()
  const created = { id: 'world-1', title: '天玄宗', tag: '', summary: '', fields: {} }
  const { operations } = createOperations(storeState, (page, title, summary, fields) => {
    created.title = title
    created.summary = summary ?? ''
    created.fields = fields ?? {}
    storeState.world.push(created)
    return created
  })

  operations.applyAgentOperation({
    action: 'create_resource',
    resourceType: 'world',
    title: '天玄宗',
    fields: {
      triggerStrategy: 'always',
      triggerKeys: '天玄宗, 宗门',
      content: '一个隐世宗门。',
      scope: '全书',
      status: '稳定',
    },
  })

  assert.equal(created.fields['触发策略'], '常驻')
  assert.equal(created.fields['触发键'], '天玄宗、宗门')
  assert.equal(created.fields['内容'], '一个隐世宗门。')
  assert.equal(created.fields.scope, undefined)
  assert.equal(created.retrieval?.triggerStrategy, 'always')
})

test('normalizes English fields during updates and keeps trigger aliases out of storage', () => {
  const storeState = createStore()
  const world = {
    id: 'world-existing',
    title: '旧世界',
    tag: '',
    summary: '',
    fields: { 触发策略: '关键词', 触发键: '' },
  }
  storeState.world.push(world)
  const { operations } = createOperations(storeState)

  operations.applyAgentOperation({
    action: 'update_resource',
    resourceType: 'world',
    target: world.id,
    fields: {
      triggerStrategy: 'always',
      triggerKeys: '旧世界',
      content: '新的设定。',
    },
  })

  assert.equal(world.fields['触发策略'], '常驻')
  assert.equal(world.fields['触发键'], '旧世界')
  assert.equal(world.fields['内容'], '新的设定。')
  assert.equal(world.fields.triggerStrategy, undefined)
  assert.equal(world.retrieval?.triggerStrategy, 'always')
})

test('world engine events follow the same whole-item and review-status lock rules', () => {
  const storeState = createStore()
  const event = {
    id: 'event-1',
    kind: 'event',
    title: '城门失守',
    summary: '原事件',
    status: 'planned',
    actorIds: [],
    consequences: [],
    evidence: [],
    updatedAt: 1,
    reviewStatus: 'pending',
    reviewStatusLocked: true,
  }
  storeState.worldEngine = { events: [event], updatedAt: 1 }
  const { operations } = createOperations(storeState)

  const lockedStatusResult = operations.applyAgentOperation({
    action: 'update_resource',
    resourceType: 'world_event',
    target: event.id,
    summary: '新事件',
    reviewStatus: 'complete',
  })
  assert.match(lockedStatusResult, /跳过锁定内容：校对状态/)
  assert.equal(event.summary, '新事件')
  assert.equal(event.reviewStatus, 'pending')

  event.reviewStatusLocked = false
  operations.applyAgentOperation({
    action: 'update_resource',
    resourceType: 'world_event',
    target: event.id,
    reviewStatus: 'complete',
  })
  assert.equal(event.reviewStatus, 'complete')

  event.lockedAll = true
  assert.throws(() => operations.applyAgentOperation({
    action: 'update_resource',
    resourceType: 'world_event',
    target: event.id,
    summary: '不应写入',
  }), /整体锁定/)
  assert.equal(event.summary, '新事件')
})
