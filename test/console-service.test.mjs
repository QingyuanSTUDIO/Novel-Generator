import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CONSOLE_LIMITS, createConsoleService } from '../electron/console-service.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function waitFor(check, message = '等待任务状态') {
  const expires = Date.now() + 5000
  while (!check()) {
    if (Date.now() > expires) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-console-'))
  const service = createConsoleService({
    storagePath: path.join(root, 'console-jobs.json'),
    endpointPath: path.join(root, 'console-endpoint.json'),
    execute: async () => ({ status: 'completed', message: '已保存' }),
    inspect: async () => ({ portfolioId: 'portfolio-a', projectId: 'project-a' }),
    ...options,
  })
  await service.start()
  t.after(async () => {
    await service.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { service, root, storagePath: path.join(root, 'console-jobs.json'), endpointPath: path.join(root, 'console-endpoint.json') }
}

const target = { portfolioId: 'portfolio-a', projectId: 'project-a' }
const agent = (prompt = '创建角色', extra = {}) => ({ kind: 'agent', ...target, prompt, ...extra })

test('write submissions require explicit targets, bounded JSON and valid modes', async (t) => {
  const { service } = await setup(t)
  await assert.rejects(service.submit({ kind: 'agent', prompt: '创建角色' }), /作品集/)
  await assert.rejects(service.submit({ kind: 'agent', portfolioId: 'p', prompt: '创建角色' }), /作品 ID/)
  await assert.rejects(service.submit(agent('', {})), /填写要求/)
  await assert.rejects(service.submit(agent('要求', { mode: 'unknown' })), /模式/)
  await assert.rejects(service.submit({ kind: 'plan', ...target }), /返回结构/)
  await assert.rejects(service.submit(agent('x'.repeat(CONSOLE_LIMITS.requestBytes))), { code: 'PAYLOAD_TOO_LARGE' })
  assert.equal(service.list().length, 0)
})

test('accepted jobs are durable snapshots and request IDs deduplicate exact submissions', async (t) => {
  const run = deferred()
  const { service, storagePath } = await setup(t, { execute: async ({ action }) => action === 'cancel' ? run.resolve({ status: 'failed', error: '已中止' }) : run.promise })
  const input = agent('创建人物', { requestId: 'client-one' })
  const job = await service.submit(input)
  const saved = JSON.parse(await fs.readFile(storagePath, 'utf8'))
  assert.equal(saved.jobs[0].id, job.id)
  job.prompt = '外部修改不能污染任务'
  job.target.projectId = 'other'
  assert.equal(service.get(job.id).prompt, '创建人物')
  assert.equal(service.get(job.id).target.projectId, 'project-a')
  const duplicate = await service.submit(input)
  assert.equal(duplicate.id, job.id)
  assert.equal(service.list().length, 1)
  await assert.rejects(service.submit(agent('另一个要求', { requestId: 'client-one' })), { code: 'REQUEST_ID_CONFLICT' })
  run.resolve({ status: 'completed' })
  await waitFor(() => service.get(job.id).status === 'completed')
})

test('conversation target is validated, normalized and participates in idempotent submission identity', async (t) => {
  const { service, storagePath } = await setup(t)
  for (const conversationId of [null, 42, true, '', '   ', 'bad\nid', 'x'.repeat(201), { id: 'a' }]) {
    await assert.rejects(service.submit(agent('创建人物', { conversationId })), /对话 ID/)
  }
  assert.equal(service.list().length, 0)
  const input = agent('创建人物', { conversationId: ' conversation-a ', requestId: 'conversation-request' })
  const created = await service.submit(input)
  assert.equal(created.target.conversationId, 'conversation-a')
  assert.equal('conversationId' in created, false)
  const disk = JSON.parse(await fs.readFile(storagePath, 'utf8'))
  assert.equal(disk.jobs.find((item) => item.id === created.id).target.conversationId, 'conversation-a')
  const duplicate = await service.submit({ ...input, conversationId: 'conversation-a' })
  assert.equal(duplicate.id, created.id)
  await assert.rejects(service.submit({ ...input, conversationId: 'conversation-b' }), { code: 'REQUEST_ID_CONFLICT' })
  await assert.rejects(service.submit({ ...input, conversationId: undefined }), { code: 'REQUEST_ID_CONFLICT' })
  assert.equal(service.list().length, 1)
  await waitFor(() => service.get(created.id).status === 'completed')
  const external = await service.submit(agent('CLI 兼容任务'))
  assert.equal('conversationId' in external.target, false)
  await waitFor(() => service.get(external.id).status === 'completed')
})

test('conversation binding survives pause, restart, preview recovery and approval without changing its original target', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-console-conversation-'))
  const storagePath = path.join(root, 'jobs.json')
  const endpointPath = path.join(root, 'endpoint.json')
  const services = []
  t.after(async () => {
    for (const service of services.reverse()) await service.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const original = createConsoleService({
    storagePath, endpointPath,
    execute: async () => ({ status: 'awaiting_approval', plan: { id: 'original-preview', operations: [], storeFingerprint: 'original-content' } }),
    inspect: async () => ({}),
  })
  services.push(original)
  await original.start()
  const submitted = await original.submit(agent('对话中的原始要求', { chapterId: 'chapter-a', conversationId: 'conversation-a', requestId: 'conversation-restart' }))
  await waitFor(() => original.get(submitted.id).status === 'awaiting_approval')
  await original.close()
  const calls = []
  const restarted = createConsoleService({
    storagePath, endpointPath,
    execute: async (command) => { calls.push(command); return { status: 'completed' } },
    inspect: async () => ({}),
  })
  services.push(restarted)
  await restarted.start()
  assert.equal(restarted.get(submitted.id).status, 'paused')
  assert.deepEqual(restarted.get(submitted.id).target, { ...target, chapterId: 'chapter-a', conversationId: 'conversation-a' })
  const duplicate = await restarted.submit(agent('对话中的原始要求', { chapterId: 'chapter-a', conversationId: 'conversation-a', requestId: 'conversation-restart' }))
  assert.equal(duplicate.id, submitted.id)
  assert.equal(duplicate.status, 'paused')
  await assert.rejects(restarted.submit(agent('对话中的原始要求', { chapterId: 'chapter-a', conversationId: 'conversation-b', requestId: 'conversation-restart' })), { code: 'REQUEST_ID_CONFLICT' })
  const restored = await restarted.resume(submitted.id)
  assert.equal(restored.status, 'awaiting_approval')
  assert.equal(calls.length, 0)
  await restarted.approve(submitted.id)
  await waitFor(() => restarted.get(submitted.id).status === 'completed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'approve')
  assert.equal(calls[0].job.target.conversationId, 'conversation-a')
  assert.equal(calls[0].job.result.plan.id, 'original-preview')
})

test('invalid persisted conversation identifiers are rejected without overwriting the task record', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-console-invalid-conversation-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const storagePath = path.join(root, 'jobs.json')
  const endpointPath = path.join(root, 'endpoint.json')
  const now = Date.now()
  for (const conversationId of [null, 42, '', ' ', 'bad\nid', 'x'.repeat(201), ' padded-id ']) {
    const text = JSON.stringify({
      version: 1,
      jobs: [{ id: 'bad-conversation', kind: 'agent', target: { ...target, conversationId }, prompt: '测试要求', mode: 'writing', status: 'paused', createdAt: now, updatedAt: now, events: [] }],
    })
    await fs.writeFile(storagePath, text)
    const service = createConsoleService({ storagePath, endpointPath, execute: async () => ({ status: 'completed' }), inspect: async () => ({}) })
    await assert.rejects(service.start(), /任务对话标识损坏.*原文件已保留/)
    assert.equal(await fs.readFile(storagePath, 'utf8'), text)
  }
})

test('serial queue blocks behind a pending plan and approve reuses the original target', async (t) => {
  const calls = []
  const first = deferred()
  const approveRun = deferred()
  const { service } = await setup(t, {
    execute: async (command) => {
      calls.push(command)
      if (command.action === 'cancel') return { status: 'completed' }
      if (command.action === 'approve') return approveRun.promise
      if (command.job.prompt === '第一任务') return first.promise
      return { status: 'completed' }
    },
  })
  const one = await service.submit(agent('第一任务'))
  const two = await service.submit(agent('第二任务', { mode: 'inspiration' }))
  await waitFor(() => calls.length === 1)
  assert.equal(service.get(two.id).status, 'queued')
  first.resolve({ status: 'awaiting_approval', plan: { operations: [{ action: 'create_chapter' }], storeFingerprint: 'sha256-a' } })
  await waitFor(() => service.get(one.id).status === 'awaiting_approval')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.length, 1)
  const accepted = await service.approve(one.id)
  assert.equal(accepted.status, 'queued')
  await waitFor(() => calls.length === 2)
  assert.equal(calls[1].action, 'approve')
  assert.deepEqual(calls[1].job.target, target)
  assert.equal(calls[1].job.result.plan.storeFingerprint, 'sha256-a')
  approveRun.resolve({ status: 'completed', changes: ['新建章节'] })
  await waitFor(() => service.get(two.id).status === 'completed')
  assert.equal(calls[2].job.id, two.id)
})

test('pause and resume retain a generated plan instead of generating it again', async (t) => {
  let generations = 0
  const { service } = await setup(t, {
    execute: async ({ action }) => {
      if (action === 'run') generations += 1
      return { status: 'awaiting_approval', plan: { operations: [], storeFingerprint: 'same-content' } }
    },
  })
  const submitted = await service.submit(agent())
  await waitFor(() => service.get(submitted.id).status === 'awaiting_approval')
  await service.pause(submitted.id)
  const resumed = await service.resume(submitted.id)
  assert.equal(resumed.status, 'awaiting_approval')
  assert.equal(resumed.result.plan.storeFingerprint, 'same-content')
  assert.equal(generations, 1)
})

test('a new explicit submission after suspend starts normally without resuming any old paused job', async (t) => {
  const calls = []
  const { service } = await setup(t, {
    execute: async ({ action, job }) => {
      if (action === 'cancel') return { status: 'completed' }
      calls.push(job.id)
      return job.prompt === '旧任务'
        ? { status: 'awaiting_approval', plan: { id: 'old-plan', operations: [] } }
        : { status: 'completed', message: '新任务已完成' }
    },
  })
  const old = await service.submit(agent('旧任务'))
  await waitFor(() => service.get(old.id).status === 'awaiting_approval')
  await service.suspend()
  assert.equal(service.get(old.id).status, 'paused')
  assert.equal((await service.inspect({ kind: 'status' })).console.suspended, true)
  const fresh = await service.submit(agent('退出已取消，提交新任务'))
  await waitFor(() => service.get(fresh.id).status === 'completed')
  assert.equal((await service.inspect({ kind: 'status' })).console.suspended, false)
  assert.equal(service.get(old.id).status, 'paused')
  assert.equal(service.get(old.id).result.plan.id, 'old-plan')
  assert.deepEqual(calls, [old.id, fresh.id])
})

test('a resumed preview can be explicitly approved after a global suspend while other old jobs stay paused', async (t) => {
  const calls = []
  const { service } = await setup(t, {
    execute: async ({ action, job }) => {
      calls.push({ action, id: job.id })
      return action === 'run'
        ? { status: 'awaiting_approval', plan: { id: 'saved-preview', operations: [] } }
        : { status: 'completed' }
    },
  })
  const old = await service.submit(agent('保留预览'))
  const next = await service.submit(agent('旧排队任务'))
  await waitFor(() => service.get(old.id).status === 'awaiting_approval')
  await service.suspend()
  await service.resume(old.id)
  await service.approve(old.id)
  await waitFor(() => service.get(old.id).status === 'completed')
  assert.equal(service.get(next.id).status, 'paused')
  assert.deepEqual(calls, [{ action: 'run', id: old.id }, { action: 'approve', id: old.id }])
})

test('cancel and pause ignore late results and hold the serial slot until the old run settles', async (t) => {
  const original = deferred()
  const calls = []
  const { service } = await setup(t, {
    execute: async (command) => {
      calls.push(command)
      if (command.action === 'cancel') return { status: 'completed' }
      if (calls.filter((call) => call.action === 'run').length === 1) return original.promise
      return { status: 'completed' }
    },
  })
  const one = await service.submit(agent('暂停任务'))
  await waitFor(() => service.get(one.id).status === 'running')
  await service.pause(one.id)
  await service.resume(one.id)
  const two = await service.submit(agent('下一任务'))
  await waitFor(() => calls.some((call) => call.action === 'cancel'))
  assert.equal(calls.filter((call) => call.action === 'run').length, 1)
  original.resolve({ status: 'awaiting_approval', plan: { operations: [{ action: 'late-change' }] } })
  await waitFor(() => service.get(two.id).status === 'completed')
  assert.equal(service.get(one.id).status, 'completed')
  assert.equal(service.get(one.id).result.plan, undefined)
  assert.equal(calls.filter((call) => call.action === 'run').length, 3)
})

test('pausing from a persisted running notification prevents dispatch from starting', async (t) => {
  let runs = 0
  const { service } = await setup(t, { execute: async ({ action }) => { if (action === 'run') runs += 1; return { status: 'completed' } } })
  let control
  const unsubscribe = service.subscribe((jobs) => {
    const running = jobs.find((job) => job.status === 'running')
    if (running && !control) control = service.pause(running.id)
  })
  const job = await service.submit(agent())
  await waitFor(() => Boolean(control))
  await control
  await service.waitForIdle()
  assert.equal(service.get(job.id).status, 'paused')
  assert.equal(runs, 0)
  unsubscribe()
})

test('applied checkpoint is on disk before saving and a failed save replays only the checkpoint', async (t) => {
  let service
  let writes = 0
  let runs = 0
  const fixture = await setup(t, {
    execute: async ({ action, job }) => {
      if (action === 'cancel') return { status: 'completed' }
      runs += 1
      if (!job.result?.applied) {
        writes += 1
        await service.checkpoint(job.id, { applied: true, afterFingerprint: 'sha-after', changes: ['已创建章节'], plan: { operations: [] } })
        const disk = JSON.parse(await fs.readFile(fixture.storagePath, 'utf8')).jobs.find((item) => item.id === job.id)
        assert.equal(disk.status, 'saving')
        assert.equal(disk.result.applied, true)
        return { status: 'failed', error: '保存失败' }
      }
      assert.equal(job.result.afterFingerprint, 'sha-after')
      return { status: 'completed', message: '仅保存断点' }
    },
  })
  service = fixture.service
  const job = await service.submit(agent())
  await waitFor(() => service.get(job.id).status === 'failed')
  assert.equal(service.get(job.id).result.applied, true)
  await service.resume(job.id)
  await waitFor(() => service.get(job.id).status === 'completed')
  assert.equal(writes, 1)
  assert.equal(runs, 2)
  assert.equal(service.get(job.id).result.afterFingerprint, 'sha-after')
  await assert.rejects(service.approve(job.id), { code: 'INVALID_JOB_STATE' })
})

test('restart pauses in-flight and queued jobs and never invokes the executor automatically', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-console-restart-'))
  const storagePath = path.join(root, 'jobs.json')
  const endpointPath = path.join(root, 'endpoint.json')
  const now = Date.now()
  const base = { ...agent(), id: 'saved-one', target, mode: 'writing', createdAt: now, updatedAt: now, events: [] }
  delete base.portfolioId
  delete base.projectId
  await fs.writeFile(storagePath, JSON.stringify({
    version: 1,
    jobs: [
      { ...base, status: 'saving', result: { status: 'completed', applied: true, afterFingerprint: 'after-content', changes: ['已应用一次'] } },
      { ...base, id: 'saved-two', status: 'queued' },
    ],
  }))
  let calls = 0
  const service = createConsoleService({ storagePath, endpointPath, execute: async ({ job }) => {
    calls += 1
    assert.equal(job.result.applied, true)
    return { status: 'completed' }
  }, inspect: async () => ({}) })
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }) })
  await service.start()
  assert.equal(service.get('saved-one').status, 'paused')
  assert.equal(service.get('saved-two').status, 'paused')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls, 0)
  await service.resume('saved-one')
  await waitFor(() => service.get('saved-one').status === 'completed')
  assert.equal(calls, 1)
  assert.equal(service.get('saved-two').status, 'paused')
})

