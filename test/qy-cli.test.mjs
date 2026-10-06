import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createConsoleService } from '../electron/console-service.mjs'
import { defaultEndpointPath, runCli } from '../scripts/qy-cli.mjs'

function capture() {
  const stdout = []
  const stderr = []
  return {
    stdout, stderr,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  }
}

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-cli-'))
  const endpointPath = path.join(root, 'console-endpoint.json')
  const service = createConsoleService({
    storagePath: path.join(root, 'console-jobs.json'), endpointPath,
    execute: async () => ({ status: 'completed' }),
    inspect: async ({ kind, collection, query }) => ({ kind, collection, query, portfolioId: 'portfolio', projectId: 'project' }),
    ...options,
  })
  await service.start()
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, endpointPath, service, env: { QY_CLI_ENDPOINT: endpointPath } }
}

async function waitFor(check) {
  const until = Date.now() + 5000
  while (!check()) {
    if (Date.now() > until) throw new Error('等待 CLI 任务状态超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('help needs no running desktop service and explains explicit write targets', async () => {
  const output = capture()
  const code = await runCli(['help'], { ...output.io, readFile: async () => { throw new Error('不应该读取连接文件') } })
  assert.equal(code, 0)
  assert.match(output.stdout.join(''), /不直接修改 \.qy/)
  assert.match(output.stdout.join(''), /--portfolio ID --project ID/)
})

test('endpoint environment override and Windows application-data default are resolved locally', () => {
  assert.equal(defaultEndpointPath({ QY_CLI_ENDPOINT: 'custom-endpoint.json' }), path.resolve('custom-endpoint.json'))
  assert.equal(defaultEndpointPath({ APPDATA: path.join('app', 'data') }), path.join('app', 'data', 'novel-generator', 'console-endpoint.json'))
})

test('missing targets and invalid flags fail before touching a file or network', async () => {
  for (const args of [
    ['agent', 'run', '--prompt', '要求', '--json'],
    ['save', '--portfolio', 'p', '--json'],
    ['agent', 'run', '--prompt', '要求', '--portfolio', 'p', '--project', 'a', '--mode', 'unknown', '--json'],
    ['providers', '--prompt', '错误选项', '--json'],
    ['jobs', 'approve', '--json'],
  ]) {
    const output = capture()
    let reads = 0
    const code = await runCli(args, { ...output.io, readFile: async () => { reads += 1; throw new Error('不该读取') }, fetchImpl: async () => { throw new Error('不该联网') } })
    assert.equal(code, 1)
    assert.equal(reads, 0)
    assert.equal(JSON.parse(output.stderr.join('')).error.code, 'INVALID_ARGUMENT')
  }
})

test('CLI status, context, workspace and schemas use the authenticated local service', async (t) => {
  const fixture = await setup(t)
  for (const [args, kind, query, collection] of [
    [['status'], 'status'],
    [['context', '--query', '叶青'], 'context', '叶青'],
    [['inspect', '--collection', 'characters'], 'workspace', undefined, 'characters'],
    [['schema', '--collection', 'skills'], 'schema', undefined, 'skills'],
  ]) {
    const output = capture()
    assert.equal(await runCli([...args, '--json'], { ...output.io, env: fixture.env }), 0)
    const payload = JSON.parse(output.stdout.join(''))
    assert.equal(payload.kind, kind)
    assert.equal(payload.query, query)
    assert.equal(payload.collection, collection)
    assert.equal(output.stderr.length, 0)
  }
})

test('agent run and save bind exact targets and request IDs without modifying a .qy directly', async (t) => {
  const fixture = await setup(t)
  const originalPath = path.join(fixture.root, 'portfolio.qy')
  const text = '{"this":"must only be modified by the workspace adapter"}\n'
  await fs.writeFile(originalPath, text)
  const output = capture()
  const args = ['agent', 'run', '--prompt', '创建人物', '--portfolio', 'portfolio', '--project', 'project', '--chapter', 'chapter', '--api', 'preset', '--mode', 'inspiration', '--request-id', 'same-request', '--json']
  assert.equal(await runCli(args, { ...output.io, env: fixture.env }), 0)
  const first = JSON.parse(output.stdout.join(''))
  assert.deepEqual(first.target, { portfolioId: 'portfolio', projectId: 'project', chapterId: 'chapter' })
  assert.equal(first.providerId, 'preset')
  assert.equal(first.mode, 'inspiration')
  const duplicate = capture()
  assert.equal(await runCli(args, { ...duplicate.io, env: fixture.env }), 0)
  assert.equal(JSON.parse(duplicate.stdout.join('')).id, first.id)
  const saveOutput = capture()
  assert.equal(await runCli(['save', '--portfolio', 'portfolio', '--project', 'project', '--json'], { ...saveOutput.io, env: fixture.env }), 0)
  const saveJob = JSON.parse(saveOutput.stdout.join(''))
  assert.equal(saveJob.kind, 'save')
  await waitFor(() => fixture.service.get(saveJob.id).status === 'completed')
  assert.equal(await fs.readFile(originalPath, 'utf8'), text)
})

test('--current reads status once and fixes its IDs even when the desktop changes target before submission', async () => {
  const output = capture()
  const requests = []
  let selected = { portfolioId: 'original-portfolio', projectId: 'original-project' }
  const code = await runCli(['agent', 'run', '--current', '--prompt', '创建角色', '--chapter', 'explicit-chapter', '--api', 'preset', '--mode', 'inspiration', '--json'], {
    ...output.io,
    readFile: async () => JSON.stringify({ version: 1, port: 1234, token: 'c'.repeat(64), pid: 123 }),
    fetchImpl: async (url, request) => {
      requests.push({ url, method: request.method, ...(request.body ? { body: JSON.parse(request.body) } : {}) })
      if (request.method === 'GET') {
        const snapshot = { ready: true, filePath: 'E:/Fake/original.qy', ...selected }
        selected = { portfolioId: 'new-portfolio', projectId: 'new-project' }
        return Response.json({ data: snapshot })
      }
      const body = JSON.parse(request.body)
      assert.deepEqual(selected, { portfolioId: 'new-portfolio', projectId: 'new-project' })
      return Response.json({ job: { id: 'bound-job', target: { portfolioId: body.portfolioId, projectId: body.projectId, chapterId: body.chapterId }, status: 'queued' } }, { status: 202 })
    },
  })
  assert.equal(code, 0)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/v1/inspect?kind=status')
  assert.equal(requests[1].method, 'POST')
  assert.equal(requests[1].body.portfolioId, 'original-portfolio')
  assert.equal(requests[1].body.projectId, 'original-project')
  assert.equal(requests[1].body.chapterId, 'explicit-chapter')
  assert.equal(requests[1].body.providerId, 'preset')
  assert.equal(requests[1].body.mode, 'inspiration')
  assert.deepEqual(JSON.parse(output.stdout.join('')).target, { portfolioId: 'original-portfolio', projectId: 'original-project', chapterId: 'explicit-chapter' })
})

test('--current supports agent, plan and save against an already saved local workspace', async (t) => {
  let reads = 0
  const fixture = await setup(t, {
    inspect: async ({ kind }) => {
      assert.equal(kind, 'status')
      reads += 1
      return { ready: true, filePath: 'E:/Fake/current.qy', portfolioId: 'current-portfolio', projectId: 'current-project' }
    },
  })
  const filePath = path.join(fixture.root, 'response.json')
  await fs.writeFile(filePath, JSON.stringify({ message: '计划', operations: [] }))
  for (const [args, kind] of [
    [['agent', 'run', '--current', '--prompt', '整理人物'], 'agent'],
    [['plan', 'submit', '--current', '--file', filePath], 'plan'],
    [['save', '--current'], 'save'],
  ]) {
    const output = capture()
    assert.equal(await runCli([...args, '--json'], { ...output.io, env: fixture.env }), 0)
    const submitted = JSON.parse(output.stdout.join(''))
    assert.equal(submitted.kind, kind)
    assert.deepEqual(submitted.target, { portfolioId: 'current-portfolio', projectId: 'current-project' })
    await waitFor(() => fixture.service.get(submitted.id).status === 'completed')
  }
  assert.equal(reads, 3)
})

test('--current rejects conflicting explicit IDs and refuses incomplete, unread or unsaved current state before writing', async () => {
  for (const options of [['--portfolio', 'p'], ['--project', 'a'], ['--portfolio', 'p', '--project', 'a']]) {
    const output = capture()
    let reads = 0
    let requests = 0
    assert.equal(await runCli(['save', '--current', ...options, '--json'], {
      ...output.io,
      readFile: async () => { reads += 1; throw new Error('不该读取') },
      fetchImpl: async () => { requests += 1; throw new Error('不该连接') },
    }), 1)
    assert.equal(reads, 0)
    assert.equal(requests, 0)
    assert.match(JSON.parse(output.stderr.join('')).error.message, /不能.*同时使用/)
  }
  for (const status of [
    { ready: false, filePath: 'E:/Fake/a.qy', portfolioId: 'p', projectId: 'a' },
    { ready: true, filePath: '', portfolioId: 'p', projectId: 'a' },
    { ready: true, filePath: 'E:/Fake/a.qy', portfolioId: null, projectId: 'a' },
    { ready: true, filePath: 'E:/Fake/a.qy', portfolioId: 'p', projectId: '' },
  ]) {
    const output = capture()
    const requests = []
    assert.equal(await runCli(['agent', 'run', '--current', '--prompt', '要求', '--json'], {
      ...output.io,
      readFile: async () => JSON.stringify({ version: 1, port: 1234, token: 'd'.repeat(64), pid: 1 }),
      fetchImpl: async (_url, request) => { requests.push(request.method); return Response.json({ data: status }) },
    }), 1)
    assert.deepEqual(requests, ['GET'])
    assert.equal(JSON.parse(output.stderr.join('')).error.code, 'CURRENT_TARGET_UNAVAILABLE')
  }
})

test('plan file becomes a reviewable task, approve and job commands reuse its durable job ID', async (t) => {
  const fixture = await setup(t, {
    execute: async ({ action, job }) => action === 'run'
      ? { status: 'awaiting_approval', message: '等待确认', plan: { operations: job.response.operations, storeFingerprint: 'original' } }
      : { status: 'completed', changes: ['已创建角色'] },
  })
  const filePath = path.join(fixture.root, 'response.json')
  await fs.writeFile(filePath, JSON.stringify({ message: '创建角色', operations: [{ action: 'create_resource', resourceType: 'character', title: '叶青' }] }))
  const output = capture()
  assert.equal(await runCli(['plan', 'submit', '--file', filePath, '--portfolio', 'portfolio', '--project', 'project', '--json'], { ...output.io, env: fixture.env }), 0)
  const job = JSON.parse(output.stdout.join(''))
  await waitFor(() => fixture.service.get(job.id).status === 'awaiting_approval')
  const pause = capture()
  assert.equal(await runCli(['jobs', 'pause', job.id, '--json'], { ...pause.io, env: fixture.env }), 0)
  const resume = capture()
  assert.equal(await runCli(['jobs', 'resume', job.id, '--json'], { ...resume.io, env: fixture.env }), 0)
  assert.equal(JSON.parse(resume.stdout.join('')).status, 'awaiting_approval')
  const approve = capture()
  assert.equal(await runCli(['jobs', 'approve', job.id, '--json'], { ...approve.io, env: fixture.env }), 0)
  await waitFor(() => fixture.service.get(job.id).status === 'completed')
  const status = capture()
  assert.equal(await runCli(['jobs', 'status', job.id, '--json'], { ...status.io, env: fixture.env }), 0)
  assert.equal(JSON.parse(status.stdout.join('')).status, 'completed')
  const list = capture()
  assert.equal(await runCli(['jobs', 'list', '--json'], { ...list.io, env: fixture.env }), 0)
  assert.equal(JSON.parse(list.stdout.join('')).length, 1)
})

test('providers and failures never print bearer tokens or API keys', async (t) => {
  const fixture = await setup(t, { inspect: async () => [{ id: 'preset', apiKey: 'secret-api-key', key: 'secret-key', nested: { token: 'secret-token' } }] })
  const endpoint = JSON.parse(await fs.readFile(fixture.endpointPath, 'utf8'))
  const output = capture()
  assert.equal(await runCli(['providers', '--json'], { ...output.io, env: fixture.env }), 0)
  assert.deepEqual(JSON.parse(output.stdout.join('')), [{ id: 'preset', nested: {} }])
  assert.ok(!output.stdout.join('').includes(endpoint.token))
  const failure = capture()
  assert.equal(await runCli(['status', '--json'], {
    ...failure.io, env: fixture.env,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: `拒绝 ${endpoint.token}` } }), { status: 401 }),
  }), 1)
  assert.ok(!failure.stderr.join('').includes(endpoint.token))
  assert.match(failure.stderr.join(''), /已隐藏/)
})

