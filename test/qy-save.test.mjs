import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  createQySaveManager,
  normalizeBackupCount,
  qyBackupPrefix,
  qyFileRevision,
  qyPayloadBytes,
  readQyFileRevision,
} from '../electron/qy-save.mjs'

async function tempDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'novel-generator-qy-save-'))
}

async function fixture(t) {
  const root = await tempDirectory()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const backupRoot = path.join(root, '备份')
  const filePath = path.join(root, '作品集.qy')
  return { root, backupRoot, filePath }
}

function wrappedFs(overrides) {
  return { promises: { ...fs, ...overrides } }
}

function assertConflict(error, filePath, expectedRevision, actualRevision, kind) {
  assert.equal(error.code, 'QY_FILE_CONFLICT')
  assert.deepEqual(error.conflict, {
    path: path.resolve(filePath),
    expectedRevision,
    actualRevision,
    kind,
  })
  return true
}

test('explicit backup count zero is preserved', () => {
  assert.equal(normalizeBackupCount(0), 0)
  assert.equal(normalizeBackupCount('0'), 0)
  assert.equal(normalizeBackupCount(undefined), 10)
  assert.equal(normalizeBackupCount(Number.NaN), 10)
})

test('backup pools are isolated for same-named files in different directories', () => {
  const first = qyBackupPrefix(path.join('alpha', '作品集.qy'))
  const second = qyBackupPrefix(path.join('beta', '作品集.qy'))
  assert.notEqual(first, second)
  assert.match(first, /^作品集--[0-9a-f]{16}$/)
})

test('same-path writes are serialized and leave no shared temporary file', async () => {
  const root = await tempDirectory()
  const backupRoot = path.join(root, '备份')
  const filePath = path.join(root, '作品集.qy')
  const manager = createQySaveManager({ backupRoot })

  await Promise.all([
    manager.write(filePath, '{"version":1}\n', 0),
    manager.write(filePath, '{"version":2}\n', 0),
    manager.write(filePath, '{"version":3}\n', 0),
  ])
  await manager.waitForPendingWrites()

  assert.equal(await fs.readFile(filePath, 'utf8'), '{"version":3}\n')
  const names = await fs.readdir(root)
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), [])
  assert.equal(manager.pendingCount(), 0)
})

test('backup count zero removes existing backups instead of falling back to ten', async () => {
  const root = await tempDirectory()
  const backupRoot = path.join(root, '备份')
  const filePath = path.join(root, '作品集.qy')
  const manager = createQySaveManager({ backupRoot })

  await manager.write(filePath, '{"version":1}\n', 2)
  await manager.write(filePath, '{"version":2}\n', 2)
  const prefix = qyBackupPrefix(filePath)
  let names = await fs.readdir(backupRoot)
  assert.equal(names.filter((name) => name.startsWith(`${prefix}-`)).length, 1)

  await manager.write(filePath, '{"version":3}\n', 0)
  names = await fs.readdir(backupRoot)
  assert.equal(names.filter((name) => name.startsWith(`${prefix}-`)).length, 0)
})

test('separate same-named files keep separate backup histories', async () => {
  const root = await tempDirectory()
  const backupRoot = path.join(root, '备份')
  const firstPath = path.join(root, 'one', '作品集.qy')
  const secondPath = path.join(root, 'two', '作品集.qy')
  const manager = createQySaveManager({ backupRoot })

  await manager.write(firstPath, '{"file":"one-v1"}\n', 2)
  await manager.write(firstPath, '{"file":"one-v2"}\n', 2)
  await manager.write(secondPath, '{"file":"two-v1"}\n', 2)
  await manager.write(secondPath, '{"file":"two-v2"}\n', 2)

  const names = await fs.readdir(backupRoot)
  assert.equal(names.filter((name) => name.startsWith(`${qyBackupPrefix(firstPath)}-`)).length, 1)
  assert.equal(names.filter((name) => name.startsWith(`${qyBackupPrefix(secondPath)}-`)).length, 1)
})

