import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyHistoryPatch, createInverseHistoryPatch } from '../src/agent/historyPatch.ts'

test('inverse history patch stores only changed resource rows and restores the prior snapshot', () => {
  const before = {
    chapters: [{ id: 'chapter-1', content: '旧正文' }],
    characters: [
      { id: 'char-1', title: '主角', fields: { 性格: '谨慎' } },
      { id: 'char-2', title: '配角', fields: { 性格: '冷静' } },
    ],
    selectedChapterId: 'chapter-1',
  }
  const after = structuredClone(before)
  after.characters[0].fields.性格 = '坚韧'
  after.characters.push({ id: 'char-3', title: '新角色', fields: { 性格: '冲动' } })
  const patch = createInverseHistoryPatch(before, after)

  assert.ok(patch.length > 0)
  assert.ok(patch.length < JSON.stringify(before).length / 2)
  assert.deepEqual(applyHistoryPatch(after, patch), before)
  assert.deepEqual(after.characters[1], before.characters[1])
})

test('inverse history patch handles additions/removals while preserving stable order', () => {
  const before = { items: [{ id: 'a', value: 'A' }, { id: 'b', value: 'B' }, { id: 'c', value: 'C' }] }
  const after = { items: [{ id: 'a', value: 'A2' }, { id: 'c', value: 'C' }, { id: 'd', value: 'D' }] }
  const patch = createInverseHistoryPatch(before, after)
  assert.deepEqual(applyHistoryPatch(after, patch), before)
  assert.equal(patch.some((operation) => operation.op === 'replace' && operation.path === '/items'), false)
})

test('reordered identified arrays fall back to one safe replacement', () => {
  const before = { rows: [{ id: 'a' }, { id: 'b' }] }
  const after = { rows: [{ id: 'b' }, { id: 'a' }] }
  const patch = createInverseHistoryPatch(before, after)
  assert.deepEqual(applyHistoryPatch(after, patch), before)
  assert.deepEqual(patch, [{ op: 'replace', path: '/rows', value: before.rows }])
})

