import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startLocalApiServer } from '../server/index.mjs'

async function createStorageApi(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-generator-storage-'))
  const server = await startLocalApiServer({
    host: '127.0.0.1',
    port: 0,
    storagePath: path.join(directory, 'state.json'),
    ...options,
  })
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await fs.rm(directory, { recursive: true, force: true })
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

async function createAuthenticatedStorageServer(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-generator-storage-auth-'))
  const server = await startLocalApiServer({
    host: '127.0.0.1',
    port: 0,
    storagePath: path.join(directory, 'state.json'),
    ...options,
  })
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await fs.rm(directory, { recursive: true, force: true })
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function readStorage(baseUrl) {
  const response = await fetch(`${baseUrl}/api/storage`)
  return { status: response.status, body: await response.json() }
}

async function putStorage(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/storage`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

test('starts with empty storage and accepts a versioned first write and update', async (t) => {
  const baseUrl = await createStorageApi(t)

  assert.deepEqual(await readStorage(baseUrl), {
    status: 200,
    body: { ok: true, state: null },
  })

  assert.equal((await putStorage(baseUrl, { state: { updatedAt: 1, projects: [] } })).status, 428)

  const firstState = { updatedAt: 1, projects: [{ id: 'project-a', name: 'First' }] }
  assert.deepEqual(await putStorage(baseUrl, { expectedUpdatedAt: 0, state: firstState }), {
    status: 200,
    body: { ok: true, updatedAt: 1 },
  })

  const updatedState = { updatedAt: 2, projects: [{ id: 'project-a', name: 'Renamed' }] }
  assert.deepEqual(await putStorage(baseUrl, { expectedUpdatedAt: 1, state: updatedState }), {
    status: 200,
    body: { ok: true, updatedAt: 2 },
  })
  assert.deepEqual((await readStorage(baseUrl)).body.state, updatedState)
})

test('rejects a write with a stale version and preserves the current state', async (t) => {
  const baseUrl = await createStorageApi(t)
  const currentState = { updatedAt: 12, projects: [{ id: 'project-a', name: 'Current' }] }
  assert.equal((await putStorage(baseUrl, { expectedUpdatedAt: 0, state: currentState })).status, 200)

  const staleResult = await putStorage(baseUrl, {
    expectedUpdatedAt: 0,
    state: { updatedAt: 13, projects: [{ id: 'project-a', name: 'Stale overwrite' }] },
  })

  assert.equal(staleResult.status, 409)
  assert.equal(staleResult.body.conflict, true)
  assert.equal(staleResult.body.updatedAt, 12)
  assert.deepEqual((await readStorage(baseUrl)).body.state, currentState)
})

test('blocks project deletion unless deletion is explicitly authorized', async (t) => {
  const baseUrl = await createStorageApi(t)
  const currentState = { updatedAt: 4, projects: [{ id: 'project-a', name: 'Keep me' }] }
  assert.equal((await putStorage(baseUrl, { expectedUpdatedAt: 0, state: currentState })).status, 200)

  const result = await putStorage(baseUrl, {
    expectedUpdatedAt: 4,
    state: { updatedAt: 5, projects: [] },
  })

  assert.equal(result.status, 409)
  assert.equal(result.body.conflict, true)
  assert.match(result.body.error, /阻止覆盖/)
  assert.deepEqual((await readStorage(baseUrl)).body.state, currentState)

  const authorizedResult = await putStorage(baseUrl, {
    expectedUpdatedAt: 4,
    allowProjectDeletion: true,
    state: { updatedAt: 5, projects: [] },
  })
  assert.equal(authorizedResult.status, 200)
  assert.deepEqual((await readStorage(baseUrl)).body.state, { updatedAt: 5, projects: [] })
})

test('profile storage can require a per-launch bearer token without changing preview defaults', async (t) => {
  const { server, baseUrl } = await createAuthenticatedStorageServer(t, {
    requireProfileAuth: true,
    profileAuthToken: 'profile-secret-for-test',
    profileAllowedOrigins: ['http://allowed.test', 'null'],
  })
  assert.equal(typeof server.profileAuthToken, 'string')
  assert.equal(server.profileAuthToken, 'profile-secret-for-test')

  const missing = await fetch(`${baseUrl}/api/storage`)
  assert.equal(missing.status, 401)
  assert.deepEqual(await missing.json(), { ok: false, error: '缺少本机 profile 服务令牌' })

  const wrong = await fetch(`${baseUrl}/api/storage`, { headers: { authorization: 'Bearer wrong-token' } })
  assert.equal(wrong.status, 401)
  assert.deepEqual(await wrong.json(), { ok: false, error: '本机 profile 服务令牌无效' })

  const valid = await fetch(`${baseUrl}/api/storage`, {
    headers: { authorization: 'Bearer profile-secret-for-test' },
  })
  assert.equal(valid.status, 200)
  assert.deepEqual(await valid.json(), { ok: true, state: null })

  const unauthorizedWrite = await fetch(`${baseUrl}/api/storage`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt: 0, state: { secret: 'must-not-write' } }),
  })
  assert.equal(unauthorizedWrite.status, 401)
  assert.deepEqual(await unauthorizedWrite.json(), { ok: false, error: '缺少本机 profile 服务令牌' })

  const authorizedWrite = await fetch(`${baseUrl}/api/storage`, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer profile-secret-for-test',
      'content-type': 'application/json',
      origin: 'http://allowed.test',
    },
    body: JSON.stringify({ expectedUpdatedAt: 0, state: { updatedAt: 1, profile: 'private' } }),
  })
  assert.equal(authorizedWrite.status, 200)
  assert.deepEqual(await authorizedWrite.json(), { ok: true, updatedAt: 1 })

  const allowedOrigin = await fetch(`${baseUrl}/api/storage`, {
    headers: {
      authorization: 'Bearer profile-secret-for-test',
      origin: 'http://allowed.test',
    },
  })
  assert.equal(allowedOrigin.status, 200)
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'http://allowed.test')
  assert.equal(allowedOrigin.headers.get('vary'), 'Origin')

  const opaqueOrigin = await fetch(`${baseUrl}/api/storage`, {
    headers: {
      authorization: 'Bearer profile-secret-for-test',
      origin: 'null',
    },
  })
  assert.equal(opaqueOrigin.status, 200)
  assert.equal(opaqueOrigin.headers.get('access-control-allow-origin'), 'null')

  const foreignOrigin = await fetch(`${baseUrl}/api/storage`, {
    headers: {
      authorization: 'Bearer profile-secret-for-test',
      origin: 'http://foreign.test',
    },
  })
  assert.equal(foreignOrigin.status, 403)
  assert.match((await foreignOrigin.json()).error, /来源未获/)

  const foreignWrite = await fetch(`${baseUrl}/api/storage`, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer profile-secret-for-test',
      'content-type': 'application/json',
      origin: 'http://foreign.test',
    },
    body: JSON.stringify({ expectedUpdatedAt: 1, state: { updatedAt: 2, profile: 'overwritten' } }),
  })
  assert.equal(foreignWrite.status, 403)
  assert.match((await foreignWrite.json()).error, /来源未获/)
  const persistedAfterForeignWrite = await fetch(`${baseUrl}/api/storage`, {
    headers: { authorization: 'Bearer profile-secret-for-test' },
  })
  assert.deepEqual(await persistedAfterForeignWrite.json(), { ok: true, state: { updatedAt: 1, profile: 'private' } })

  const preflight = await fetch(`${baseUrl}/api/storage`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://allowed.test',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization, content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://allowed.test')
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/)

  const rejectedPreflight = await fetch(`${baseUrl}/api/storage`, {
    method: 'OPTIONS',
    headers: { origin: 'http://foreign.test', 'access-control-request-method': 'GET' },
  })
  assert.equal(rejectedPreflight.status, 403)
})

test('authenticated profile servers generate a fresh token when none is supplied', async (t) => {
  const first = await createAuthenticatedStorageServer(t, { requireProfileAuth: true })
  const second = await createAuthenticatedStorageServer(t, { requireProfileAuth: true })
  assert.match(first.server.profileAuthToken, /^[A-Za-z0-9_-]{32,}$/)
  assert.match(second.server.profileAuthToken, /^[A-Za-z0-9_-]{32,}$/)
  assert.notEqual(first.server.profileAuthToken, second.server.profileAuthToken)
})

test('profile writes report size sources and reject oversized state before disk I/O', async (t) => {
  const baseUrl = await createStorageApi(t, {
    profileWarningBytes: 40,
    profileMaxBytes: 120,
  })
  const result = await putStorage(baseUrl, {
    expectedUpdatedAt: 0,
    state: {
      updatedAt: 1,
      projects: [],
      agentMessages: [{ content: 'x'.repeat(512) }],
    },
  })
  assert.equal(result.status, 413)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'PROFILE_STATE_TOO_LARGE')
  assert.match(result.body.error, /超过 profile 保存上限/)
  assert.ok(result.body.stateSize.bytes > 120)
  assert.ok(result.body.stateSize.breakdown.some((item) => item.key === 'agentMessages'))
  assert.deepEqual((await readStorage(baseUrl)).body, { ok: true, state: null })
})

test('profile warnings are non-blocking and include exact size diagnostics', async (t) => {
  const baseUrl = await createStorageApi(t, {
    profileWarningBytes: 40,
    profileMaxBytes: 4096,
  })
  const result = await putStorage(baseUrl, {
    expectedUpdatedAt: 0,
    state: {
      updatedAt: 1,
      projects: [],
      agentMessages: [{ content: 'x'.repeat(128) }],
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.match(result.body.warning, /本机设置数据约/)
  assert.match(result.body.warning, /agentMessages/)
  assert.deepEqual((await readStorage(baseUrl)).body.state, {
    updatedAt: 1,
    projects: [],
    agentMessages: [{ content: 'x'.repeat(128) }],
  })
})