test('revisions hash original bytes and a missing file returns null', async (t) => {
  const { filePath } = await fixture(t)
  assert.equal(await readQyFileRevision(filePath), null)
  const originalBytes = Buffer.from('\ufeff{"内容":"归元"}\r\n', 'utf8')
  await fs.writeFile(filePath, originalBytes)
  assert.match(qyFileRevision(originalBytes), /^sha256:[a-f0-9]{64}$/)
  assert.equal(await readQyFileRevision(filePath), qyFileRevision(originalBytes))
  assert.notEqual(qyFileRevision(originalBytes), qyFileRevision('{"内容":"归元"}\n'))
})

test('qy payload size is measured in UTF-8 bytes and optional save caps fail before disk I/O', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  const payload = '{"内容":"归元"}\n'
  assert.equal(qyPayloadBytes(payload), Buffer.byteLength(payload, 'utf8'))
  const manager = createQySaveManager({ backupRoot, maxBytes: qyPayloadBytes(payload) - 1 })
  await assert.rejects(
    manager.write(filePath, payload, 0, { expectedRevision: null }),
    (error) => error.code === 'QY_STATE_TOO_LARGE'
      && error.bytes === qyPayloadBytes(payload)
      && error.maxBytes === qyPayloadBytes(payload) - 1,
  )
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' })
})

test('writes return the revision of the successfully published bytes', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  const manager = createQySaveManager({ backupRoot })
  const original = '{"内容":"归元"}\n'
  const first = await manager.write(filePath, original, 0, { expectedRevision: null })
  assert.deepEqual(first, { revision: qyFileRevision(Buffer.from(original, 'utf8')) })
  const second = await manager.write(filePath, original, 0, { expectedRevision: first.revision })
  assert.deepEqual(second, first)
  assert.equal(await readQyFileRevision(filePath), first.revision)
})

test('same-size edits with identical timestamps conflict without backup rotation', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  const initial = '{"value":"AA"}\n'
  const external = '{"value":"BB"}\n'
  await fs.writeFile(filePath, initial)
  const expected = await readQyFileRevision(filePath)
  const originalStat = await fs.stat(filePath)
  await fs.writeFile(filePath, external)
  await fs.utimes(filePath, originalStat.atime, originalStat.mtime)
  const manager = createQySaveManager({ backupRoot })
  await assert.rejects(
    manager.write(filePath, '{"value":"CC"}\n', 2, { expectedRevision: expected }),
    (error) => assertConflict(error, filePath, expected, qyFileRevision(external), 'modified'),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), external)
  await assert.rejects(fs.access(backupRoot), { code: 'ENOENT' })
  assert.deepEqual((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp')), [])
})

test('deletion of the loaded file conflicts and does not silently recreate it', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  await fs.writeFile(filePath, 'loaded')
  const expected = await readQyFileRevision(filePath)
  await fs.unlink(filePath)
  const manager = createQySaveManager({ backupRoot })
  await assert.rejects(
    manager.write(filePath, 'unsaved edit', 10, { expectedRevision: expected }),
    (error) => assertConflict(error, filePath, expected, null, 'missing'),
  )
  assert.equal(await readQyFileRevision(filePath), null)
  await assert.rejects(fs.access(backupRoot), { code: 'ENOENT' })
})

test('creation at a previously empty path conflicts instead of replacing the new file', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  const expected = await readQyFileRevision(filePath)
  await fs.writeFile(filePath, 'another editor created this')
  const manager = createQySaveManager({ backupRoot })
  const actual = await readQyFileRevision(filePath)
  await assert.rejects(
    manager.write(filePath, 'our draft', 10, { expectedRevision: expected }),
    (error) => assertConflict(error, filePath, null, actual, 'created'),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), 'another editor created this')
  await assert.rejects(fs.access(backupRoot), { code: 'ENOENT' })
})

test('timestamps changing without byte changes do not create a false conflict', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  await fs.writeFile(filePath, 'original')
  const expected = await readQyFileRevision(filePath)
  await fs.utimes(filePath, new Date(1000), new Date(2000))
  const manager = createQySaveManager({ backupRoot })
  const result = await manager.write(filePath, 'next', 0, { expectedRevision: expected })
  assert.equal(result.revision, qyFileRevision('next'))
  assert.equal(await fs.readFile(filePath, 'utf8'), 'next')
})

