import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLocalAgentPrompt } from '../src/agent/localParser.ts'

test('parses creation of a named resource group', () => {
  const result = parseLocalAgentPrompt('请在世界书中新建一个折叠栏，名称为“地理设定”')

  assert.deepEqual(result.operations, [{
    action: 'create_resource_group',
    collection: 'world',
    title: '地理设定',
  }])
})

test('parses deletion and explains that cards are preserved', () => {
  const result = parseLocalAgentPrompt('删除角色折叠栏“旧角色”')

  assert.deepEqual(result.operations, [{
    action: 'delete_resource_group',
    collection: 'characters',
    target: '旧角色',
  }])
  assert.match(result.message, /卡片会保留/u)
})

test('parses moving a card into a named group', () => {
  const result = parseLocalAgentPrompt('把“林澈”放入角色折叠栏“主角组”')

  assert.deepEqual(result.operations, [{
    action: 'move_resource_to_group',
    collection: 'characters',
    target: '林澈',
    groupTarget: '主角组',
  }])
})

test('parses moving a card back to the ungrouped list', () => {
  const result = parseLocalAgentPrompt('在技能卡里把“疾风步”移出折叠栏')

  assert.deepEqual(result.operations, [{
    action: 'move_resource_to_group',
    collection: 'skills',
    target: '疾风步',
    groupTarget: null,
  }])
})

test('uses the current collection only when supplied and leaves ambiguous commands unapplied', () => {
  const ambiguous = parseLocalAgentPrompt('新建一个名为“重要角色”的折叠栏')
  assert.deepEqual(ambiguous.operations, [])
  assert.match(ambiguous.message, /说明要在哪类内容中/u)

  const fromCurrentPage = parseLocalAgentPrompt('新建一个名为“重要角色”的折叠栏', 'characters')
  assert.deepEqual(fromCurrentPage.operations, [{
    action: 'create_resource_group',
    collection: 'characters',
    title: '重要角色',
  }])
})
