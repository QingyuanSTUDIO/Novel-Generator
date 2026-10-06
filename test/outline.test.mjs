import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeOutlineNodes, outlineDescendantIds, removeOutlineNode } from '../src/data/outline.ts'

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

test('promotes direct outline children without leaving a dangling parent', () => {
  const nodes = [
    node('book', { outlineType: 'book' }),
    node('volume', { outlineType: 'volume', outlineParentId: 'book' }),
    node('range', { outlineType: 'chapterRange', outlineParentId: 'volume' }),
    node('scene', { outlineType: 'scene', outlineParentId: 'range' }),
  ]

  assert.deepEqual(outlineDescendantIds(nodes, 'volume'), ['range', 'scene'])
  const result = removeOutlineNode(nodes, 'volume', 'promote')
  const byId = new Map(result.nodes.map((entry) => [entry.id, entry]))

  assert.deepEqual(result.removedIds, ['volume'])
  assert.deepEqual(result.promotedIds, ['range'])
  assert.equal(byId.get('range').outlineParentId, 'book')
  assert.equal(byId.get('scene').outlineParentId, 'range')
  assert.equal(result.nodes.some((entry) => entry.outlineParentId === 'volume'), false)
})

test('promoting a scene to an incompatible book parent safely makes it a root', () => {
  const nodes = [
    node('book', { outlineType: 'book' }),
    node('range', { outlineType: 'chapterRange', outlineParentId: 'book' }),
    node('scene', { outlineType: 'scene', outlineParentId: 'range' }),
  ]

  const result = removeOutlineNode(nodes, 'range', 'promote')
  const scene = result.nodes.find((entry) => entry.id === 'scene')

  assert.equal(scene.outlineParentId, undefined)
})

test('cascading outline deletion removes every descendant and preserves input', () => {
  const nodes = [
    node('book', { outlineType: 'book' }),
    node('volume', { outlineType: 'volume', outlineParentId: 'book' }),
    node('range', { outlineType: 'chapterRange', outlineParentId: 'volume' }),
    node('scene', { outlineType: 'scene', outlineParentId: 'range' }),
  ]
  const before = structuredClone(nodes)
  const result = removeOutlineNode(nodes, 'volume', 'cascade')

  assert.deepEqual(result.removedIds, ['volume', 'range', 'scene'])
  assert.deepEqual(result.promotedIds, [])
  assert.deepEqual(result.nodes.map((entry) => entry.id), ['book'])
  assert.deepEqual(nodes, before)
})