test('a failed publication leaves the original and queue intact for a retry', async (t) => {
  const { root, backupRoot, filePath } = await fixture(t)
  await fs.writeFile(filePath, 'original')
  const expected = await readQyFileRevision(filePath)
  let attempts = 0
  const manager = createQySaveManager({
    backupRoot,
    fsImpl: wrappedFs({
      async rename(source, destination) {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('simulated write failure'), { code: 'EIO' })
        return fs.rename(source, destination)
      },
    }),
  })
  await assert.rejects(manager.write(filePath, 'first edit', 1, { expectedRevision: expected }), { code: 'EIO' })
  assert.equal(await fs.readFile(filePath, 'utf8'), 'original')
  assert.deepEqual(await fs.readdir(backupRoot), [])
  const retry = await manager.write(filePath, 'retry edit', 1, { expectedRevision: expected })
  await manager.waitForPendingWrites()
  assert.equal(retry.revision, qyFileRevision('retry edit'))
  assert.equal(await fs.readFile(filePath, 'utf8'), 'retry edit')
  assert.equal(manager.pendingCount(), 0)
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [])
})

test('a rejected conflict does not poison the next queued save', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  await fs.writeFile(filePath, 'current')
  const manager = createQySaveManager({ backupRoot })
  const rejected = manager.write(filePath, 'stale', 0, { expectedRevision: qyFileRevision('previous') })
  const retried = manager.write(filePath, 'next', 0, { expectedRevision: qyFileRevision('current') })
  await assert.rejects(rejected, { code: 'QY_FILE_CONFLICT' })
  assert.equal((await retried).revision, qyFileRevision('next'))
  await manager.waitForPendingWrites()
  assert.equal(manager.pendingCount(), 0)
})

test('external modification during a backup copy aborts publication and preserves old backups', async (t) => {
  const { root, backupRoot, filePath } = await fixture(t)
  const setupManager = createQySaveManager({ backupRoot })
  await setupManager.write(filePath, 'old recovery point', 2)
  await setupManager.write(filePath, 'loaded document', 2)
  const previousBackups = await fs.readdir(backupRoot)
  assert.equal(previousBackups.length, 1)
  const expected = await readQyFileRevision(filePath)
  const manager = createQySaveManager({
    backupRoot,
    fsImpl: wrappedFs({
      async copyFile(source, destination) {
        await fs.copyFile(source, destination)
        await fs.writeFile(filePath, 'external update')
      },
    }),
  })
  await assert.rejects(
    manager.write(filePath, 'our update', 1, { expectedRevision: expected }),
    (error) => assertConflict(error, filePath, expected, qyFileRevision('external update'), 'modified'),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), 'external update')
  assert.deepEqual(await fs.readdir(backupRoot), previousBackups)
  assert.equal(await fs.readFile(path.join(backupRoot, previousBackups[0]), 'utf8'), 'old recovery point')
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [])
})

test('external edits during temporary-file sync are checked before publication', async (t) => {
  const { root, backupRoot, filePath } = await fixture(t)
  await fs.writeFile(filePath, 'loaded')
  const expected = await readQyFileRevision(filePath)
  const manager = createQySaveManager({
    backupRoot,
    fsImpl: wrappedFs({
      async open(...args) {
        const handle = await fs.open(...args)
        return {
          writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
          close: () => handle.close(),
          async sync() {
            await handle.sync()
            await fs.writeFile(filePath, 'changed during sync')
          },
        }
      },
    }),
  })
  await assert.rejects(
    manager.write(filePath, 'our edit', 0, { expectedRevision: expected }),
    (error) => assertConflict(error, filePath, expected, qyFileRevision('changed during sync'), 'modified'),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), 'changed during sync')
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [])
})

test('createOnly writes a new synced file and refuses any existing regular file', async (t) => {
  const { root, backupRoot, filePath } = await fixture(t)
  const manager = createQySaveManager({ backupRoot })
  const first = await manager.write(filePath, 'recovered', 0, { createOnly: true })
  assert.equal(first.revision, qyFileRevision('recovered'))
  await assert.rejects(
    manager.write(filePath, 'replacement', 0, { createOnly: true }),
    (error) => assertConflict(error, filePath, null, first.revision, 'created'),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), 'recovered')
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [])
})

