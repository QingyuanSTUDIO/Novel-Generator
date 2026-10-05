import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { computed, ref } from 'vue'
import { createDefaultWorldEngineState } from '../src/data/worldEngine.ts'
import { useWorldEngineController } from '../src/composables/useWorldEngineController.ts'

function createController(options = {}) {
  const chapter = { id: 'ch-8', title: '08 潮声里的回信', taskGoal: '追查船票日期', content: '正文内容', cast: ['沈砚'] }
  const store = ref({
    characters: [{ id: 'char-shen', title: '沈砚', tag: '主角', fields: { 角色身份: '主角' } }],
    worldEngine: createDefaultWorldEngineState(),
  })
  const activeChapter = computed(() => chapter)
  let persistCount = 0
  const controller = useWorldEngineController({
    store,
    activeChapter,
    effectiveCast: computed(() => ['沈砚']),
    provider: computed(() => options.provider),
    isApiConfigured: () => Boolean(options.provider),
    retrieveContextText: () => '',
    localApiUrl: options.localApiUrl || ((path) => path),
    persist: () => { persistCount += 1 },
  })
  return { store, controller, persistCount: () => persistCount }
}

async function createMockModelApi(t, handle) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    handle(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  return { localApiUrl: (path) => `http://127.0.0.1:${server.address().port}${path}`, requests }
}

