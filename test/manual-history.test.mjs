import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendManualHistory } from '../src/agent/manualHistory.ts'
import { applyHistoryPatch } from '../src/agent/historyPatch.ts'

function snapshot(content, title = '角色') {
  return {
    volumes: [{ id: 'volume-1', title: '', collapsed: false }],
    chapters: [{ id: 'chapter-1', title: '01', status: '草稿', content, wordCount: content.length, volumeId: 'volume-1' }],
    world: [], characters: [{ id: 'character-1', title, tag: '主角', summary: '', fields: { 性格: '谨慎' } }],
    items: [], skills: [], outline: [], style: [], resourceGroups: { world: [], characters: [], items: [], skills: [], style: [] },
    worldEngine: {}, customModules: { schemas: [], entries: [] }, memes: { entries: [], updatedAt: 1 }, contextBlocks: [], contextGroups: [],
  }
}

test('manual history stores a compact inverse field patch without a full snapshot', () => {
  const before = snapshot('旧正文')
  const after = snapshot('新正文', '新角色')
  const history = appendManualHistory({ history: [], before, after, beforeFingerprint: 'before', afterFingerprint: 'after', summary: '手动修改章节正文', historyLimit: 20, now: 1, id: 'manual-1' })
  assert.equal(history.length, 1)
  assert.equal(history[0].source, 'manual')
  assert.equal(history[0].snapshot, undefined)
  assert.ok(history[0].patch?.length)
  assert.deepEqual(applyHistoryPatch(after, history[0].patch), before)
})

test('consecutive manual field edits coalesce when no other change intervenes', () => {
  const initial = snapshot('一')
  const middle = snapshot('一二')
  const latest = snapshot('一二三')
  const first = appendManualHistory({ history: [], before: initial, after: middle, beforeFingerprint: 'f0', afterFingerprint: 'f1', summary: '手动修改正文', historyLimit: 20, now: 1, id: 'manual-1' })
  const merged = appendManualHistory({ history: first, before: middle, after: latest, beforeFingerprint: 'f1', afterFingerprint: 'f2', summary: '手动修改正文', historyLimit: 20, now: 2, id: 'manual-2' })
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'manual-1')
  assert.deepEqual(applyHistoryPatch(latest, merged[0].patch), initial)
})

test('manual history obeys the configured limit', () => {
  const one = snapshot('一')
  const two = snapshot('二')
  const three = snapshot('三')
  const first = appendManualHistory({ history: [], before: one, after: two, beforeFingerprint: '1', afterFingerprint: '2', summary: '一次', historyLimit: 2, now: 1, id: 'manual-1' })
  const second = appendManualHistory({ history: first, before: two, after: three, beforeFingerprint: 'different-before', afterFingerprint: '3', summary: '二次', historyLimit: 2, now: 2, id: 'manual-2' })
  const third = appendManualHistory({ history: second, before: three, after: snapshot('四'), beforeFingerprint: 'different-again', afterFingerprint: '4', summary: '三次', historyLimit: 2, now: 3, id: 'manual-3' })
  assert.deepEqual(third.map((entry) => entry.id), ['manual-3', 'manual-2'])
})
