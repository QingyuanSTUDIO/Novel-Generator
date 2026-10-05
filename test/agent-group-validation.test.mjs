import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAgentResponse } from '../src/agent/validation.ts'

const response = (operation) => validateAgentResponse({ message: '分组操作', operations: [operation] })

test('accepts group operations and explicit resource group assignment', () => {
  const result = validateAgentResponse({
    message: '整理条目',
    operations: [
      { action: 'create_resource_group', collection: 'characters', title: '主角团' },
      { action: 'create_resource', resourceType: 'character', title: '林舟', groupTarget: '主角团' },
      { action: 'move_resource_to_group', collection: 'characters', target: '林舟', groupTarget: '主角团' },
      { action: 'move_resource_to_group', collection: 'characters', target: '林舟', groupTarget: null },
      { action: 'delete_resource_group', collection: 'characters', target: '主角团' },
    ],
  })

  assert.equal(result.ok, true)
})

test('rejects unsupported group collections', () => {
  const result = response({ action: 'create_resource_group', collection: 'outline', title: '规划' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /collection/)
})

test('rejects empty group titles and targets', () => {
  const emptyTitle = response({ action: 'create_resource_group', collection: 'world', title: '  ' })
  const emptyDeleteTarget = response({ action: 'delete_resource_group', collection: 'world', target: '' })
  const emptyMoveTarget = response({ action: 'move_resource_to_group', collection: 'world', target: ' ', groupTarget: null })

  assert.equal(emptyTitle.ok, false)
  assert.equal(emptyDeleteTarget.ok, false)
  assert.equal(emptyMoveTarget.ok, false)
})

test('rejects missing or invalid groupTarget values', () => {
  const missingTarget = response({ action: 'move_resource_to_group', collection: 'items', target: '钥匙' })
  const wrongType = response({ action: 'move_resource_to_group', collection: 'items', target: '钥匙', groupTarget: 7 })
  const emptyTarget = response({ action: 'move_resource_to_group', collection: 'items', target: '钥匙', groupTarget: '' })
  const invalidCreateTarget = response({ action: 'create_resource', resourceType: 'item', title: '钥匙', groupTarget: false })

  assert.equal(missingTarget.ok, false)
  assert.equal(wrongType.ok, false)
  assert.equal(emptyTarget.ok, false)
  assert.equal(invalidCreateTarget.ok, false)
})

test('keeps strict unknown-key validation for group operations', () => {
  const result = response({ action: 'delete_resource_group', collection: 'skills', target: '战斗', deleteContents: true })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /不支持的属性/)
})
