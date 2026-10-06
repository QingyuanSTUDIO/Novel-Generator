import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { contentFingerprint, createConsoleExecutor, matchesFingerprint } from '../src/console/execution.ts'
import { consoleProjection, createConsoleInspector } from '../src/console/inspector.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function plan() {
  return {
    id: 'plan-one', message: '创建人物', createdAt: 1,
    operations: [{ action: 'create_resource', resourceType: 'character', title: '叶青' }],
    descriptions: ['创建角色叶青'], storeFingerprint: 'sha256:before',
  }
}

function job(overrides = {}) {
  return {
    id: 'job-one', kind: 'agent',
    target: { portfolioId: 'portfolio-a', projectId: 'project-a', chapterId: 'chapter-a' },
    prompt: '创建三位配角', mode: 'writing', providerId: 'provider-one',
    status: 'running', createdAt: 1, updatedAt: 1, events: [],
    ...overrides,
  }
}

function executorFixture(overrides = {}) {
  const target = {
    portfolioId: 'portfolio-a', projectId: 'project-a', chapterId: 'chapter-a',
    filePath: 'E:/Fake/portfolio.qy', ready: true,
  }
  const calls = { run: [], stage: [], approve: [], checkpoint: [], save: [], cancel: [], fingerprint: [] }
  const options = {
    target: () => ({ ...target }),
    busy: () => false,
    pendingPlan: () => null,
    fingerprint: async () => { calls.fingerprint.push(true); return 'sha256:after' },
    run: async (...args) => { calls.run.push(args); return { status: 'awaiting_approval', plan: plan() } },
    stage: async (...args) => { calls.stage.push(args); return { status: 'awaiting_approval', plan: args[1] || plan() } },
    approve: async (...args) => { calls.approve.push(args); return { status: 'completed', changes: ['创建角色叶青'] } },
    checkpoint: async (...args) => { calls.checkpoint.push(args) },
    save: async (...args) => { calls.save.push(args); return true },
    saveError: () => '假执行器保存失败',
    cancel: (...args) => { calls.cancel.push(args) },
    ...overrides,
  }
  return { executor: createConsoleExecutor(options), calls, target, options }
}

function assertNoWrites(calls) {
  for (const name of ['run', 'stage', 'approve', 'checkpoint', 'save']) assert.equal(calls[name].length, 0, `${name} 不应该被调用`)
}

test('console executor refuses mismatched portfolio, project or chapter before any writer callback', async () => {
  for (const mismatch of [
    { portfolioId: 'another-portfolio' },
    { projectId: 'another-project' },
    { chapterId: 'another-chapter' },
  ]) {
    for (const action of ['run', 'approve']) {
      const fixture = executorFixture()
      const input = job({ target: { ...job().target, ...mismatch }, result: { status: 'awaiting_approval', plan: plan() } })
      const result = await fixture.executor.execute({ action, job: input })
      assert.equal(result.status, 'failed')
      assert.match(result.error, /不同/)
      assertNoWrites(fixture.calls)
    }
  }
})

test('queued native Agent tasks stay bound to their original conversation during run and approval', async () => {
  for (const action of ['run', 'approve']) {
    const fixture = executorFixture()
    fixture.target.conversationId = 'new-conversation'
    const input = job({
      target: { ...job().target, conversationId: 'original-conversation' },
      result: { status: 'awaiting_approval', plan: plan() },
    })
    const result = await fixture.executor.execute({ action, job: input })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /对话.*不同/)
    assertNoWrites(fixture.calls)
    fixture.target.conversationId = 'original-conversation'
    assert.equal((await fixture.executor.execute({ action, job: input })).status, action === 'approve' ? 'completed' : 'awaiting_approval')
  }
})

test('unread or unsaved portfolios refuse agent, plan and save submissions', async () => {
  for (const targetChanges of [{ ready: false }, { filePath: '' }]) {
    for (const kind of ['agent', 'plan', 'save']) {
      const fixture = executorFixture()
      Object.assign(fixture.target, targetChanges)
      const result = await fixture.executor.execute({ action: 'run', job: job({ kind, response: { message: '测试', operations: [] } }) })
      assert.equal(result.status, 'failed')
      assert.match(result.error, /读取|\.qy/)
      assertNoWrites(fixture.calls)
    }
  }
})

