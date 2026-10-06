import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  operationDependencies,
  removeOperationIndexesWithDependents,
  selectOperationIndexesWithDependencies,
} from '../src/agent/planDependencies.ts'

test('selecting a custom module entry includes its in-plan schema creation', () => {
  const operations = [
    { action: 'create_custom_module', id: 'faction', title: '势力卡', fields: [{ key: '名称', type: 'string' }] },
    { action: 'create_custom_module_entry', schemaId: 'faction', data: { 名称: '天玄宗' } },
  ]
  assert.deepEqual(operationDependencies(operations, 1), [{ index: 0, reason: '创建自定义模块条目需要先创建对应结构' }])
  assert.deepEqual(selectOperationIndexesWithDependencies(operations, [1]), [0, 1])
  assert.deepEqual(removeOperationIndexesWithDependents(operations, [0, 1], 0), [])
})

test('selecting a chapter after a planned volume includes the preceding volume', () => {
  const operations = [
    { action: 'create_volume', title: '第一卷' },
    { action: 'create_chapter', title: '开场' },
  ]
  assert.deepEqual(selectOperationIndexesWithDependencies(operations, [1]), [0, 1])
  assert.deepEqual(removeOperationIndexesWithDependents(operations, [0, 1], 0), [])
})

test('group-target dependencies match the same collection and title', () => {
  const operations = [
    { action: 'create_resource_group', collection: 'characters', title: '主要角色' },
    { action: 'create_resource', resourceType: 'character', title: '叶青', groupTarget: '主要角色' },
    { action: 'create_resource', resourceType: 'item', title: '青锋剑', groupTarget: '主要角色' },
  ]
  assert.deepEqual(selectOperationIndexesWithDependencies(operations, [1]), [0, 1])
  assert.deepEqual(selectOperationIndexesWithDependencies(operations, [2]), [2])
})
