/**
 * Content-addressed sidecar storage for character images.
 *
 * A `.qy` file stores only image metadata and an attachment reference. The
 * bytes live beside it in `<file>.assets/<assetId>`. Asset IDs are validated
 * as plain file names, and existing files are never silently overwritten:
 * changing an image creates a new content key in the renderer.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function resolvedPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) {
    throw fail('QY_ATTACHMENT_PATH_INVALID', `${label}无效`)
  }
  return path.resolve(value)
}

export function qyAttachmentDirectory(filePath) {
  return `${resolvedPath(filePath, '作品集路径')}.assets`
}

export function isSafeQyAssetId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/[\x00-\x1f<>:"/\\|?*]/.test(value)
}

function isImageMimeType(value) {
  return typeof value === 'string' && /^image\/[a-z0-9.+-]+$/i.test(value)
}

function normalizeBase64(value) {
  return value.replace(/\s+/g, '')
}

function base64ByteLength(value) {
  const normalized = normalizeBase64(value)
  if (!normalized || normalized.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(normalized)) return -1
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding)
}

function validPayload(payload) {
  const ref = payload?.ref
  if (!ref || !isSafeQyAssetId(ref.assetId) || !isImageMimeType(ref.mimeType)
    || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0
    || typeof payload.payloadBase64 !== 'string') return false
  return base64ByteLength(payload.payloadBase64) === ref.byteLength
}

async function maybeLstat(fsImpl, filePath) {
  try { return await fsImpl.promises.lstat(filePath) } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function assertDirectorySafe(fsImpl, directory, allowMissing = false) {
  const stat = await maybeLstat(fsImpl, directory)
  if (!stat) {
    if (allowMissing) return
    throw fail('QY_ATTACHMENT_PATH_MISSING', '角色图片附件目录不存在')
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw fail('QY_ATTACHMENT_PATH_UNSAFE', '角色图片附件目录不能是符号链接或普通文件')
  }
  return stat
}

async function ensureDirectory(fsImpl, directory) {
  await assertDirectorySafe(fsImpl, directory, true)
  await fsImpl.promises.mkdir(directory, { recursive: true })
  await assertDirectorySafe(fsImpl, directory)
}

async function assertAssetFileSafe(fsImpl, target, allowMissing = false) {
  const stat = await maybeLstat(fsImpl, target)
  if (!stat) {
    if (allowMissing) return undefined
    throw fail('QY_ATTACHMENT_MISSING', '角色图片附件不存在')
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw fail('QY_ATTACHMENT_PATH_UNSAFE', '角色图片附件不能是符号链接或目录')
  }
  return stat
}

async function writeNewAsset(fsImpl, target, bytes) {
  const existing = await assertAssetFileSafe(fsImpl, target, true)
  if (existing) {
    const current = await fsImpl.promises.readFile(target)
    if (Buffer.compare(current, bytes) !== 0) {
      throw fail('QY_ATTACHMENT_CONFLICT', '角色图片附件 ID 已存在但内容不同，已停止覆盖旧附件')
    }
    return false
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  let published = false
  try {
    const handle = await fsImpl.promises.open(temporary, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fsImpl.promises.link(temporary, target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const race = await assertAssetFileSafe(fsImpl, target)
      const current = await fsImpl.promises.readFile(target)
      if (!race || Buffer.compare(current, bytes) !== 0) {
        throw fail('QY_ATTACHMENT_CONFLICT', '角色图片附件在保存期间发生变化')
      }
    }
    published = true
    return true
  } finally {
    await fsImpl.promises.unlink(temporary).catch(() => {})
    if (!published) await fsImpl.promises.unlink(target).catch(() => {})
  }
}

async function copyDirectory(fsImpl, source, destination) {
  const sourceStat = await assertDirectorySafe(fsImpl, source, true)
  if (!sourceStat) return false
  await assertDirectorySafe(fsImpl, destination, true)
  if (await maybeLstat(fsImpl, destination)) {
    throw fail('QY_ATTACHMENT_TARGET_EXISTS', '恢复目标的角色图片附件目录已经存在')
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  await fsImpl.promises.mkdir(temporary, { recursive: true })
  let published = false
  try {
    const names = await fsImpl.promises.readdir(source)
    for (const name of names) {
      if (!isSafeQyAssetId(name)) continue
      const sourceTarget = path.join(source, name)
      const destinationTarget = path.join(temporary, name)
      const stat = await assertAssetFileSafe(fsImpl, sourceTarget)
      if (!stat) continue
      await fsImpl.promises.copyFile(sourceTarget, destinationTarget)
    }
    await fsImpl.promises.rename(temporary, destination)
    published = true
    return true
  } finally {
    if (!published) await fsImpl.promises.rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
}

function refsFromDocument(document) {
  const refs = []
  for (const project of Array.isArray(document?.projects) ? document.projects : []) {
    for (const character of Array.isArray(project?.content?.characters) ? project.content.characters : []) {
      for (const image of Array.isArray(character?.characterImages) ? character.characterImages : []) {
        if (image?.attachment) refs.push(image.attachment)
      }
    }
  }
  return refs
}

/**
 * Create the sidecar file boundary. The API only returns base64 payloads to
 * the renderer, never absolute attachment paths.
 */
