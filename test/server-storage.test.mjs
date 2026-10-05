import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startLocalApiServer } from '../server/index.mjs'

async function createStorageApi(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-generator-storage-'))
  const server = await startLocalApiServer({
    host: '127.0.0.1',
    port: 0,
    storagePath: path.join(directory, 'state.json'),
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