test('createOnly cannot overwrite a competing file created after the final check', async (t) => {
  const { root, backupRoot, filePath } = await fixture(t)
  const manager = createQySaveManager({
    backupRoot,
    fsImpl: wrappedFs({
      async link(source, destination) {
        await fs.writeFile(destination, 'competing file', { flag: 'wx' })
        return fs.link(source, destination)
      },
    }),
  })
  await assert.rejects(
    manager.write(filePath, 'recovered', 0, { createOnly: true }),
    (error) => assertConflict(error, filePath, null, qyFileRevision('competing file'), 'created'),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), 'competing file')
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [])
})

test('a previously absent save target also refuses a file created after the final check', async (t) => {
  const { root, backupRoot, filePath } = await fixture(t)
  const manager = createQySaveManager({
    backupRoot,
    fsImpl: wrappedFs({
      async link(source, destination) {
        await fs.writeFile(destination, 'late external creation', { flag: 'wx' })
        return fs.link(source, destination)
      },
    }),
  })
  await assert.rejects(
    manager.write(filePath, 'our new portfolio', 0, { expectedRevision: null }),
    (error) => assertConflict(error, filePath, null, qyFileRevision('late external creation'), 'created'),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), 'late external creation')
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [])
})

test('the symbolic-link safety guard runs even on accounts without symlink creation rights', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  await fs.writeFile(filePath, 'must not change')
  const manager = createQySaveManager({
    backupRoot,
    fsImpl: wrappedFs({
      async lstat(target) {
        const stat = await fs.lstat(target)
        return {
          isSymbolicLink: () => true,
          isFile: () => stat.isFile(),
        }
      },
    }),
  })
  await assert.rejects(manager.write(filePath, 'changed', 1), { code: 'QY_UNSAFE_TARGET' })
  await assert.rejects(
    manager.write(filePath, 'recovery', 0, { createOnly: true }),
    (error) => assertConflict(error, filePath, null, null, 'created'),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), 'must not change')
  await assert.rejects(fs.access(backupRoot), { code: 'ENOENT' })
})

test('ordinary saves reject symbolic-link targets without altering either file', async (t) => {
  const { root, backupRoot, filePath } = await fixture(t)
  const originalPath = path.join(root, 'original.qy')
  await fs.writeFile(originalPath, 'original')
  try {
    await fs.symlink(originalPath, filePath, 'file')
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('The current Windows account cannot create file symlinks.')
      return
    }
    throw error
  }
  const manager = createQySaveManager({ backupRoot })
  await assert.rejects(manager.write(filePath, 'changed', 1), { code: 'QY_UNSAFE_TARGET' })
  assert.equal((await fs.lstat(filePath)).isSymbolicLink(), true)
  assert.equal(await fs.readFile(originalPath, 'utf8'), 'original')
  await assert.rejects(
    manager.write(filePath, 'new recovery', 0, { createOnly: true }),
    (error) => assertConflict(error, filePath, null, null, 'created'),
  )
  assert.equal((await fs.lstat(filePath)).isSymbolicLink(), true)
})

test('a directory at the target path is never replaced by a save', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  await fs.mkdir(filePath)
  const sentinel = path.join(filePath, 'contents.txt')
  await fs.writeFile(sentinel, 'keep this')
  const manager = createQySaveManager({ backupRoot })
  await assert.rejects(manager.write(filePath, 'changed', 1), { code: 'QY_UNSAFE_TARGET' })
  await assert.rejects(
    manager.write(filePath, 'recovery', 0, { createOnly: true }),
    (error) => assertConflict(error, filePath, null, null, 'created'),
  )
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep this')
})

test('revision reads do not report inaccessible files as missing', async (t) => {
  const { filePath } = await fixture(t)
  const fsImpl = wrappedFs({
    async readFile() {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    },
  })
  await assert.rejects(readQyFileRevision(filePath, fsImpl), { code: 'EACCES' })
})

test('pending guard options are copied before the caller can change them', async (t) => {
  const { backupRoot, filePath } = await fixture(t)
  await fs.writeFile(filePath, 'loaded')
  const manager = createQySaveManager({ backupRoot })
  const options = { expectedRevision: qyFileRevision('stale') }
  const operation = manager.write(filePath, 'edit', 0, options)
  options.expectedRevision = qyFileRevision('loaded')
  await assert.rejects(operation, { code: 'QY_FILE_CONFLICT' })
  assert.equal(await fs.readFile(filePath, 'utf8'), 'loaded')
})