test('unavailable, invalid or stale endpoints produce useful errors with no private headers', async () => {
  for (const [readFile, fetchImpl, expected] of [
    [async () => { throw new Error('ENOENT') }, undefined, 'DESKTOP_UNAVAILABLE'],
    [async () => '{"version":1,"port":443,"token":"bad","pid":1}', undefined, 'INVALID_ENDPOINT'],
    [async () => JSON.stringify({ version: 1, port: 10, token: 'a'.repeat(64), pid: 1 }), async () => { throw new Error('ECONNREFUSED') }, 'DESKTOP_UNAVAILABLE'],
  ]) {
    const output = capture()
    assert.equal(await runCli(['status', '--json'], { ...output.io, readFile, ...(fetchImpl ? { fetchImpl } : {}) }), 1)
    assert.equal(JSON.parse(output.stderr.join('')).error.code, expected)
    assert.ok(!output.stderr.join('').includes('a'.repeat(64)))
  }
})

test('a request timeout says the job may already have been submitted and requires status or idempotent retry', async () => {
  const output = capture()
  const code = await runCli(['agent', 'run', '--prompt', '要求', '--portfolio', 'p', '--project', 'a', '--timeout', '100', '--json'], {
    ...output.io,
    readFile: async () => JSON.stringify({ version: 1, port: 123, token: 'b'.repeat(64), pid: 1 }),
    fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  assert.equal(code, 1)
  const error = JSON.parse(output.stderr.join('')).error
  assert.equal(error.code, 'REQUEST_TIMEOUT')
  assert.match(error.message, /任务可能已提交/)
})

test('plan JSON validation happens locally and reports malformed or oversized files', async () => {
  for (const [text, expected] of [['{bad', 'INVALID_PLAN_JSON'], ['[]', 'INVALID_ARGUMENT'], ['x'.repeat(2 * 1024 * 1024 + 1), 'PAYLOAD_TOO_LARGE']]) {
    const output = capture()
    assert.equal(await runCli(['plan', 'submit', '--file', 'fake.json', '--portfolio', 'p', '--project', 'a', '--json'], {
      ...output.io, readFile: async () => text, fetchImpl: async () => { throw new Error('不能联网') },
    }), 1)
    assert.equal(JSON.parse(output.stderr.join('')).error.code, expected)
  }
})
