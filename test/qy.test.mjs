import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQyDocument, mergeQyContent, parseQyDocument } from '../src/data/qy.ts'

function createStore() {
  return {
    schemaVersion: 10,
    volumes: [{ id: 'v1', title: '第一卷', collapsed: false }],
    chapters: [{ id: 'c1', title: '第一章', status: '草稿', content: '正文', wordCount: 2, volumeId: 'v1' }],
    world: [],
    characters: [],
    items: [],
    skills: [],
    outline: [],
    style: [{ id: 's1', title: '规则', tag: '', summary: '保留', fields: { 规则: '动作承载情绪' } }],
    providers: [{ id: 'api', title: '密钥不应导出', tag: '', summary: '', fields: { 'API Key': 'secret' } }],
    modelOptions: { api: ['model-a'] },
    contextBlocks: [],
    contextGroups: [],
    resourceGroups: { world: [], characters: [], items: [], skills: [], style: [] },
    customModules: { schemas: [], entries: [] },
    memes: { entries: [], updatedAt: 0 },
    worldEngine: {},
  }
}

test('.qy documents include work content but exclude API settings', () => {
  const store = createStore()
  const document = createQyDocument(store, '测试作品')
  assert.equal(document.format, 'qy')
  assert.equal(document.title, '测试作品')
  assert.equal('providers' in document.content, false)
  assert.equal('modelOptions' in document.content, false)
  assert.equal(document.content.style[0].title, '规则')
})

test('parses and merges .qy content without replacing current settings', () => {
  const current = createStore()
  const document = createQyDocument(current, '可迁移')
  document.content.chapters[0].content = '导入后的正文'
  const parsed = parseQyDocument(document)
  const merged = mergeQyContent(parsed, current)
  assert.equal(merged.chapters[0].content, '导入后的正文')
  assert.equal(merged.providers[0].fields['API Key'], 'secret')
  assert.deepEqual(merged.modelOptions, { api: ['model-a'] })
})