function modelProvider(stream) {
  return {
    id: 'engine-test-provider',
    title: '世界推演接口',
    fields: { 接口地址: 'http://example.invalid/v1', 'API Key': 'test-key', 协议: 'OpenAI Compatible', 模型: 'test-model', 流式输出: stream ? 'true' : 'false' },
  }
}

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`
const engineResponse = {
  reasoning: '本章结束后，码头工人开始寻找失踪的船票。',
  changes: [{ kind: 'event', targetId: 'event-test', summary: '调查船票', patch: { kind: 'action', title: '寻找船票', status: 'planned' }, evidence: ['当前章节'] }],
}

test('world-engine streaming waits for done and full JSON before creating a review proposal', async (t) => {
  let finish
  let requestStarted
  const started = new Promise((resolve) => { requestStarted = resolve })
  const api = await createMockModelApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ type: 'delta', text: JSON.stringify(engineResponse) }))
    finish = () => res.end(sse({ type: 'done' }))
    requestStarted()
  })
  const { store, controller } = createController({ provider: modelProvider(true), localApiUrl: api.localApiUrl })
  const running = controller.run()
  await started
  assert.equal(controller.busy.value, true)
  assert.deepEqual(store.value.worldEngine.pendingProposals, [])
  assert.deepEqual(store.value.worldEngine.events, [])
  assert.equal(api.requests[0].stream, true)
  finish()
  await running
  assert.equal(controller.error.value, '')
  assert.equal(store.value.worldEngine.status, 'awaiting-review')
  assert.equal(store.value.worldEngine.pendingProposals[0].status, 'pending')
  assert.equal(store.value.worldEngine.pendingProposals[0].changes[0].targetId, 'event-test')
  assert.deepEqual(store.value.worldEngine.events, [])
})

test('world-engine honors the selected preset disabling streaming', async (t) => {
  const api = await createMockModelApi(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, text: JSON.stringify(engineResponse) }))
  })
  const { store, controller } = createController({ provider: modelProvider(false), localApiUrl: api.localApiUrl })
  await controller.run()
  assert.equal(api.requests[0].stream, false)
  assert.equal(controller.error.value, '')
  assert.equal(store.value.worldEngine.pendingProposals.length, 1)
  assert.deepEqual(store.value.worldEngine.events, [])
})

test('world-engine never accepts interrupted streams or invalid completed JSON', async (t) => {
  for (const [name, chunks, expected] of [
    ['missing done', sse({ type: 'delta', text: JSON.stringify(engineResponse) }), /尚未完成/],
    ['invalid JSON', sse({ type: 'delta', text: '{"reasoning":"一半"' }) + sse({ type: 'done' }), /不是有效 JSON/],
    ['invalid shape', sse({ type: 'delta', text: '{"reasoning":42,"changes":[]}' }) + sse({ type: 'done' }), /结构无效/],
    ['model error', sse({ type: 'delta', text: JSON.stringify(engineResponse) }) + sse({ type: 'error', error: '模型长度限制' }), /长度限制/],
  ]) {
    await t.test(name, async (sub) => {
      const api = await createMockModelApi(sub, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(chunks)
      })
      const { store, controller } = createController({ provider: modelProvider(true), localApiUrl: api.localApiUrl })
      await controller.run()
      assert.equal(controller.busy.value, false)
      assert.match(controller.error.value, expected)
      assert.equal(store.value.worldEngine.status, 'error')
      assert.deepEqual(store.value.worldEngine.pendingProposals, [])
      assert.deepEqual(store.value.worldEngine.events, [])
      assert.equal(store.value.worldEngine.logs[0].status, 'error')
    })
  }
})

test('runs a local proposal and records confirmation through the controller', async () => {
  const { store, controller, persistCount } = createController()

  await controller.run()

  const proposal = store.value.worldEngine.pendingProposals[0]
  assert.ok(proposal)
  assert.equal(proposal.status, 'pending')
  assert.equal(controller.busy.value, false)
  assert.equal(controller.error.value, '')

  controller.approveProposal(proposal.id)

  assert.equal(store.value.worldEngine.pendingProposals[0].status, 'accepted')
  assert.equal(store.value.worldEngine.status, 'idle')
  assert.equal(store.value.worldEngine.timeline[0].summary, proposal.reasoning)
  assert.equal(persistCount(), 2)
})

test('does not apply relationships involving a route character', () => {
  const { store, controller } = createController()
  store.value.characters.push({
    id: 'char-route',
    title: '港口守卫',
    tag: '路人',
    summary: '',
    fields: { 角色身份: '路人' },
  })
  store.value.worldEngine.pendingProposals.push({
    id: 'proposal-route-relationship',
    status: 'pending',
    reasoning: '关系推演',
    createdAt: Date.now(),
    changes: [{
      id: 'change-route-relationship',
      kind: 'relationship',
      targetId: 'relationship-route',
      summary: '守卫认识沈砚',
      patch: { fromCharacterId: 'char-shen', toCharacterId: 'char-route', label: '盘问过' },
      evidence: [],
    }],
  })

  controller.approveProposal('proposal-route-relationship')

  assert.deepEqual(store.value.worldEngine.relationships, [])
  assert.equal(store.value.worldEngine.pendingProposals[0].status, 'accepted')
})

test('whole-event lock synchronizes the review-status lock in both directions', () => {
  const { store, controller } = createController()
  controller.addEvent('闸门关闭')
  const event = store.value.worldEngine.events[0]

  controller.toggleEventLockAll(event.id, true)
  assert.equal(event.lockedAll, true)
  assert.equal(event.reviewStatusLocked, true)

  controller.toggleEventLockAll(event.id, false)
  assert.equal(event.lockedAll, false)
  assert.equal(event.reviewStatusLocked, false)
})

test('whole-event lock restores a pre-existing review-status lock', () => {
  const { store, controller } = createController()
  controller.addEvent('闸门关闭')
  const event = store.value.worldEngine.events[0]
  event.reviewStatusLocked = true

  controller.toggleEventLockAll(event.id, true)
  assert.equal(event.lockedAll, true)
  assert.equal(event.reviewStatusLocked, true)
  assert.equal(event.reviewStatusLockedBeforeAll, true)

  controller.toggleEventLockAll(event.id, false)
  assert.equal(event.lockedAll, false)
  assert.equal(event.reviewStatusLocked, true)
  assert.equal('reviewStatusLockedBeforeAll' in event, false)
})

test('agent event patches discard unknown actor and chapter references', () => {
  const { store, controller } = createController()
  store.value.worldEngine.pendingProposals.push({
    id: 'proposal-event-references',
    status: 'pending',
    reasoning: '引用完整性',
    createdAt: Date.now(),
    changes: [{
      id: 'change-event-references',
      kind: 'event',
      targetId: 'event-reference-check',
      summary: '引用不存在的资源',
      patch: {
        title: '闸门关闭',
        actorIds: ['missing-character'],
        chapterId: 'missing-chapter',
      },
      evidence: [],
    }],
  })

  controller.approveProposal('proposal-event-references')

  const event = store.value.worldEngine.events[0]
  assert.deepEqual(event.actorIds, [])
  assert.equal(event.chapterId, 'ch-8')
})

test('agent patches cannot overwrite character identity or unknown fields', () => {
  const { store, controller } = createController()
  store.value.worldEngine.characterStates.push({
    id: 'engine-char-shen',
    characterId: 'char-shen',
    name: '沈砚',
    availability: 'interaction',
    location: '码头',
    activity: '观察',
    mood: '平静',
    goals: [],
    knownFacts: [],
    sceneProtected: false,
    updatedAt: 1,
    evidence: [],
  })
  store.value.worldEngine.pendingProposals.push({
    id: 'proposal-character-integrity',
    status: 'pending',
    reasoning: '恶意字段',
    createdAt: Date.now(),
    changes: [{
      id: 'change-character-integrity',
      kind: 'character',
      targetId: 'engine-char-shen',
      summary: '尝试改写身份',
      patch: { id: 'attacker-id', lockedAll: true, name: '沈砚（新）', location: '仓库', unknown: '不得写入' },
      evidence: [],
    }],
  })

  controller.approveProposal('proposal-character-integrity')

  const character = store.value.worldEngine.characterStates[0]
  assert.equal(character.id, 'engine-char-shen')
  assert.equal(character.name, '沈砚（新）')
  assert.equal(character.location, '仓库')
  assert.equal(character.unknown, undefined)
  assert.equal(character.lockedAll, undefined)
})

test('agent cannot change an event review status after it is locked', () => {
  const { store, controller } = createController()
  controller.addEvent('闸门关闭')
  const event = store.value.worldEngine.events[0]
  event.reviewStatus = 'pending'
  event.reviewStatusLocked = true

  store.value.worldEngine.pendingProposals.push({
    id: 'proposal-event-review-lock',
    status: 'pending',
    reasoning: '锁定状态保护',
    createdAt: Date.now(),
    changes: [{
      id: 'change-event-review-lock',
      kind: 'event',
      targetId: event.id,
      summary: '尝试完成校对',
      patch: { title: '闸门关闭（更新）', reviewStatus: 'complete', lockedAll: false, unknown: '不得写入' },
      evidence: [],
    }],
  })

  controller.approveProposal('proposal-event-review-lock')

  assert.equal(event.title, '闸门关闭（更新）')
  assert.equal(event.reviewStatus, 'pending')
  assert.equal(event.lockedAll, false)
  assert.equal(event.unknown, undefined)
})

test('agent cannot create or update a relationship with a route character', () => {
  const { store, controller } = createController()
  store.value.characters.push({
    id: 'char-route',
    title: '港口守卫',
    tag: '路人',
    summary: '',
    fields: { 角色身份: '路人' },
  })
  store.value.worldEngine.pendingProposals.push({
    id: 'proposal-route-update',
    status: 'pending',
    reasoning: '关系边界',
    createdAt: Date.now(),
    changes: [{
      id: 'change-route-update',
      kind: 'relationship',
      targetId: 'relationship-route-existing',
      summary: '尝试写入路人关系',
      patch: { fromCharacterId: 'char-shen', toCharacterId: 'char-route', label: '盘问过', lockedAll: true },
      evidence: [],
    }],
  })

  controller.approveProposal('proposal-route-update')

  assert.deepEqual(store.value.worldEngine.relationships, [])
})
