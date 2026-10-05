import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractAgentMessagePreview } from '../src/agent/responsePreview.ts'

test('previews only a root message while an Agent JSON response is incomplete', () => {
  assert.equal(extractAgentMessagePreview('{"message":"我正在整理角色'), '我正在整理角色')
  assert.equal(extractAgentMessagePreview('{"message":"我正在整理角色","operations":['), '我正在整理角色')
  assert.equal(extractAgentMessagePreview('{"operations":[{"data":{"message":"不要显示"}}],"message":"已生成计划'), '已生成计划')
})

test('does not expose nested messages or other protocol fields', () => {
  assert.equal(extractAgentMessagePreview('{"operations":[{"message":"条目内容"}]}'), '')
  assert.equal(extractAgentMessagePreview('{"operations":[{"message":"未完成'), '')
  assert.equal(extractAgentMessagePreview('{"message":false,"operations":[]}'), '')
  assert.equal(extractAgentMessagePreview('{"mes'), '')
  assert.equal(extractAgentMessagePreview('模型正在思考'), '')
})

test('decodes JSON escapes and waits for incomplete escape sequences', () => {
  assert.equal(extractAgentMessagePreview('{"message":"第一行\\n第二行\\"引语'), '第一行\n第二行"引语')
  assert.equal(extractAgentMessagePreview('{"message":"角色\\'), '角色')
  assert.equal(extractAgentMessagePreview('{"message":"角色\\u5'), '角色')
  assert.equal(extractAgentMessagePreview('{"message":"角色\\u540d'), '角色名')
})

test('keeps incomplete Unicode surrogate pairs out of the preview', () => {
  assert.equal(extractAgentMessagePreview('{"message":"完成\\ud83d'), '完成')
  assert.equal(extractAgentMessagePreview('{"message":"完成\\ud83d\\ude00'), '完成😀')
  assert.equal(extractAgentMessagePreview(`{"message":"完成${String.fromCharCode(0xd83d)}`), '完成')
})

test('accepts code-fenced JSON and complex fields before the root message', () => {
  const source = '```json\n{"operations":[{"data":{"list":[1,2],"text":"引号\\"与,逗号"}},false],"message":"准备好了","extra":{}}\n```'
  assert.equal(extractAgentMessagePreview(source), '准备好了')
})
