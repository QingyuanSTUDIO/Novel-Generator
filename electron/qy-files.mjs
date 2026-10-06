/**
 * Backup discovery and recovery for portable portfolio files.
 *
 * Recovery creates a new document through the regular save queue. It never
 * replaces a live portfolio or modifies a backup, and its fresh identities
 * prevent local task/chat history from being attached to the recovered copy.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseQyPortfolio, qyPortfolioTitle } from './qy.mjs'
import { canonicalQyPath, qyBackupPrefix } from './qy-save.mjs'

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function resolvedPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) {
    throw fail('QY_BACKUP_PATH_INVALID', `${label}无效`)
  }
  return path.resolve(value)
}

function isInside(root, target) {
  const relative = path.relative(canonicalQyPath(root), canonicalQyPath(target))
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`))
}

function samePath(first, second) {
  return canonicalQyPath(first) === canonicalQyPath(second)
}

function backupNameAllowed(name, prefix) {
  return typeof name === 'string'
    && name.length > prefix.length + 4
    && name === path.basename(name)
    && !/[<>:"/\\|?*\x00-\x1f]/.test(name)
    && name.startsWith(`${prefix}-`)
    && name.toLowerCase().endsWith('.qy')
}

function freshId(prefix, used) {
  let id
  do { id = `${prefix}-${randomUUID()}` } while (used.has(id))
  used.add(id)
  return id
}

function recoveredDocument(document) {
  const used = new Set([document.portfolio.id, ...document.projects.map((project) => project.id)])
  const projectIds = new Map()
  document.portfolio.id = freshId('portfolio', used)
  for (const project of document.projects) {
    const oldId = project.id
    project.id = freshId('project', used)
    projectIds.set(oldId, project.id)
  }
  document.portfolio.activeProjectId = projectIds.get(document.portfolio.activeProjectId) || ''
  // Validate the complete new envelope, including the remapped active ID.
  return parseQyPortfolio(document)
}

function restoredFilename(title) {
  const safeTitle = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  const name = Array.from(safeTitle).slice(0, 120).join('')
    || '作品集'
  return `${name}-恢复.qy`
}

function readableError(error) {
  if (typeof error?.message === 'string' && error.code?.startsWith('QY_')) return error.message
  if (error?.name === 'QyPortfolioValidationError') return error.message
  const code = typeof error?.code === 'string' ? `（${error.code}）` : ''
  return `无法读取备份文件${code}`
}

export function createQyFilesService({
  saveRoot,
  backupRoot,
  saveManager,
  attachmentStore,
  fsImpl = fs,
  logger = () => {},
} = {}) {
  if (!saveRoot || !backupRoot || typeof saveManager?.write !== 'function') {
    throw new TypeError('saveRoot, backupRoot and saveManager.write are required')
  }
  const saveDirectory = resolvedPath(saveRoot, '保存目录')
  const backupDirectory = resolvedPath(backupRoot, '备份目录')
  const api = fsImpl.promises

  function directories() {
    return { saveDirectory, backupDirectory }
  }

  async function maybeLstat(filePath) {
    try { return await api.lstat(filePath) } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  // Reject symlinks/junctions in every existing path component, including
  // parent directories. A basename check alone cannot detect a linked folder.
  async function assertUnlinkedPath(filePath, allowMissing = false) {
    const resolved = path.resolve(filePath)
    const root = path.parse(resolved).root
    let cursor = root
    for (const segment of [null, ...resolved.slice(root.length).split(path.sep).filter(Boolean)]) {
      if (segment !== null) cursor = path.join(cursor, segment)
      const stat = await maybeLstat(cursor)
      if (!stat) {
        if (allowMissing) return
        throw fail('QY_BACKUP_PATH_MISSING', '文件或目录不存在')
      }
      if (stat.isSymbolicLink()) {
        throw fail('QY_BACKUP_PATH_UNSAFE', '备份和恢复路径不能经过符号链接或目录联结')
      }
      if (!samePath(cursor, resolved) && !stat.isDirectory()) {
        throw fail('QY_BACKUP_PATH_UNSAFE', '文件路径包含非目录节点')
      }
    }
  }

  async function ensureDirectory(directory) {
    await assertUnlinkedPath(directory, true)
    await api.mkdir(directory, { recursive: true })
    await assertUnlinkedPath(directory)
    const stat = await api.lstat(directory)
    if (!stat.isDirectory()) throw fail('QY_BACKUP_PATH_UNSAFE', '保存或备份目录不是目录')
    return await api.realpath(directory)
  }

  async function backupRootPath() {
    return ensureDirectory(backupDirectory)
  }

  async function prepareDirectories() {
    await ensureDirectory(saveDirectory)
    await backupRootPath()
    return directories()
  }

  function backupPath(sourcePath, backupId) {
    const source = resolvedPath(sourcePath, '源作品集路径')
    const prefix = qyBackupPrefix(source)
    if (!backupNameAllowed(backupId, prefix)) {
      throw fail('QY_BACKUP_ID_INVALID', '备份名称无效，或不属于当前作品集的备份池')
    }
    const target = path.resolve(backupDirectory, backupId)
    if (!isInside(backupDirectory, target) || samePath(backupDirectory, target)) {
      throw fail('QY_BACKUP_PATH_UNSAFE', '备份路径超出了备份目录')
    }
    return target
  }

  async function readBackup(target, realRoot) {
    await assertUnlinkedPath(target)
    const originalStat = await api.lstat(target)
    if (!originalStat.isFile()) throw fail('QY_BACKUP_INVALID', '备份不是普通文件')
    const realTarget = await api.realpath(target)
    if (!isInside(realRoot, realTarget) || samePath(realRoot, realTarget)) {
      throw fail('QY_BACKUP_PATH_UNSAFE', '备份路径超出了备份目录')
    }
    // O_NOFOLLOW blocks a last-component symlink swap on supported systems.
    // Descriptor/stat checks also reject replacement while opening a backup.
    const flags = (fsImpl.constants?.O_RDONLY ?? fs.constants.O_RDONLY)
      | (fsImpl.constants?.O_NOFOLLOW ?? fs.constants.O_NOFOLLOW ?? 0)
    const handle = await api.open(target, flags)
    let raw
    try {
      const openedStat = await handle.stat()
      if (!openedStat.isFile()
        || openedStat.dev !== originalStat.dev
        || openedStat.ino !== originalStat.ino) {
        throw fail('QY_BACKUP_PATH_UNSAFE', '备份文件在读取时发生变化，请重新读取备份列表')
      }
      raw = await handle.readFile('utf8')
      await assertUnlinkedPath(target)
      const finalStat = await api.lstat(target)
      if (finalStat.dev !== openedStat.dev || finalStat.ino !== openedStat.ino
        || !samePath(await api.realpath(backupDirectory), realRoot)
        || !isInside(realRoot, await api.realpath(target))) {
        throw fail('QY_BACKUP_PATH_UNSAFE', '备份文件在读取时发生变化，请重新读取备份列表')
      }
    } finally {
      await handle.close()
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch {
      throw fail('QY_BACKUP_INVALID', '备份文件不是有效的 JSON')
    }
    return parseQyPortfolio(parsed)
  }

  async function listBackups(sourcePath) {
    const source = resolvedPath(sourcePath, '源作品集路径')
    const prefix = qyBackupPrefix(source)
    await ensureDirectory(saveDirectory)
    const realRoot = await backupRootPath()
    const names = await api.readdir(backupDirectory)
    const entries = []
    for (const name of names) {
      if (!backupNameAllowed(name, prefix)) continue
      const target = backupPath(source, name)
      const entry = {
        id: name,
        path: target,
        title: name,
        createdAt: 0,
        size: 0,
        valid: false,
      }
      try {
        const stat = await api.lstat(target)
        entry.createdAt = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
          ? stat.birthtimeMs : stat.mtimeMs
        entry.size = stat.size
        const document = await readBackup(target, realRoot)
        entry.title = qyPortfolioTitle(document)
        entry.projectCount = document.projects.length
        entry.valid = true
      } catch (error) {
        // Invalid backups stay visible so the author knows which copies
        // cannot be recovered. No malformed content is returned to the UI.
        entry.error = readableError(error)
        logger('Unable to inspect .qy backup', error)
      }
      entries.push(entry)
    }
    entries.sort((first, second) => second.createdAt - first.createdAt
      || second.id.localeCompare(first.id))
    return { ...directories(), entries }
  }

  async function restoreBackup({ sourcePath, backupId, destinationPath } = {}) {
    const source = resolvedPath(sourcePath, '源作品集路径')
    const target = backupPath(source, backupId)
    await ensureDirectory(saveDirectory)
    const realRoot = await backupRootPath()
    const document = recoveredDocument(await readBackup(target, realRoot))
    const title = qyPortfolioTitle(document)
    let destination
    if (destinationPath === undefined || destinationPath === null || destinationPath === '') {
      destination = path.join(saveDirectory, restoredFilename(title))
    } else {
      destination = resolvedPath(destinationPath, '恢复目标路径')
      if (!path.isAbsolute(destinationPath)) {
        throw fail('QY_RESTORE_TARGET_INVALID', '恢复目标必须是完整文件路径')
      }
      if (!destination.toLowerCase().endsWith('.qy')) destination += '.qy'
    }
    if (samePath(source, destination)) {
      throw fail('QY_RESTORE_TARGET_INVALID', '恢复必须保存为新的作品集文件，不能覆盖源作品集')
    }
    if (isInside(backupDirectory, destination) || isInside(realRoot, destination)) {
      throw fail('QY_RESTORE_TARGET_INVALID', '恢复目标不能位于备份目录内')
    }
    await assertUnlinkedPath(destination, true)
    if (await maybeLstat(destination)) {
      throw fail('QY_RESTORE_TARGET_EXISTS', '恢复目标已经存在，请选择新的文件名')
    }
    const parent = path.dirname(destination)
    await assertUnlinkedPath(parent, true)
    // The regular save manager creates missing directories and publishes the
    // synchronized temporary file atomically with createOnly. This also
    // protects an existing file created after the checks above.
    let attachmentsCopied = false
    try {
      if (typeof attachmentStore?.copy === 'function') {
        attachmentsCopied = await attachmentStore.copy(target, destination)
      }
      const result = await saveManager.write(
        destination,
        `${JSON.stringify(document, null, 2)}\n`,
        0,
        { createOnly: true },
      )
      return { path: destination, title, document, revision: result.revision }
    } catch (error) {
      if (attachmentsCopied && typeof attachmentStore?.remove === 'function') {
        await attachmentStore.remove(destination).catch(() => {})
      }
      throw error
    }
  }

  return { directories, prepareDirectories, listBackups, restoreBackup }
}
