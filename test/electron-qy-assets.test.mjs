import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createQyAttachmentStore, qyAttachmentDirectory } from '../electron/qy-assets.mjs'

const payload = 'iVBORw0KGgo='
const ref = { assetId: 'character-image-one-36b7e018', mimeType: 'image/png', byteLength: 8 }

function documentWithImage() {
  return {
    projects: [{
      content: {
        characters: [{
          id: 'character-one',
          characterImages: [{ id: 'image-one', name: '角色', createdAt: 1, attachment: ref }],
        }],
      },
    }],
  }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-generator-qy-assets-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, filePath: path.join(root, '作品集.qy'), store: createQyAttachmentStore() }
}

test('sidecar attachment store writes and reads content-addressed image bytes', async (t) => {
  const { filePath, store } = await fixture(t)
  const result = await store.write(filePath, [{ ref, payloadBase64: payload }])
  assert.equal(result.written, 1)
  assert.equal(await fs.readFile(path.join(qyAttachmentDirectory(filePath), ref.assetId), 'base64'), payload)
  const loaded = await store.read(filePath, documentWithImage())
  assert.deepEqual(loaded, [{ ref, payloadBase64: payload }])
  assert.equal((await store.write(filePath, [{ ref, payloadBase64: payload }])).skipped, 1)
})

test('an existing asset with different bytes is never overwritten', async (t) => {
  const { filePath, store } = await fixture(t)
  await store.write(filePath, [{ ref, payloadBase64: payload }])
  await assert.rejects(store.write(filePath, [{
    ref,
    payloadBase64: 'QUJDREVGR0g=',
  }]), { code: 'QY_ATTACHMENT_CONFLICT' })
  assert.equal(await fs.readFile(path.join(qyAttachmentDirectory(filePath), ref.assetId), 'base64'), payload)
})

test('missing sidecars remain compatible with old inline-only portfolios', async (t) => {
  const { filePath, store } = await fixture(t)
  assert.deepEqual(await store.read(filePath, documentWithImage()), [])
})

test('copy and remove isolate backup attachment directories', async (t) => {
  const { filePath, store, root } = await fixture(t)
  await store.write(filePath, [{ ref, payloadBase64: payload }])
  const backupPath = path.join(root, '备份.qy')
  assert.equal(await store.copy(filePath, backupPath), true)
  assert.equal(await fs.readFile(path.join(qyAttachmentDirectory(backupPath), ref.assetId), 'base64'), payload)
  assert.equal(await store.remove(backupPath), true)
  await assert.rejects(fs.access(qyAttachmentDirectory(backupPath)), { code: 'ENOENT' })
})

test('unsafe asset ids and sidecar links are rejected', async (t) => {
  const { filePath, store, root } = await fixture(t)
  await assert.rejects(store.write(filePath, [{
    ref: { ...ref, assetId: '../outside' },
    payloadBase64: payload,
  }]), { code: 'QY_ATTACHMENT_INVALID' })
  const directory = qyAttachmentDirectory(filePath)
  await fs.rm(directory, { recursive: true, force: true })
  try {
    await fs.symlink(root, directory, 'junction')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Directory links unavailable: ${error.code}`)
      return
    }
    throw error
  }
  await assert.rejects(store.write(filePath, [{ ref, payloadBase64: payload }]), { code: 'QY_ATTACHMENT_PATH_UNSAFE' })
})

