import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanupDeletedResourceReferences } from '../src/data/integrity.ts'
import { createDefaultWorldEngineState } from '../src/data/worldEngine.ts'

function createStore() {
  return {
    schemaVersion: 8,
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

test('cleans deleted item references from holdings and custom item indexes', () => {
  const store = createStore()
  store.items = [{ id: 'item-key', title: '铜钥匙' }]
  store.characters = [{ id: 'char-1', title: '沈砚', holdingItems: ['item-key', 'item-other'] }]
  store.customModules.schemas.push({
    id: 'faction',
    title: '势力卡',
    type: '势力卡',
    fields: [{ id: 'members', key: '主要道具', label: '主要道具', type: 'itemIndex' }],
  })
  store.customModules.entries.push({
    id: 'entry-1',
    schemaId: 'faction',
    data: { 主要道具: ['item-key', 'item-other'] },
    updatedAt: 1,
  })

  store.items.splice(0, 1)
  const report = cleanupDeletedResourceReferences(store, 'items', { id: 'item-key', title: '铜钥匙' })

  assert.equal(report.holdingReferences, 1)
  assert.equal(report.customModuleReferences, 1)
  assert.deepEqual(store.characters[0].holdingItems, ['item-other'])
  assert.deepEqual(store.customModules.entries[0].data['主要道具'], ['item-other'])
})

test('cleans deleted character references from engine state and pending proposals', () => {
  const store = createStore()
  store.characters = [
    { id: 'char-shen', title: '沈砚', fields: { 角色身份: '主角' } },
    { id: 'char-lin', title: '林舟', fields: { 角色身份: '配角' } },
  ]
  store.customModules.schemas.push({
    id: 'scene',
    title: '场景',
    type: '场景',
    fields: [{ id: 'cast', key: '出场人物', label: '出场人物', type: 'characterIndex' }],
  })
  store.customModules.entries.push({
    id: 'entry-1',
    schemaId: 'scene',
    data: { 出场人物: ['char-shen', 'char-lin'] },
    updatedAt: 1,
  })
  store.worldEngine = createDefaultWorldEngineState(1)
  store.worldEngine.characterStates = [{
    id: 'state-shen',
    characterId: 'char-shen',
    name: '沈砚',
    availability: 'interaction',
    location: '',
    activity: '',
    mood: '',
    goals: [],
    knownFacts: [],
    sceneProtected: false,
    updatedAt: 1,
    evidence: [],
  }]
  store.worldEngine.relationships = [{
    id: 'relation-1',
    fromCharacterId: 'char-shen',
    toCharacterId: 'char-lin',
    label: '同伴',
    evidence: [],
    updatedAt: 1,
  }]
  store.worldEngine.events = [{
    id: 'event-1',
    kind: 'event',
    title: '旧港冲突',
    summary: '',
    status: 'planned',
    actorIds: ['char-shen', 'char-lin'],
    consequences: [],
    evidence: [],
    updatedAt: 1,
  }]
  store.worldEngine.pendingProposals = [{
    id: 'proposal-1',
    status: 'pending',
    reasoning: '关系更新',
    createdAt: 1,
    changes: [
      { id: 'change-relation', kind: 'relationship', targetId: 'char-shen', summary: '', patch: { fromCharacterId: 'char-shen', toCharacterId: 'char-lin' }, evidence: [] },
      { id: 'change-event', kind: 'event', targetId: 'event-2', summary: '', patch: { actorIds: ['char-shen'] }, evidence: [] },
      { id: 'change-existing-relation', kind: 'relationship', targetId: 'relation-1', summary: '', patch: { detail: '继续合作' }, evidence: [] },
    ],
  }]

  store.characters.splice(0, 1)
  const report = cleanupDeletedResourceReferences(store, 'characters', { id: 'char-shen', title: '沈砚' })

  assert.equal(report.customModuleReferences, 1)
  assert.equal(store.customModules.entries[0].data['出场人物'][0], 'char-lin')
  assert.equal(store.worldEngine.characterStates.length, 0)
  assert.equal(store.worldEngine.relationships.length, 0)
  assert.deepEqual(store.worldEngine.events[0].actorIds, ['char-lin'])
  assert.equal(store.worldEngine.pendingProposals.length, 0)
})

