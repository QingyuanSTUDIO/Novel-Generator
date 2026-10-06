import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGlobalSearchDocuments, searchGlobalDocuments } from '../src/search/globalSearch.ts'

const store = {
  schemaVersion: 7,
  volumes: [{ id: 'vol-1', title: '第一卷', collapsed: false }],
  chapters: [{ id: 'ch-1', title: '潮汐之夜', status: '草稿', content: '沈砚在港口发现铜钥匙。', wordCount: 11, volumeId: 'vol-1', taskGoal: '找到遗迹入口', cast: ['沈砚'] }],
  world: [{ id: 'world-1', title: '潮汐法则', tag: '规则', summary: '潮汐每天改变一次。', fields: { 内容: '港口的潮声会掩盖密道开启声。' } }],
  characters: [{ id: 'char-1', title: '沈砚', tag: '主角', summary: '谨慎的调查者。', fields: { 性格: '谨慎' } }],
  items: [{ id: 'item-1', title: '铜钥匙', tag: '道具', summary: '开启旧仓库。', fields: { 用途: '打开遗迹入口。' } }],
  skills: [],
  outline: [],
  style: [],
  providers: [],
  modelOptions: {},
  contextBlocks: [],
  resourceGroups: { world: [], characters: [], items: [], skills: [], style: [] },
  customModules: { schemas: [{ id: 'schema-1', type: '势力卡', title: '势力卡', description: '势力信息', fields: [{ id: 'name', key: '名称', label: '名称', type: 'string' }], version: 1, createdAt: 1, updatedAt: 1 }], entries: [{ id: 'entry-1', schemaId: 'schema-1', title: '天玄宗', data: { 名称: '天玄宗', 状态: '封山' }, createdAt: 1, updatedAt: 1 }] },
  memes: { entries: [{ id: 'meme-1', name: '电子木鱼', explanation: '一种网络梗', usage: '用于调侃祈福', keywords: ['木鱼'], source: '测试' }], updatedAt: 1 },
  worldEngine: { characterStates: [{ id: 'state-1', name: '沈砚', availability: 'interaction', location: '港口', activity: '调查', mood: '冷静', goals: [], knownFacts: [], sceneProtected: false, updatedAt: 1 }], relationships: [], events: [], timeline: [], workNotes: [], logs: [], clock: { label: '第一天', currentTime: '第一天', timeAdvanceMode: 'day', revision: 1, updatedAt: 1 }, schemaVersion: 1, enabled: true, status: 'idle', pendingProposals: [], updatedAt: 1 },
}

test('builds documents for all searchable project collections', () => {
  const documents = buildGlobalSearchDocuments('p-1', '归元', store, { agentMessages: [{ id: 'm-1', role: 'user', content: '请整理铜钥匙', createdAt: 1 }] })
  assert.ok(documents.some((document) => document.collection === 'chapters' && document.title === '潮汐之夜'))
  assert.ok(documents.some((document) => document.collection === 'custom' && document.title === '天玄宗'))
  assert.ok(documents.some((document) => document.collection === 'worldEngine' && document.location === '后台角色'))
  assert.ok(documents.some((document) => document.collection === 'agent' && document.text.includes('铜钥匙')))
})

test('searches titles and body text, ranks title hits, and returns snippets', () => {
  const documents = buildGlobalSearchDocuments('p-1', '归元', store)
  const results = searchGlobalDocuments(documents, '铜钥匙')
  assert.ok(results.length >= 2)
  assert.equal(results[0].title, '铜钥匙')
  assert.match(results[0].snippet, /铜钥匙/)
  assert.deepEqual(searchGlobalDocuments(documents, '   '), [])
})