test('busy editing and an existing preview prevent another run from replacing the pending plan', async () => {
  for (const config of [{ busy: () => true }, { pendingPlan: () => plan() }]) {
    const fixture = executorFixture(config)
    const result = await fixture.executor.execute({ action: 'run', job: job({ mode: 'inspiration' }) })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /执行|修改计划/)
    assertNoWrites(fixture.calls)
  }
})

test('Agent delegates the exact prompt, mode and API preset and does not approve its own preview', async () => {
  const fixture = executorFixture()
  const input = job({ mode: 'inspiration', prompt: '只聊剧情，暂时不要修改' })
  const result = await fixture.executor.execute({ action: 'run', job: input })
  assert.equal(result.status, 'awaiting_approval')
  assert.deepEqual(fixture.calls.run, [[input.prompt, { mode: 'inspiration', providerId: 'provider-one' }]])
  assert.equal(fixture.calls.approve.length, 0)
  assert.equal(fixture.calls.save.length, 0)
})

test('submitted JSON passes to the existing stage validator and propagates rejected operations unchanged', async () => {
  const response = { message: '修改锁定角色', operations: [{ action: 'update_resource', resourceType: 'character', target: '叶青', fields: { 性格: '冲动' } }] }
  const validationFailure = { status: 'failed', message: '计划包含锁定字段', error: '性格已被作者锁定' }
  let received
  const fixture = executorFixture({ stage: async (...args) => { received = args; return validationFailure } })
  const result = await fixture.executor.execute({ action: 'run', job: job({ kind: 'plan', response }) })
  assert.deepEqual(received, [response])
  assert.deepEqual(result, validationFailure)
  assert.equal(fixture.calls.run.length, 0)
  assert.equal(fixture.calls.approve.length, 0)
  assert.equal(fixture.calls.save.length, 0)
})

test('approval restores and revalidates the original plan before invoking the existing apply callback', async () => {
  const original = plan()
  const checkpointed = { status: 'completed', applied: true, afterFingerprint: 'sha256:after', changes: ['创建角色叶青'], plan: original }
  const order = []
  let staged
  let provider
  let savedCheckpoint
  const fixture = executorFixture({
    pendingPlan: () => ({ ...original }),
    stage: async (...args) => { staged = args; order.push('revalidate'); return { status: 'awaiting_approval', plan: original } },
    approve: async (checkpoint, selectedProvider) => {
      order.push('apply')
      provider = selectedProvider
      await checkpoint(checkpointed)
      order.push('save')
      return checkpointed
    },
    checkpoint: async (...args) => { savedCheckpoint = args; order.push('durable-checkpoint') },
  })
  const result = await fixture.executor.execute({ action: 'approve', job: job({ result: { status: 'awaiting_approval', plan: original } }) })
  assert.deepEqual(staged, [{ message: original.message, operations: original.operations }, original])
  assert.equal(provider, 'provider-one')
  assert.deepEqual(savedCheckpoint, ['job-one', checkpointed])
  assert.deepEqual(order, ['revalidate', 'apply', 'durable-checkpoint', 'save'])
  assert.equal(result.applied, true)
})

