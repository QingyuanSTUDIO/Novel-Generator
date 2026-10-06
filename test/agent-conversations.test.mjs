import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computed, ref } from 'vue'
import { useAgentConversations } from '../src/composables/useAgentConversations.ts'

function createController(overrides = {}) {
  const canSwitch = ref(true)
  let persistCalls = 0
  const controller = useAgentConversations({
    welcomeContent: '欢迎使用 Agent。',
    canSwitch: computed(() => canSwitch.value),
    persist: () => { persistCalls += 1 },
    confirmDelete: () => true,
    ...overrides,
  })
  return { controller, canSwitch, persistCalls: () => persistCalls }
}

test('agent conversation controller restores legacy messages into one active conversation', () => {
  const { controller } = createController()
  controller.restoreAgentConversationState(undefined, undefined, [{
    id: 'legacy-message',
    role: 'user',
    content: '继续写这一章',
    createdAt: 12,
  }])

  assert.equal(controller.agentConversations.value.length, 1)
  assert.equal(controller.agentConversations.value[0].title, '历史对话')
  assert.equal(controller.activeAgentConversationId.value, controller.agentConversations.value[0].id)
  assert.equal(controller.agentMessages.value[0].content, '继续写这一章')
})

test('agent conversation controller deduplicates records and falls back from archived selection', () => {
  const { controller } = createController()
  controller.restoreAgentConversationState([
    { id: 'archived', title: '已归档', createdAt: 1, updatedAt: 1, archived: true, messages: [] },
    { id: 'active', title: '当前', createdAt: 2, updatedAt: 2, messages: [] },
    { id: 'active', title: '重复', createdAt: 3, updatedAt: 3, messages: [] },
    { id: '', title: '无效', createdAt: 4, updatedAt: 4, messages: [] },
  ], 'archived')

  assert.deepEqual(controller.agentConversations.value.map((item) => item.id), ['archived', 'active'])
  assert.equal(controller.activeAgentConversationId.value, 'active')
  assert.equal(controller.archivedAgentConversationList.value[0].id, 'archived')
  assert.equal(controller.agentMessages.value[0].role, 'assistant')
})

test('agent conversation actions keep active selection and persist changes', () => {
  const { controller, canSwitch, persistCalls } = createController()
  const originalId = controller.activeAgentConversationId.value

  controller.createNewAgentConversation()
  const createdId = controller.activeAgentConversationId.value
  assert.notEqual(createdId, originalId)

  controller.renameAgentConversation(createdId, '新章节讨论')
  assert.equal(controller.agentConversations.value.find((item) => item.id === createdId)?.title, '新章节讨论')

  controller.selectAgentConversation(originalId)
  assert.equal(controller.activeAgentConversationId.value, originalId)
  controller.archiveAgentConversation(originalId)
  assert.equal(controller.agentConversations.value.find((item) => item.id === originalId)?.archived, true)
  assert.equal(controller.activeAgentConversationId.value, createdId)

  controller.restoreArchivedAgentConversation(originalId)
  assert.equal(controller.agentConversations.value.find((item) => item.id === originalId)?.archived, false)
  controller.deleteAgentConversation(originalId)
  assert.equal(controller.agentConversations.value.some((item) => item.id === originalId), false)

  canSwitch.value = false
  const before = controller.agentConversations.value.length
  controller.createNewAgentConversation()
  assert.equal(controller.agentConversations.value.length, before)
  assert.ok(persistCalls() >= 5)
})
