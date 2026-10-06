import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick, ref, watch } from 'vue'
import { syncAgentConversationMessages } from '../src/agent/conversationSync.ts'

function makeMessage(overrides = {}) {
  return {
    id: 'reply',
    role: 'assistant',
    content: '已创建角色。',
    createdAt: 12,
    activities: [{
      id: 'create-character',
      title: '创建角色',
      detail: '角色卡已写入。',
      createdAt: 12,
      state: 'done',
      kind: 'tool',
    }],
    ...overrides,
  }
}

test('repeated save snapshots keep the reactive transcript clean when messages and activities are unchanged', async () => {
  const conversation = ref({ messages: [makeMessage()], updatedAt: 12 })
  const originalMessages = conversation.value.messages
  let dirtyGeneration = 7
  const stop = watch(conversation, () => { dirtyGeneration += 1 }, { deep: true })
  try {
    const generationAtFlush = dirtyGeneration
    // Snapshots are independent objects, as they are after disk restoration.
    assert.equal(syncAgentConversationMessages(conversation.value, structuredClone([makeMessage()])), false)
    assert.equal(syncAgentConversationMessages(conversation.value, structuredClone([makeMessage()])), false)
    await nextTick()

    assert.strictEqual(conversation.value.messages, originalMessages)
    assert.equal(dirtyGeneration, generationAtFlush)
  } finally {
    stop()
  }
})

test('semantic equality does not depend on JSON property insertion order', async () => {
  const source = makeMessage()
  const reordered = {
    createdAt: source.createdAt,
    activities: source.activities.map((activity) => ({
      kind: activity.kind, state: activity.state, createdAt: activity.createdAt,
      detail: activity.detail, title: activity.title, id: activity.id,
    })),
    content: source.content,
    role: source.role,
    id: source.id,
  }
  const conversation = ref({ messages: [reordered], updatedAt: 12 })
  let changes = 0
  const stop = watch(conversation, () => { changes += 1 }, { deep: true })
  try {
    assert.equal(syncAgentConversationMessages(conversation.value, [source]), false)
    await nextTick()
    assert.equal(changes, 0)
  } finally {
    stop()
  }
})

test('real new messages preserve complete text and activity records and advance the latest timestamp once', async () => {
  const conversation = ref({ messages: [makeMessage()], updatedAt: 12 })
  const latest = makeMessage({
    id: 'latest-reply',
    content: '完整回复。'.repeat(1000),
    createdAt: 20,
    activities: [
      { id: 'retrieve', title: '检索角色', state: 'done', kind: 'tool', createdAt: 19 },
      { id: 'write', title: '修改角色', detail: '已更新性格。', state: 'done', kind: 'result', createdAt: 21 },
    ],
  })
  const source = [makeMessage(), latest]
  let changes = 0
  const stop = watch(conversation, () => { changes += 1 }, { deep: true })
  try {
    assert.equal(syncAgentConversationMessages(conversation.value, source), true)
    await nextTick()
    assert.equal(changes, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(conversation.value.messages)), source)
    assert.equal(conversation.value.updatedAt, 21)

    assert.equal(syncAgentConversationMessages(conversation.value, source), false)
    await nextTick()
    assert.equal(changes, 1)

    // A caller mutating its candidate must not silently mutate saved history.
    latest.content = '尚未同步的候选。'
    latest.activities[1].detail = '另一项候选修改。'
    assert.notEqual(conversation.value.messages[1].content, latest.content)
    assert.notEqual(conversation.value.messages[1].activities[1].detail, latest.activities[1].detail)
  } finally {
    stop()
  }
})

test('edits to an existing message and its activity summary remain real reactive changes', async () => {
  const conversation = ref({ messages: [makeMessage()], updatedAt: 12 })
  const changed = makeMessage({
    content: '角色修改失败，请重试。',
    activities: [{
      id: 'create-character',
      title: '创建角色',
      detail: '保存失败，未写入。',
      createdAt: 12,
      state: 'error',
      kind: 'error',
    }],
  })
  let changes = 0
  const stop = watch(conversation, () => { changes += 1 }, { deep: true })
  try {
    assert.equal(syncAgentConversationMessages(conversation.value, [changed]), true)
    await nextTick()
    assert.equal(changes, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(conversation.value.messages)), [changed])
    assert.equal(conversation.value.updatedAt, 12)
    assert.equal(syncAgentConversationMessages(conversation.value, [changed]), false)
  } finally {
    stop()
  }
})

test('activity-only updates are persisted even when the response text and message time stay unchanged', async () => {
  const conversation = ref({ messages: [makeMessage()], updatedAt: 12 })
  const changed = makeMessage()
  changed.activities[0] = {
    ...changed.activities[0],
    detail: '角色卡验证完成。',
    state: 'error',
    kind: 'error',
  }
  let changes = 0
  const stop = watch(conversation, () => { changes += 1 }, { deep: true })
  try {
    assert.equal(syncAgentConversationMessages(conversation.value, [changed]), true)
    await nextTick()
    assert.equal(changes, 1)
    assert.equal(conversation.value.messages[0].content, makeMessage().content)
    assert.deepEqual(JSON.parse(JSON.stringify(conversation.value.messages[0].activities)), changed.activities)
    assert.equal(syncAgentConversationMessages(conversation.value, [changed]), false)
    await nextTick()
    assert.equal(changes, 1)
  } finally {
    stop()
  }
})

test('an empty transcript does not gain a synthetic update timestamp on save', async () => {
  const conversation = ref({ messages: [], updatedAt: 12 })
  let changes = 0
  const stop = watch(conversation, () => { changes += 1 }, { deep: true })
  try {
    assert.equal(syncAgentConversationMessages(conversation.value, []), false)
    await nextTick()
    assert.equal(conversation.value.updatedAt, 12)
    assert.equal(changes, 0)
  } finally {
    stop()
  }
})

test('synchronization retains the full persisted conversation independently of the model history budget', () => {
  const messages = Array.from({ length: 180 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `持久化消息 ${index}`,
    createdAt: index,
  }))
  const conversation = { messages: [], updatedAt: 0 }
  assert.equal(syncAgentConversationMessages(conversation, messages), true)
  assert.equal(conversation.messages.length, 180)
  assert.deepEqual(conversation.messages, messages)
  assert.equal(syncAgentConversationMessages(conversation, structuredClone(messages)), false)
})