export function createQyAttachmentStore({ fsImpl = fs, logger = () => {} } = {}) {
  async function write(filePath, payloads = []) {
    const target = resolvedPath(filePath, '作品集路径')
    if (!Array.isArray(payloads)) throw fail('QY_ATTACHMENT_INVALID', '角色图片附件列表无效')
    if (!payloads.length) return { written: 0, skipped: 0, directory: qyAttachmentDirectory(target) }
    const directory = qyAttachmentDirectory(target)
    await ensureDirectory(fsImpl, directory)
    let written = 0
    let skipped = 0
    for (const payload of payloads) {
      if (!validPayload(payload)) throw fail('QY_ATTACHMENT_INVALID', '角色图片附件内容无效')
      const targetPath = path.join(directory, payload.ref.assetId)
      if (!isSafeQyAssetId(path.basename(targetPath)) || targetPath !== path.join(directory, path.basename(targetPath))) {
        throw fail('QY_ATTACHMENT_PATH_UNSAFE', '角色图片附件路径无效')
      }
      const bytes = Buffer.from(normalizeBase64(payload.payloadBase64), 'base64')
      if (await writeNewAsset(fsImpl, targetPath, bytes)) written += 1
      else skipped += 1
    }
    return { written, skipped, directory }
  }

  async function read(filePath, document) {
    const directory = qyAttachmentDirectory(filePath)
    if (!await maybeLstat(fsImpl, directory)) return []
    await assertDirectorySafe(fsImpl, directory)
    const payloads = []
    for (const ref of refsFromDocument(document)) {
      if (!isSafeQyAssetId(ref?.assetId) || !isImageMimeType(ref?.mimeType)
        || !Number.isSafeInteger(ref?.byteLength) || ref.byteLength < 0) {
        logger('Unable to read invalid character image attachment reference')
        continue
      }
      const target = path.join(directory, ref.assetId)
      const stat = await assertAssetFileSafe(fsImpl, target, true)
      if (!stat) continue
      const bytes = await fsImpl.promises.readFile(target)
      if (bytes.byteLength !== ref.byteLength) {
        logger(`Character image attachment byte length mismatch: ${ref.assetId}`)
        continue
      }
      payloads.push({
        ref: { assetId: ref.assetId, mimeType: ref.mimeType, byteLength: bytes.byteLength, ...(ref.sha256 ? { sha256: ref.sha256 } : {}) },
        payloadBase64: bytes.toString('base64'),
      })
    }
    return payloads
  }

  async function copy(sourcePath, destinationPath) {
    return copyDirectory(fsImpl, qyAttachmentDirectory(sourcePath), qyAttachmentDirectory(destinationPath))
  }

  async function remove(filePath) {
    const directory = qyAttachmentDirectory(filePath)
    const stat = await maybeLstat(fsImpl, directory)
    if (!stat) return false
    await assertDirectorySafe(fsImpl, directory)
    await fsImpl.promises.rm(directory, { recursive: true, force: true })
    return true
  }

  return { write, read, copy, remove, directory: qyAttachmentDirectory }
}