test('bounded event tails preserve monotonically increasing sequences', async (t) => {
  const run = deferred()
  const { service } = await setup(t, { execute: async ({ action }) => action === 'cancel' ? run.resolve({ status: 'failed' }) : run.promise })
  const job = await service.submit(agent())
  await waitFor(() => service.get(job.id).status === 'running')
  await Promise.all(Array.from({ length: 205 }, (_, index) => service.report(job.id, { title: `步骤 ${index}`, state: 'running' })))
  const events = service.get(job.id).events
  assert.equal(events.length, 200)
  assert.ok(events[0].sequence > 1)
  for (let index = 1; index < events.length; index += 1) assert.equal(events[index].sequence, events[index - 1].sequence + 1)
  run.resolve({ status: 'completed' })
  await waitFor(() => service.get(job.id).status === 'completed')
})

test('job history prunes completed entries but protects paused and unapplied-save checkpoints', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-console-capacity-'))
  const storagePath = path.join(root, 'jobs.json')
  const endpointPath = path.join(root, 'endpoint.json')
  const now = Date.now()
  const jobs = Array.from({ length: 200 }, (_, index) => ({
    id: `old-${index}`, kind: 'save', target, prompt: '', mode: 'writing',
    status: index === 0 ? 'failed' : 'paused', createdAt: now, updatedAt: now, events: [],
    ...(index === 0 ? { result: { status: 'failed', applied: true, afterFingerprint: 'unsaved-content' } } : {}),
  }))
  await fs.writeFile(storagePath, JSON.stringify({ version: 1, jobs }))
  const service = createConsoleService({ storagePath, endpointPath, execute: async () => ({ status: 'completed' }), inspect: async () => ({}) })
  await service.start()
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }) })
  await assert.rejects(service.submit(agent()), { code: 'QUEUE_FULL' })
  assert.equal(service.get('old-0').result.afterFingerprint, 'unsaved-content')
  await service.cancel('old-1')
  const newer = await service.submit(agent())
  assert.equal(service.list().length, 200)
  assert.throws(() => service.get('old-1'), { code: 'JOB_NOT_FOUND' })
  assert.equal(service.get('old-0').result.applied, true)
  await waitFor(() => service.get(newer.id).status === 'completed')
})

