/**
 * Serialized, atomic persistence for desktop `.qy` portfolio files.
 *
 * The renderer can request an automatic save and a manual save at nearly the
 * same time.  This module keeps writes to the same resolved path in order,
 * gives every write its own temporary file, and waits for the complete write
 * (including the rename) before reporting success.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * `undefined` means "use the application default".  Explicit zero must stay
 * zero; using `Number(value) || default` would accidentally turn zero into
 * the default backup count.
 */
export function normalizeBackupCount(value, fallback = 10) {
  if (value === undefined || value === null || value === '') {
    return Math.max(0, Math.min(100, Math.floor(fallback)))
  }
  const numeric = Number(value)
  if (!isFiniteNumber(numeric)) {
    return Math.max(0, Math.min(100, Math.floor(fallback)))
  }
  return Math.max(0, Math.min(100, Math.floor(numeric)))
}

export function canonicalQyPath(filePath) {
  const resolved = path.resolve(String(filePath))
  // Windows paths are case-insensitive.  Lower-casing the queue key prevents
  // two differently-cased strings from writing the same file concurrently.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Hash the original file bytes, not parsed JSON or filesystem timestamps.
 * This also catches same-sized edits made within the timestamp resolution.
 */
export function qyFileRevision(raw) {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`
}

export function qyPayloadBytes(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  return Buffer.byteLength(text, 'utf8')
}

function qyPayloadLimitError(filePath, bytes, maxBytes) {
  const error = new Error(`作品集内容约 ${bytes} B，超过 .qy 保存上限 ${maxBytes} B，已停止写入：${filePath}`)
  error.code = 'QY_STATE_TOO_LARGE'
  error.bytes = bytes
  error.maxBytes = maxBytes
  return error
}

export async function readQyFileRevision(filePath, fsImpl = fs) {
  try {
    return qyFileRevision(await fsImpl.promises.readFile(path.resolve(String(filePath))))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function qyBackupPrefix(filePath) {
  const resolved = path.resolve(String(filePath))
  const base = path.basename(resolved, path.extname(resolved))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    || '作品集'
  // A basename alone is not enough: `D:\a\book.qy` and `E:\b\book.qy`
  // must not share one backup rotation pool.
  const key = createHash('sha256')
    .update(canonicalQyPath(resolved), 'utf8')
    .digest('hex')
    .slice(0, 16)
  return `${base}--${key}`
}

async function fileExists(fsImpl, filePath) {
  try {
    await fsImpl.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

async function listBackups(fsImpl, backupRoot, prefix) {
  let names
  try {
    names = await fsImpl.promises.readdir(backupRoot)
  } catch {
    return []
  }
  const matching = []
  for (const name of names) {
    if (!name.startsWith(`${prefix}-`) || !name.toLowerCase().endsWith('.qy')) continue
    const target = path.join(backupRoot, name)
    try {
      const stat = await fsImpl.promises.stat(target)
      if (stat.isFile()) matching.push({ target, mtime: stat.mtimeMs })
    } catch {
      // A backup can disappear between readdir and stat.  Ignore that entry.
    }
  }
  return matching
}

async function prepareBackup(fsImpl, backupRoot, filePath, backupCount, logger) {
  const limit = normalizeBackupCount(backupCount)
  const prefix = qyBackupPrefix(filePath)
  let backupPath = null
  try {
    await fsImpl.promises.mkdir(backupRoot, { recursive: true })

    if (limit > 0 && await fileExists(fsImpl, filePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = path.join(backupRoot, `${prefix}-${stamp}.qy`)
      let suffix = 1
      while (await fileExists(fsImpl, backupPath)) {
        backupPath = path.join(backupRoot, `${prefix}-${stamp}-${suffix}.qy`)
        suffix += 1
      }
      await fsImpl.promises.copyFile(filePath, backupPath)
    }
  } catch (error) {
    // A backup failure must never make the actual document unsaveable.
    logger?.('Unable to create .qy backup', error)
    if (backupPath) await fsImpl.promises.unlink(backupPath).catch(() => {})
    backupPath = null
  }
  return { limit, prefix, backupPath }
}

async function pruneBackups(fsImpl, backupRoot, backup, logger) {
  try {
    // Only rotate once the save succeeds. A failed/conflicting save must not
    // remove earlier recovery points, including when retention is set to zero.
    const { limit, prefix } = backup
    const details = await listBackups(fsImpl, backupRoot, prefix)
    details.sort((a, b) => b.mtime - a.mtime)
    const stale = details.slice(limit)
    await Promise.all(stale.flatMap(({ target }) => [
      fsImpl.promises.unlink(target).catch(() => {}),
      // Character images are stored beside the backup document. Keep
      // retention bounded for both halves of the recovery point.
      fsImpl.promises.rm(`${target}.assets`, { recursive: true, force: true }).catch(() => {}),
    ]))
  } catch (error) {
    logger?.('Unable to rotate .qy backup', error)
  }
}

function fileConflict(filePath, expectedRevision, actualRevision, kind) {
  const error = new Error('The .qy file changed outside the application; the current file was not overwritten.')
  error.code = 'QY_FILE_CONFLICT'
  error.conflict = {
    path: filePath,
    expectedRevision,
    actualRevision,
    kind: kind ?? (
      actualRevision === null ? 'missing' : expectedRevision === null ? 'created' : 'modified'
    ),
  }
  return error
}

async function targetStat(fsImpl, filePath) {
  try {
    return await fsImpl.promises.lstat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function assertTargetUnchanged(fsImpl, filePath, options) {
  const stat = await targetStat(fsImpl, filePath)
  if (options.createOnly && stat) {
    let revision = null
    if (stat.isFile() && !stat.isSymbolicLink()) {
      revision = await readQyFileRevision(filePath, fsImpl)
    }
    throw fileConflict(filePath, null, revision, 'created')
  }
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    const error = new Error('A .qy save target must be a regular file, not a symbolic link or directory.')
    error.code = 'QY_UNSAFE_TARGET'
    throw error
  }
  if (options.expectedRevision !== undefined) {
    const actualRevision = await readQyFileRevision(filePath, fsImpl)
    if (actualRevision !== options.expectedRevision) {
      throw fileConflict(filePath, options.expectedRevision, actualRevision)
    }
  }
}

async function atomicWrite(fsImpl, backupRoot, filePath, text, backupCount, options, logger) {
  const directory = path.dirname(filePath)
  const base = path.basename(filePath)
  const tempPath = path.join(directory, `.${base}.${process.pid}.${randomUUID()}.tmp`)
  let backup
  let published = false
  try {
    const handle = await fsImpl.promises.open(tempPath, 'wx')
    try {
      await handle.writeFile(text, 'utf8')
      // Ensure the JSON reaches the OS before the destination is replaced.
      await handle.sync()
    } finally {
      await handle.close()
    }
    backup = await prepareBackup(fsImpl, backupRoot, filePath, backupCount, logger)
    // Recheck after both the temporary write and backup copy: either can take
    // long enough for an external editor to modify or delete the destination.
    await assertTargetUnchanged(fsImpl, filePath, options)
    if (options.createOnly || options.expectedRevision === null) {
      try {
        // Creating a hard link atomically refuses an existing destination.
        // A check followed by rename alone would overwrite a competing file.
        await fsImpl.promises.link(tempPath, filePath)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const stat = await targetStat(fsImpl, filePath)
        const revision = stat?.isFile() && !stat.isSymbolicLink()
          ? await readQyFileRevision(filePath, fsImpl)
          : null
        throw fileConflict(filePath, null, revision, 'created')
      }
    } else {
      await fsImpl.promises.rename(tempPath, filePath)
    }
    published = true
    await pruneBackups(fsImpl, backupRoot, backup, logger)
    const result = { revision: qyFileRevision(Buffer.from(text, 'utf8')) }
    if (backup?.backupPath) result.backupPath = backup.backupPath
    return result
  } finally {
    await fsImpl.promises.unlink(tempPath).catch(() => {})
    if (!published && backup?.backupPath) {
      await fsImpl.promises.unlink(backup.backupPath).catch(() => {})
    }
  }
}

/**
 * Create an independent save manager.  The optional fs/logger arguments make
 * the boundary easy to exercise without loading Electron's app runtime.
 */
export function createQySaveManager({
  backupRoot,
  fsImpl = fs,
  logger = () => {},
  maxBytes = Number.POSITIVE_INFINITY,
} = {}) {
  if (!backupRoot) throw new TypeError('backupRoot is required')
  if (!(maxBytes === Number.POSITIVE_INFINITY || isFiniteNumber(maxBytes) && maxBytes >= 0)) {
    throw new TypeError('maxBytes must be a non-negative finite number or Infinity')
  }

  const queues = new Map()
  const pending = new Set()

  function enqueue(filePath, operation) {
    const key = canonicalQyPath(filePath)
    const previous = queues.get(key) || Promise.resolve()
    const run = previous.catch(() => {}).then(operation)
    let tracked
    tracked = run.finally(() => {
      pending.delete(tracked)
      if (queues.get(key) === tracked) queues.delete(key)
    })
    queues.set(key, tracked)
    pending.add(tracked)
    return tracked
  }

  function write(filePath, text, backupCount, options = {}) {
    if (typeof text !== 'string') throw new TypeError('text must be a string')
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object')
    }
    if (
      options.expectedRevision !== undefined
      && options.expectedRevision !== null
      && typeof options.expectedRevision !== 'string'
    ) {
      throw new TypeError('expectedRevision must be a string or null')
    }
    if (options.createOnly !== undefined && typeof options.createOnly !== 'boolean') {
      throw new TypeError('createOnly must be a boolean')
    }
    // Snapshot options at enqueue time; caller mutation must not weaken a
    // pending write's optimistic concurrency guard.
    const writeOptions = {
      expectedRevision: options.expectedRevision,
      createOnly: options.createOnly === true,
    }
    const target = path.resolve(String(filePath))
    return enqueue(target, async () => {
      const payloadBytes = qyPayloadBytes(text)
      if (payloadBytes > maxBytes) throw qyPayloadLimitError(target, payloadBytes, maxBytes)
      await assertTargetUnchanged(fsImpl, target, writeOptions)
      await fsImpl.promises.mkdir(path.dirname(target), { recursive: true })
      return atomicWrite(fsImpl, backupRoot, target, text, backupCount, writeOptions, logger)
    })
  }

  async function waitForPendingWrites() {
    // A task may enqueue another task before this loop reaches the next
    // iteration, so keep checking until the set is empty.
    while (pending.size > 0) {
      await Promise.allSettled([...pending])
    }
  }

  return {
    write,
    waitForPendingWrites,
    pendingCount: () => pending.size,
  }
}

