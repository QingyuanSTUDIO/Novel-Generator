import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateEnabledContextTokens, syncContextResourceItems } from '../src/data/seed.ts'

function createStore() {
  return {
    schemaVersion: 10,
    volumes: [],
    chapters: [],
    world: [],
    characters: [],
    items: [],
    skills: [],
    outline: [],
    style: [],
    providers: [],
    modelOptions: {},
    contextBlocks: [],
    contextGroups: [],
    resourceGroups: { world: [], characters: [], items: [], skills: [], style: [] },
    customModules: { schemas: [], entries: [] },
    memes: { entries: [], candidates: [], searchHistory: [] },
  }
}

function contextItem(extra = {}) {
  return {
    id: 'ctx-custom-faction',
    title: '势力卡',
    source: '自定义模块',
    role: 'system',
    tokens: 20,
    enabled: true,
    collection: 'custom',
    customModuleId: 'faction',
    ...extra,
  }
}

function contextGroup(id, collection, items = []) {
  return {
    id,
    title: id,
    source: id,
    role: 'system',
    tokens: 20,
    enabled: true,
    collection,
    collapsed: true,
    items,
  }
}

function addFaction(store) {
  store.customModules.schemas.push({
    id: 'faction',
    type: '势力卡',
    title: '势力卡',
    description: '势力资料',
    fields: [{ id: 'name', key: '名称', label: '名称', type: 'string' }],
  })
}

test('repairs a custom module item dragged into the world block', () => {
  const store = createStore()
  addFaction(store)
  const stray = contextItem({ id: 'stray-faction', enabled: false })
  store.contextGroups = [
    contextGroup('ctx-world', 'world', [stray]),
    contextGroup('ctx-custom', 'custom'),
  ]

  syncContextResourceItems(store)

  const world = store.contextGroups.find((group) => group.collection === 'world')
  const custom = store.contextGroups.find((group) => group.collection === 'custom')
  assert.ok(world)
  assert.ok(custom)
  assert.equal(world.items.some((item) => item.customModuleId === 'faction'), false)
  assert.equal(custom.items.filter((item) => item.customModuleId === 'faction').length, 1)
  assert.equal(custom.items[0].enabled, false)
  assert.equal(custom.items[0].collection, 'custom')
})

test('removes a standard resource accidentally placed in the custom block', () => {
  const store = createStore()
  addFaction(store)
  store.world = [{ id: 'world-1', title: '雾港', tag: '世界书', summary: '', fields: {} }]
  store.contextGroups = [
    contextGroup('ctx-world', 'world'),
    contextGroup('ctx-custom', 'custom', [{
      id: 'ctx-world-1',
      title: '雾港',
      source: '世界书',
      role: 'system',
      tokens: 20,
      enabled: true,
      collection: 'world',
      resourceId: 'world-1',
    }]),
  ]

  syncContextResourceItems(store)

  const custom = store.contextGroups.find((group) => group.collection === 'custom')
  assert.ok(custom)
  assert.equal(custom.items.some((item) => item.resourceId === 'world-1'), false)
})

test('recomputes resource and group tokens from current content instead of persisted values', () => {
  const store = createStore()
  store.world = [{
    id: 'world-1',
    title: '雾港',
    tag: '世界书',
    summary: '短摘要',
    fields: { 内容: '短内容' },
  }]
  store.contextGroups = [
    contextGroup('ctx-world', 'world', [{
      id: 'ctx-world-1',
      title: '旧标题',
      source: '旧来源',
      role: 'system',
      tokens: 99999,
      enabled: true,
      collection: 'world',
      resourceId: 'world-1',
    }]),
  ]

  syncContextResourceItems(store)
  const first = store.contextGroups.find((group) => group.collection === 'world')
  assert.ok(first)
  const firstTokens = first.items[0].tokens
  assert.ok(firstTokens > 0)
  assert.ok(firstTokens < 99999)
  assert.equal(first.tokens, firstTokens)

  store.world[0].summary = '这是一段明显更长的摘要，用来验证内容变化会让上下文编排重新计算，而不是继续沿用旧的 tokens 数字。'
  syncContextResourceItems(store)
  const second = store.contextGroups.find((group) => group.collection === 'world')
  assert.ok(second)
  assert.ok(second.items[0].tokens > firstTokens)
  assert.equal(second.tokens, second.items[0].tokens)

  store.world = []
  syncContextResourceItems(store)
  const empty = store.contextGroups.find((group) => group.collection === 'world')
  assert.ok(empty)
  assert.equal(empty.tokens, 0)
  assert.equal(empty.items.length, 0)
})

test('recomputes custom module tokens from live entries instead of entry-count padding', () => {
  const store = createStore()
  addFaction(store)
  store.customModules.entries.push({
    id: 'entry-1',
    schemaId: 'faction',
    title: '天玄宗',
    data: { 名称: '天玄宗' },
    createdAt: 0,
    updatedAt: 0,
  })
  store.contextGroups = [contextGroup('ctx-custom', 'custom', [contextItem({ tokens: 2 })])]

  syncContextResourceItems(store)
  const custom = store.contextGroups.find((group) => group.collection === 'custom')
  assert.ok(custom)
  const firstTokens = custom.items[0].tokens
  assert.ok(firstTokens > 2)
  assert.equal(custom.tokens, firstTokens)

  store.customModules.entries[0].data.当前状态 = '正在封山，宗门上下已经连续三个月没有对外开放，所有外来访客都必须在山门外登记并等待长老批准。'
  syncContextResourceItems(store)
  const updated = store.contextGroups.find((group) => group.collection === 'custom')
  assert.ok(updated)
  assert.ok(updated.items[0].tokens > firstTokens)
  assert.equal(updated.tokens, updated.items[0].tokens)
})

test('enabled context token totals never fall back to stale group tokens when every child is disabled', () => {
  const groups = [
    contextGroup('ctx-world', 'world', [{
      ...contextItem({ collection: 'world', resourceId: 'world-1', tokens: 42 }),
      enabled: false,
    }]),
    contextGroup('ctx-chapter', 'chapter', [{
      ...contextItem({ collection: 'chapter', tokens: 18 }),
      enabled: false,
    }]),
    contextGroup('ctx-empty', 'custom', []),
  ]
  groups[0].tokens = 99999
  groups[1].tokens = 88888
  assert.equal(estimateEnabledContextTokens(groups), 0)

  groups[0].items[0].enabled = true
  assert.equal(estimateEnabledContextTokens(groups), 42)
  groups[0].enabled = false
  assert.equal(estimateEnabledContextTokens(groups), 0)
})

test('removes the obsolete flat context outlet from normalized layouts', () => {
  const store = createStore()
  store.contextGroups = [
    contextGroup('ctx-lore', 'custom', [{
      id: 'legacy-outlet',
      title: '本章资料 outlet',
      source: '旧布局',
      role: 'system',
      tokens: 1180,
      enabled: true,
      collection: 'custom',
    }]),
  ]

  syncContextResourceItems(store)

  assert.equal(store.contextGroups.some((group) => group.id === 'ctx-lore'), false)
  assert.equal(store.contextBlocks.some((block) => block.id === 'ctx-lore'), false)
})

