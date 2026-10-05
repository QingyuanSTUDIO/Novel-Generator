import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeOutlineNodes } from '../src/data/outline.ts'

function node(id, extra = {}) {
  return {
    id,
    title: id,
    tag: '',
    summary: '',
    fields: {},
    ...extra,
  }
}

test('removes dangling outline parents and chapter ranges', () => {
  const chapters = [{ id: 'chapter-1' }]
  const nodes = [node('root', {
    outlineType: 'book',
    outlineParentId: 'missing',
    outlineStartChapterId: 'chapter-1',
    outlineEndChapterId: 'missing-chapter',
  })]

  const normalized = normalizeOutlineNodes(nodes, chapters)

  assert.equal(normalized[0].outlineParentId, undefined)
  assert.equal(normalized[0].outlineStartChapterId, 'chapter-1')
  assert.equal(normalized[0].outlineEndChapterId, undefined)
})

test('removes self references and invalid outline metadata', () => {
  const nodes = [node('root', {
    outlineType: 'invalid',
    outlineParentId: 'root',
    outlineCollapsed: 'yes',
  })]

  const normalized = normalizeOutlineNodes(nodes)

  assert.equal(normalized[0].outlineType, undefined)
  assert.equal(normalized[0].outlineParentId, undefined)
  assert.equal(normalized[0].outlineCollapsed, undefined)
})

test('breaks cyclic parent links while preserving a usable tree', () => {
  const nodes = [
    node('a', { outlineParentId: 'b' }),
    node('b', { outlineParentId: 'c' }),
    node('c', { outlineParentId: 'a' }),
    node('leaf', { outlineParentId: 'b' }),
  ]

  const normalized = normalizeOutlineNodes(nodes)
  const byId = new Map(normalized.map((entry) => [entry.id, entry]))

  assert.equal(byId.get('a').outlineParentId, 'b')
  assert.equal(byId.get('b').outlineParentId, 'c')
  assert.equal(byId.get('c').outlineParentId, undefined)
  assert.equal(byId.get('leaf').outlineParentId, 'b')
})

test('preserves valid outline fields and does not mutate the input', () => {
  const nodes = [node('scene', {
    outlineType: 'scene',
    outlineParentId: 'book',
    outlineStartChapterId: 'chapter-1',
    outlineEndChapterId: 'chapter-2',
    outlineCollapsed: true,
  }), node('book', { outlineType: 'book' })]
  const chapters = [{ id: 'chapter-1' }, { id: 'chapter-2' }]
  const before = structuredClone(nodes)

  const normalized = normalizeOutlineNodes(nodes, chapters)

  assert.deepEqual(nodes, before)
  assert.deepEqual(normalized[0], nodes[0])
})