test('close allows an already committed mutation to persist its checkpoint and finish saving', async (t) => {
  const gate = deferred()
  let service
  let mutationStarted = false
  let saved = false
  const fixture = await setup(t, {
    execute: async ({ action, job }) => {
      if (action === 'cancel') { gate.resolve(); return { status: 'completed' } }
      mutationStarted = true
      await gate.promise
      await service.checkpoint(job.id, { applied: true, afterFingerprint: 'already-applied', changes: ['修改已经提交'] })
      saved = true
      return { status: 'completed', applied: true, afterFingerprint: 'already-applied' }
    },
  })
  service = fixture.service
  const job = await service.submit(agent())
  await waitFor(() => mutationStarted)
  await service.close()
  const persisted = JSON.parse(await fs.readFile(fixture.storagePath, 'utf8')).jobs.find((item) => item.id === job.id)
  assert.equal(saved, true)
  assert.equal(persisted.status, 'paused')
  assert.equal(persisted.result.applied, true)
  assert.equal(persisted.result.afterFingerprint, 'already-applied')
})

test('inspect strips API secrets and job snapshots do not expose endpoint credentials', async (t) => {
  const { service, endpointPath } = await setup(t, {
    inspect: async () => ({ providers: [{ id: 'one', apiKey: 'secret-a', key: 'secret-b', fields: { API_KEY: 'secret-c' }, token: 'secret-d' }], portfolioId: 'p' }),
  })
  const endpoint = JSON.parse(await fs.readFile(endpointPath, 'utf8'))
  const data = await service.inspect({ kind: 'providers' })
  assert.deepEqual(data.providers, [{ id: 'one', fields: {} }])
  assert.ok(!JSON.stringify(await service.inspect({ kind: 'status' })).includes(endpoint.token))
  assert.ok(!JSON.stringify(service.list()).includes(endpoint.token))
})

