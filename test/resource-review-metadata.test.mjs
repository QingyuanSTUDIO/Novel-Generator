import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeResourceReviewMetadata, setResourceLockAll } from '../src/data/resourceReviewMetadata.ts'

test('migrates legacy source and review labels without losing semantic tags', () => {
  const resource = normalizeResourceReviewMetadata({
    id: 'character-1',
    title: '沈砚',
    tag: '主角 · Agent 创建 · 完成',
    summary: '',
    fields: {},
    lockedFields: ['summary', ' summary ', ''],
    reviewStatusLocked: true,
    lockedAll: true,
  })

  assert.equal(resource.tag, '主角')
  assert.equal(resource.creationSource, 'agent')
  assert.equal(resource.reviewStatus, 'complete')
  assert.equal(resource.reviewStatusLocked, true)
  assert.equal(resource.lockedAll, true)
  assert.deepEqual(resource.lockedFields, ['summary'])
})

test('uses conservative defaults for older entries with no creation metadata', () => {
  const resource = normalizeResourceReviewMetadata({
    id: 'skill-1',
    title: '潮汐感知',
    tag: '主动 · 侦察',
    summary: '',
    fields: {},
  })

  assert.equal(resource.tag, '主动 · 侦察')
  assert.equal(resource.creationSource, 'manual')
  assert.equal(resource.reviewStatus, 'pending')
  assert.equal(resource.reviewStatusLocked, false)
  assert.equal(resource.lockedAll, false)
  assert.deepEqual(resource.lockedFields, [])
})

test('whole-entry locking preserves individual field locks and review-status lock', () => {
  const resource = {
    id: 'character-1',
    title: '沈砚',
    tag: '主角',
    summary: '修表匠',
    fields: { 性别: '男', '角色身份': '主角' },
    holdingItems: ['key-1'],
    holdingSkills: ['skill-1'],
    lockedFields: ['summary'],
    reviewStatusLocked: false,
  }

  setResourceLockAll(resource, true)
  assert.equal(resource.lockedAll, true)
  assert.equal(resource.reviewStatusLocked, true)
  assert.equal(resource.reviewStatusLockedBeforeAll, false)
  assert.deepEqual(resource.lockedFields, ['summary'])

  setResourceLockAll(resource, false)
  assert.equal(resource.lockedAll, false)
  assert.equal(resource.reviewStatusLocked, false)
  assert.equal('reviewStatusLockedBeforeAll' in resource, false)
  assert.deepEqual(resource.lockedFields, ['summary'])
})

test('whole-entry locking restores a pre-existing review-status lock', () => {
  const resource = {
    id: 'item-1',
    title: '铜钥匙',
    tag: '关键道具',
    summary: '',
    fields: {},
    reviewStatusLocked: true,
    lockedFields: [],
  }

  setResourceLockAll(resource, true)
  assert.equal(resource.reviewStatusLocked, true)
  setResourceLockAll(resource, false)
  assert.equal(resource.reviewStatusLocked, true)
})