test('approval forwards the selected operation indexes to the existing apply callback', async () => {
  const original = plan()
  const fixture = executorFixture({
    pendingPlan: () => ({ ...original }),
    stage: async (...args) => ({ status: 'awaiting_approval', plan: args[1] || original }),
  })
  const result = await fixture.executor.execute({
    action: 'approve',
    operationIndexes: [0],
    job: job({ result: { status: 'awaiting_approval', plan: original } }),
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(fixture.calls.approve[0]?.[2], [0])
})

test('invalid, absent or conflicting pending previews cannot reach apply or save', async () => {
  for (const [fixture, input] of [
    [executorFixture(), job()],
    [executorFixture({ pendingPlan: () => ({ ...plan(), id: 'other-preview' }) }), job({ result: { status: 'awaiting_approval', plan: plan() } })],
    [executorFixture({ stage: async () => ({ status: 'failed', error: '作品内容指纹已改变' }) }), job({ result: { status: 'awaiting_approval', plan: plan() } })],
  ]) {
    const result = await fixture.executor.execute({ action: 'approve', job: input })
    assert.equal(result.status, 'failed')
    assert.equal(fixture.calls.approve.length, 0)
    assert.equal(fixture.calls.save.length, 0)
  }
})

test('switching the target while an approval is being revalidated prevents all mutations', async () => {
  const pending = deferred()
  const started = deferred()
  const fixture = executorFixture({ stage: async () => { started.resolve(); return pending.promise } })
  const execution = fixture.executor.execute({ action: 'approve', job: job({ result: { status: 'awaiting_approval', plan: plan() } }) })
  await started.promise
  fixture.target.projectId = 'another-project'
  pending.resolve({ status: 'awaiting_approval', plan: plan() })
  const result = await execution
  assert.equal(result.status, 'failed')
  assert.match(result.error, /不同/)
  assert.equal(fixture.calls.approve.length, 0)
  assert.equal(fixture.calls.save.length, 0)
})

test('a failed post-apply save preserves the applied checkpoint and exact changes for later recovery', async () => {
  const original = plan()
  const failure = { status: 'failed', applied: true, afterFingerprint: 'sha256:after', changes: ['创建角色叶青'], plan: original, error: '磁盘暂时不可写' }
  let checkpoint
  const fixture = executorFixture({
    approve: async (persist) => { await persist(failure); return failure },
    checkpoint: async (...args) => { checkpoint = args },
  })
  const result = await fixture.executor.execute({ action: 'approve', job: job({ result: { status: 'awaiting_approval', plan: original } }) })
  assert.deepEqual(result, failure)
  assert.deepEqual(checkpoint, ['job-one', failure])
})

test('applied recovery only saves matching checkpoint content and never runs, stages or applies again', async () => {
  for (const action of ['run', 'approve']) {
    const fixture = executorFixture()
    const applied = { status: 'failed', applied: true, afterFingerprint: 'sha256:after', changes: ['只创建过一次'], plan: plan(), error: '上次保存失败' }
    const result = await fixture.executor.execute({ action, job: job({ result: applied }) })
    assert.equal(result.status, 'completed')
    assert.equal(result.applied, true)
    assert.deepEqual(result.changes, ['只创建过一次'])
    assert.equal(result.error, undefined)
    assert.equal(fixture.calls.fingerprint.length, 1)
    assert.equal(fixture.calls.save.length, 1)
    for (const name of ['run', 'stage', 'approve', 'checkpoint']) assert.equal(fixture.calls[name].length, 0)
  }
})

test('applied recovery rejects missing or changed fingerprints without saving and retains the checkpoint', async () => {
  for (const afterFingerprint of [undefined, 'sha256:old-content']) {
    const fixture = executorFixture()
    const applied = { status: 'failed', applied: true, ...(afterFingerprint ? { afterFingerprint } : {}), changes: ['已经修改过'] }
    const result = await fixture.executor.execute({ action: 'run', job: job({ result: applied }) })
    assert.equal(result.status, 'failed')
    assert.equal(result.applied, true)
    assert.match(result.error, /保存断点与当前作品不一致/)
    assert.deepEqual(result.changes, applied.changes)
    assert.equal(fixture.calls.save.length, 0)
    assert.equal(fixture.calls.run.length, 0)
    assert.equal(fixture.calls.approve.length, 0)
  }
})

test('applied recovery validates the same portfolio and project but does not depend on selected chapter', async () => {
  const applied = { status: 'failed', applied: true, afterFingerprint: 'sha256:after' }
  const fixture = executorFixture()
  fixture.target.chapterId = 'another-chapter'
  fixture.target.conversationId = 'another-conversation'
  const input = job({ target: { ...job().target, conversationId: 'original-conversation' }, result: applied })
  assert.equal((await fixture.executor.execute({ action: 'run', job: input })).status, 'completed')
  fixture.target.portfolioId = 'different-portfolio'
  const failed = await fixture.executor.execute({ action: 'run', job: job({ result: applied }) })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.applied, true)
  assert.equal(fixture.calls.save.length, 1)
})

test('an applied save failure and a thrown save error both preserve recovery metadata', async () => {
  for (const save of [async () => false, async () => { throw new Error('假磁盘错误') }]) {
    const fixture = executorFixture({ save })
    const applied = { status: 'failed', applied: true, afterFingerprint: 'sha256:after', changes: ['已应用的修改'] }
    const result = await fixture.executor.execute({ action: 'run', job: job({ result: applied }) })
    assert.equal(result.status, 'failed')
    assert.equal(result.applied, true)
    assert.equal(result.afterFingerprint, applied.afterFingerprint)
    assert.deepEqual(result.changes, applied.changes)
    assert.match(result.error, /保存失败|磁盘错误/)
  }
})

test('cancel during awaited plan revalidation prevents approve and save even if stage later succeeds', async () => {
  const pending = deferred()
  const started = deferred()
  const fixture = executorFixture({ stage: async () => { started.resolve(); return pending.promise } })
  const input = job({ result: { status: 'awaiting_approval', plan: plan() } })
  const execution = fixture.executor.execute({ action: 'approve', job: input })
  await started.promise
  const cancel = await fixture.executor.execute({ action: 'cancel', job: input })
  assert.equal(cancel.status, 'completed')
  pending.resolve({ status: 'awaiting_approval', plan: plan() })
  const result = await execution
  assert.equal(result.status, 'failed')
  assert.match(result.error, /暂停|取消/)
  assert.deepEqual(fixture.calls.cancel, [['job-one']])
  assert.equal(fixture.calls.approve.length, 0)
  assert.equal(fixture.calls.save.length, 0)
})

test('cancel during awaited applied fingerprint calculation prevents every later save', async () => {
  const pending = deferred()
  const started = deferred()
  const fixture = executorFixture({ fingerprint: async () => { started.resolve(); return pending.promise } })
  const input = job({ result: { status: 'failed', applied: true, afterFingerprint: 'sha256:after', changes: ['已应用'] } })
  const execution = fixture.executor.execute({ action: 'run', job: input })
  await started.promise
  await fixture.executor.execute({ action: 'cancel', job: input })
  pending.resolve('sha256:after')
  const result = await execution
  assert.equal(result.status, 'failed')
  assert.equal(result.applied, true)
  assert.equal(result.afterFingerprint, 'sha256:after')
  assert.match(result.error, /暂停|取消/)
  assert.equal(fixture.calls.save.length, 0)
  assert.equal(fixture.calls.approve.length, 0)
})

test('cancel during an awaited Agent response cannot return its late preview as an accepted result', async () => {
  const pending = deferred()
  const started = deferred()
  const fixture = executorFixture({ run: async () => { started.resolve(); return pending.promise } })
  const input = job()
  const execution = fixture.executor.execute({ action: 'run', job: input })
  await started.promise
  await fixture.executor.execute({ action: 'cancel', job: input })
  pending.resolve({ status: 'awaiting_approval', plan: plan() })
  const result = await execution
  assert.equal(result.status, 'failed')
  assert.equal(result.plan, undefined)
  assert.match(result.error, /暂停|取消/)
  assert.equal(fixture.calls.approve.length, 0)
  assert.equal(fixture.calls.save.length, 0)
})

test('content fingerprints are stable SHA256 digests rather than copies of the complete writing data', async () => {
  const content = '{"chapter":"测试正文"}'
  const fingerprint = await contentFingerprint(content)
  assert.equal(fingerprint, `sha256:${createHash('sha256').update(content).digest('hex')}`)
  assert.equal(fingerprint.length, 71)
  assert.ok(!fingerprint.includes('测试正文'))
  assert.equal(await matchesFingerprint(fingerprint, () => content), true)
  assert.equal(await matchesFingerprint(fingerprint, () => `${content}已修改`), false)
  assert.equal(await matchesFingerprint(undefined, () => content), false)
})

test('an edit made during the asynchronous digest cannot pass fingerprint validation', async (t) => {
  let content = '原始内容'
  const expected = await contentFingerprint(content)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  const pending = deferred()
  const started = deferred()
  t.mock.method(globalThis.crypto.subtle, 'digest', async () => { started.resolve(); return pending.promise })
  const matching = matchesFingerprint(expected, () => content)
  await started.promise
  content = '作者已修改内容'
  pending.resolve(digest)
  assert.equal(await matching, false)
})

function inspectorFixture() {
  const portfolio = { id: 'portfolio-a', title: '测试作品集', path: 'E:/Fake/collection.qy', projectId: 'project-a', chapterId: 'chapter-a', ready: true }
  const privateFields = {
    'API Key': 'secret-spaced-key', apiKey: 'secret-camel-key', accessToken: 'secret-access',
    authorization: 'secret-header', password: 'secret-password', secret: 'secret-secret',
  }
  const provider = { id: 'provider-one', title: '安全的预设名称', model: 'fake-model', fields: { ...privateFields }, ...privateFields }
  const character = {
    id: 'character-a', title: '叶青', summary: '谨慎的修士',
    characterImages: [{ id: 'image-a', data: 'data:image/png;base64,private-image-a' }],
    characterCoverImageId: 'private-image-id-a',
    fields: { 性格: '坚韧', ...privateFields },
  }
  const projectA = {
    id: 'project-a', title: '作品A',
    store: {
      world: [{ id: 'world-a', title: '世界A', fields: { 内容: '作品A世界内容' } }],
      characters: [character], chapters: [{ id: 'chapter-a', content: '作品A正文' }],
      providers: [provider], modelOptions: { 'provider-one': ['fake-model'] },
      customModules: { schemas: [{ id: 'faction', fields: [{ key: 'faction-name', description: '势力名称' }] }], entries: [] },
    },
  }
  const projectB = {
    id: 'project-b', title: '作品B',
    store: {
      world: [{ id: 'world-b', title: '世界B', fields: { 内容: '作品B独立内容' } }],
      characters: [{ ...character, id: 'character-b', title: '沈寒' }],
      chapters: [{ id: 'chapter-b', content: '作品B独立正文' }],
      providers: [provider], modelOptions: { 'provider-one': ['fake-model'] },
    },
  }
  const projects = [projectA, projectB]
  const calls = { context: [], providers: 0, schema: [] }
  const inspector = createConsoleInspector({
    portfolio: () => ({ ...portfolio }),
    projects: () => projects,
    providers: () => { calls.providers += 1; return [provider] },
    schema: (collection) => { calls.schema.push(collection); return { collection, character, providers: [provider], resourceField: { key: 'title', description: '字段名称' } } },
    context: (query) => { calls.context.push(query); return { query, characters: [character], providers: [provider], nested: { ...privateFields } } },
  })
  return { inspector, portfolio, projects, provider, calls, privateFields }
}

function assertPrivateDataAbsent(value) {
  const text = JSON.stringify(value)
  for (const secret of ['secret-spaced-key', 'secret-camel-key', 'secret-access', 'secret-header', 'secret-password', 'secret-secret', 'private-image-a', 'private-image-id-a']) {
    assert.equal(text.includes(secret), false, `检查返回值泄漏了 ${secret}`)
  }
  assert.equal(text.includes('"characterImages"'), false)
  assert.equal(text.includes('"characterCoverImageId"'), false)
}

test('workspace projection removes provider settings, API credentials and character images recursively without changing the source', () => {
  const fixture = inspectorFixture()
  const before = structuredClone(fixture.projects)
  const result = fixture.inspector({ kind: 'workspace' })
  assert.equal(result.portfolioId, 'portfolio-a')
  assert.equal(result.projectId, 'project-a')
  assert.equal(result.store.characters[0].title, '叶青')
  assert.equal(result.store.characters[0].fields.性格, '坚韧')
  assert.equal('providers' in result.store, false)
  assert.equal('modelOptions' in result.store, false)
  assert.equal(result.store.customModules.schemas[0].fields[0].key, 'faction-name')
  assertPrivateDataAbsent(result)
  assert.deepEqual(fixture.projects, before)
  result.store.characters[0].title = '不能污染真实角色'
  assert.equal(fixture.projects[0].store.characters[0].title, '叶青')
})

test('workspace can statically inspect another work without selecting it or using the active work context', () => {
  const fixture = inspectorFixture()
  const before = structuredClone(fixture.portfolio)
  const result = fixture.inspector({ kind: 'workspace', projectId: 'project-b', collection: 'world' })
  assert.equal(result.projectId, 'project-b')
  assert.equal(result.title, '作品B')
  assert.equal(result.data[0].fields.内容, '作品B独立内容')
  assert.deepEqual(fixture.portfolio, before)
  assert.equal(fixture.calls.context.length, 0)
  assertPrivateDataAbsent(fixture.inspector({ kind: 'workspace', projectId: 'project-b' }))
  assert.throws(() => fixture.inspector({ kind: 'context', projectId: 'project-b', query: '沈寒' }), /打开目标作品/)
  assert.equal(fixture.calls.context.length, 0)
})

test('status lists only work identities and can describe a not-yet-ready editor without leaking content or settings', () => {
  const fixture = inspectorFixture()
  fixture.portfolio.ready = false
  const result = fixture.inspector({ kind: 'status' })
  assert.equal(result.ready, false)
  assert.equal(result.savedFile, true)
  assert.deepEqual(result.projects, [{ id: 'project-a', title: '作品A' }, { id: 'project-b', title: '作品B' }])
  assert.equal(JSON.stringify(result).includes('作品A正文'), false)
  assert.equal(JSON.stringify(result).includes('provider-one'), false)
  assertPrivateDataAbsent(result)
  assert.throws(() => fixture.inspector({ kind: 'workspace' }), /读取/)
})

test('schema and active context inspection omit images, provider payloads and nested secrets while preserving field definitions', () => {
  const fixture = inspectorFixture()
  const schema = fixture.inspector({ kind: 'schema', collection: 'characters' })
  assert.deepEqual(fixture.calls.schema, ['characters'])
  assert.equal(schema.resourceField.key, 'title')
  assert.equal('providers' in schema, false)
  assertPrivateDataAbsent(schema)
  const context = fixture.inspector({ kind: 'context', query: '叶青持有的道具' })
  assert.deepEqual(fixture.calls.context, ['叶青持有的道具'])
  assert.equal(context.characters[0].title, '叶青')
  assert.equal('providers' in context, false)
  assertPrivateDataAbsent(context)
})

test('provider inspection independently excludes credentials and image payloads even if its callback returns full presets', () => {
  const fixture = inspectorFixture()
  const result = fixture.inspector({ kind: 'providers' })
  assert.equal(fixture.calls.providers, 1)
  assert.equal(result[0].id, 'provider-one')
  assert.equal(result[0].model, 'fake-model')
  assertPrivateDataAbsent(result)
})

test('credential projection handles conventional API key casing and separators while retaining ordinary custom field keys', () => {
  const result = consoleProjection({
    APIKey: 'case-api-key', API_KEY: 'underscore-api-key', 'api-key': 'hyphen-api-key',
    api_key: 'lower-api-key', Authorization: 'case-auth', access_token: 'underscore-token',
    nested: { field: { key: 'safe-custom-key', label: '模型可编辑字段' } },
  })
  const text = JSON.stringify(result)
  for (const secret of ['case-api-key', 'underscore-api-key', 'hyphen-api-key', 'lower-api-key', 'case-auth', 'underscore-token']) {
    assert.equal(text.includes(secret), false, `秘密字段未被过滤：${secret}`)
  }
  assert.equal(result.nested.field.key, 'safe-custom-key')
})

test('inspector rejects software-settings collections and nonexistent work identities', () => {
  const fixture = inspectorFixture()
  for (const collection of ['providers', 'modelOptions', 'settings', '__proto__']) {
    assert.throws(() => fixture.inspector({ kind: 'workspace', collection }), /不支持/)
  }
  assert.throws(() => fixture.inspector({ kind: 'workspace', projectId: 'missing-work' }), /没有这个作品/)
})