test('HTTP requires bearer authentication, rejects browser origins and exposes bounded job commands', async (t) => {
  const { service, endpointPath } = await setup(t)
  const endpoint = JSON.parse(await fs.readFile(endpointPath, 'utf8'))
  const url = `http://127.0.0.1:${endpoint.port}`
  const headers = { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }
  assert.equal((await fetch(`${url}/v1/jobs`)).status, 401)
  assert.equal((await fetch(`${url}/v1/jobs`, { headers: { ...headers, origin: 'https://other.example' } })).status, 403)
  const submitted = await fetch(`${url}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify(agent()) })
  assert.equal(submitted.status, 202)
  const { job } = await submitted.json()
  assert.equal((await fetch(`${url}/v1/jobs/${job.id}`, { headers })).status, 200)
  assert.equal((await fetch(`${url}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({ ...agent(), prompt: 'x'.repeat(CONSOLE_LIMITS.requestBytes) }) })).status, 413)
  assert.equal((await fetch(`${url}/v1/jobs`, { method: 'POST', headers, body: '{broken' })).status, 400)
  await waitFor(() => service.get(job.id).status === 'completed')
})

test('invalid persisted jobs fail without overwriting the original record', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-console-invalid-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const storagePath = path.join(root, 'jobs.json')
  const text = '{"version":1,"jobs":[{"id":"broken"}]}'
  await fs.writeFile(storagePath, text)
  const service = createConsoleService({
    storagePath, endpointPath: path.join(root, 'endpoint.json'),
    execute: async () => ({ status: 'completed' }), inspect: async () => ({}),
  })
  await assert.rejects(service.start(), /原文件已保留/)
  assert.equal(await fs.readFile(storagePath, 'utf8'), text)
})

test('close removes its endpoint, uses a fresh bearer next start and leaves no shared temporary files', async (t) => {
  const fixture = await setup(t)
  const first = JSON.parse(await fs.readFile(fixture.endpointPath, 'utf8'))
  await fixture.service.close()
  await assert.rejects(fs.access(fixture.endpointPath), { code: 'ENOENT' })
  const second = createConsoleService({
    storagePath: fixture.storagePath, endpointPath: fixture.endpointPath,
    execute: async () => ({ status: 'completed' }), inspect: async () => ({}),
  })
  await second.start()
  t.after(() => second.close())
  const endpoint = JSON.parse(await fs.readFile(fixture.endpointPath, 'utf8'))
  assert.notEqual(first.token, endpoint.token)
  assert.equal((await fs.readdir(fixture.root)).filter((name) => name.endsWith('.tmp')).length, 0)
})
