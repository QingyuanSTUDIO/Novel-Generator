import type { CharacterImage, CharacterImageAttachmentRef, PortfolioDocument } from '../types'

/**
 * A portable image may omit its inline data URL after the bytes have been
 * moved into the desktop attachment directory.  Old `.qy` data remains valid
 * because `dataUrl` is still accepted and handled as an inline fallback.
 */
export type PortableCharacterImage = Omit<CharacterImage, 'dataUrl'> & {
  dataUrl?: string
}

export type CharacterImageAttachmentPayload = {
  ref: CharacterImageAttachmentRef
  /** Base64 bytes to be written to the sidecar attachment file. */
  payloadBase64: string
}

export type CharacterImageExternalizationSkip = {
  imageId: string
  reason: 'missing-data-url' | 'unsupported-data-url' | 'invalid-attachment-id'
}

export type CharacterImageExternalizationResult = {
  images: PortableCharacterImage[]
  attachments: CharacterImageAttachmentPayload[]
  skipped: CharacterImageExternalizationSkip[]
  externalizedCount: number
  inlineCount: number
}

export type CharacterImageMaterializationResult = {
  images: CharacterImage[]
  missingAttachments: string[]
  invalidAttachments: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSafeAssetId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/[\x00-\x1f<>:"/\\|?*]/.test(value)
}

function isImageMimeType(value: unknown): value is string {
  return typeof value === 'string'
    && /^image\/[a-z0-9.+-]+$/i.test(value)
}

function normaliseBase64(value: string): string {
  return value.replace(/\s+/g, '')
}

function decodedByteLength(base64: string): number {
  const normalized = normaliseBase64(base64)
  if (!normalized || normalized.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(normalized)) return -1
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding)
}

function parseImageDataUrl(value: unknown): { mimeType: string; payloadBase64: string; byteLength: number } | null {
  if (typeof value !== 'string') return null
  // The current image editor emits base64 JPEGs.  Keeping this parser strict
  // prevents arbitrary text URLs or network locations from becoming an
  // attachment file.
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value)
  if (!match || !isImageMimeType(match[1])) return null
  const payloadBase64 = normaliseBase64(match[2])
  const byteLength = decodedByteLength(payloadBase64)
  if (byteLength < 0) return null
  return { mimeType: match[1].toLowerCase(), payloadBase64, byteLength }
}

function payloadHash(value: string): string {
  // A deterministic, non-cryptographic content key is enough for file names:
  // the sidecar writer still verifies the decoded byte length, and the
  // optional sha256 field remains available for a future integrity check.
  let hash = 0xcbf29ce4
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function imageAssetId(
  image: PortableCharacterImage,
  index: number,
  prefix: string,
  payloadBase64: string,
): string | null {
  const existing = image.attachment?.assetId
  // Existing references are retained only for images without a payload.  A
  // content key for fresh bytes prevents a failed/conflicting save from
  // overwriting the asset used by the previous `.qy` revision.
  if (!image.dataUrl && existing !== undefined) return isSafeAssetId(existing) ? existing : null
  const base = image.id || `image-${index + 1}`
  const candidate = `${prefix}${base}-${payloadHash(payloadBase64)}`
  return isSafeAssetId(candidate) ? candidate : null
}

function cloneImage(image: PortableCharacterImage): PortableCharacterImage {
  return {
    ...image,
    ...(image.attachment ? { attachment: { ...image.attachment } } : {}),
  }
}

/**
 * Move inline base64 payloads out of a portable image array.
 *
 * This is deliberately a pure boundary helper.  It does not write files and
 * therefore remains usable in the renderer and in tests without Node APIs.
 * The desktop save layer can persist `attachments` under a portfolio-owned
 * directory and serialize only `images` into `.qy`.
 */
export function externalizeCharacterImages(
  source: readonly PortableCharacterImage[],
  options: { assetIdPrefix?: string; deduplicate?: boolean } = {},
): CharacterImageExternalizationResult {
  const prefix = options.assetIdPrefix ?? 'character-image-'
  const deduplicate = options.deduplicate !== false
  const images: PortableCharacterImage[] = []
  const attachments: CharacterImageAttachmentPayload[] = []
  const skipped: CharacterImageExternalizationSkip[] = []
  const payloadToAsset = new Map<string, string>()
  const usedAssetIds = new Set<string>()
  let externalizedCount = 0
  let inlineCount = 0

  source.forEach((rawImage, index) => {
    const image = cloneImage(rawImage)
    const parsed = parseImageDataUrl(image.dataUrl)
    if (!image.dataUrl) {
      if (!image.attachment) skipped.push({ imageId: image.id, reason: 'missing-data-url' })
      images.push(image)
      inlineCount += 1
      return
    }
    if (!parsed) {
      skipped.push({ imageId: image.id, reason: 'unsupported-data-url' })
      images.push(image)
      inlineCount += 1
      return
    }

    let assetId = imageAssetId(image, index, prefix, parsed.payloadBase64)
    if (!assetId) {
      skipped.push({ imageId: image.id, reason: 'invalid-attachment-id' })
      images.push(image)
      inlineCount += 1
      return
    }
    // Existing references are trusted only as names, never as paths.  If two
    // images collide, give the later one a deterministic suffix.
    if (usedAssetIds.has(assetId)) {
      let suffix = 2
      const base = assetId
      while (usedAssetIds.has(`${base}-${suffix}`)) suffix += 1
      assetId = `${base}-${suffix}`
    }

    const payloadKey = `${parsed.mimeType}:${parsed.payloadBase64}`
    const previousAssetId = deduplicate ? payloadToAsset.get(payloadKey) : undefined
    if (previousAssetId) assetId = previousAssetId
    else {
      payloadToAsset.set(payloadKey, assetId)
      usedAssetIds.add(assetId)
      attachments.push({
        ref: {
          assetId,
          mimeType: parsed.mimeType,
          byteLength: parsed.byteLength,
        },
        payloadBase64: parsed.payloadBase64,
      })
    }

    image.attachment = {
      assetId,
      mimeType: parsed.mimeType,
      byteLength: parsed.byteLength,
      ...(image.attachment?.sha256 ? { sha256: image.attachment.sha256 } : {}),
    }
    delete image.dataUrl
    images.push(image)
    externalizedCount += 1
  })

  return { images, attachments, skipped, externalizedCount, inlineCount }
}

function isValidReference(value: unknown): value is CharacterImageAttachmentRef {
  return isRecord(value)
    && isSafeAssetId(value.assetId)
    && isImageMimeType(value.mimeType)
    && typeof value.byteLength === 'number'
    && Number.isSafeInteger(value.byteLength)
    && value.byteLength >= 0
}

/**
 * Rehydrate portable image references from sidecar payloads.
 *
 * Missing or malformed attachments are reported without discarding the
 * resource.  This lets the desktop UI show a broken-image state while the
 * rest of the portfolio remains editable.
 */
export function materializeCharacterImages(
  source: readonly PortableCharacterImage[],
  payloads: readonly CharacterImageAttachmentPayload[],
): CharacterImageMaterializationResult {
  const byAssetId = new Map<string, CharacterImageAttachmentPayload>()
  const invalidAttachments: string[] = []
  for (const payload of payloads) {
    if (!isValidReference(payload?.ref)
      || typeof payload.payloadBase64 !== 'string'
      || decodedByteLength(payload.payloadBase64) !== payload.ref.byteLength) {
      const id = isRecord(payload?.ref) && typeof payload.ref.assetId === 'string'
        ? payload.ref.assetId : '<unknown>'
      invalidAttachments.push(id)
      continue
    }
    byAssetId.set(payload.ref.assetId, payload)
  }

  const missingAttachments: string[] = []
  const missingSet = new Set<string>()
  const images: CharacterImage[] = source.map((rawImage) => {
    const image = cloneImage(rawImage)
    if (typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/')) {
      return image as CharacterImage
    }
    if (!isValidReference(image.attachment)) {
      return { ...image, dataUrl: '' } as CharacterImage
    }
    const payload = byAssetId.get(image.attachment.assetId)
    if (!payload) {
      if (!missingSet.has(image.attachment.assetId)) {
        missingSet.add(image.attachment.assetId)
        missingAttachments.push(image.attachment.assetId)
      }
      return { ...image, dataUrl: '' } as CharacterImage
    }
    const actualBytes = decodedByteLength(payload.payloadBase64)
    if (actualBytes !== image.attachment.byteLength
      || actualBytes !== payload.ref.byteLength
      || payload.ref.mimeType !== image.attachment.mimeType) {
      invalidAttachments.push(image.attachment.assetId)
      return { ...image, dataUrl: '' } as CharacterImage
    }
    return {
      ...image,
      dataUrl: `data:${payload.ref.mimeType};base64,${payload.payloadBase64}`,
    } as CharacterImage
  })
  return { images, missingAttachments, invalidAttachments }
}

export function isPortableCharacterImage(value: unknown): value is PortableCharacterImage {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.createdAt !== 'number') return false
  if ('dataUrl' in value && value.dataUrl !== undefined && typeof value.dataUrl !== 'string') return false
  return !('attachment' in value) || value.attachment === undefined || isValidReference(value.attachment)
}

export function isImageAttachmentId(value: unknown): value is string {
  return isSafeAssetId(value)
}

export type PortfolioImageExternalizationResult = {
  document: PortfolioDocument
  attachments: CharacterImageAttachmentPayload[]
  skipped: CharacterImageExternalizationSkip[]
  externalizedCount: number
  inlineCount: number
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function safeAssetPrefix(value: string): string {
  const normalized = value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
  return normalized ? `${normalized}-` : ''
}

/**
 * Apply the image boundary to every project in a portable portfolio.
 *
 * The returned document is a JSON-safe copy.  It contains only image
 * references where the current payload can be moved to an attachment file;
 * old or unsupported inline data remains untouched and is reported in
 * `skipped` so a save can never silently lose an image.
 */
export function externalizePortfolioDocumentImages(
  source: PortfolioDocument,
  options: { deduplicate?: boolean } = {},
): PortfolioImageExternalizationResult {
  const document = cloneJson(source) as PortfolioDocument
  const attachments: CharacterImageAttachmentPayload[] = []
  const skipped: CharacterImageExternalizationSkip[] = []
  let externalizedCount = 0
  let inlineCount = 0

  for (const project of document.projects) {
    const characters = Array.isArray(project.content.characters) ? project.content.characters : []
    for (const character of characters) {
      if (!Array.isArray(character.characterImages)) continue
      const result = externalizeCharacterImages(character.characterImages, {
        assetIdPrefix: safeAssetPrefix(`character-${project.id}-${character.id}`) || 'character-image-',
        deduplicate: options.deduplicate,
      })
      character.characterImages = result.images as typeof character.characterImages
      attachments.push(...result.attachments)
      skipped.push(...result.skipped)
      externalizedCount += result.externalizedCount
      inlineCount += result.inlineCount
    }
  }
  return { document, attachments, skipped, externalizedCount, inlineCount }
}

/**
 * Rehydrate every project's character images from the sidecar payload list.
 * A copied document is returned so opening a file never mutates the raw
 * object held by the Electron IPC boundary.
 */
export function materializePortfolioDocumentImages(
  source: PortfolioDocument,
  payloads: readonly CharacterImageAttachmentPayload[],
): PortfolioDocument {
  const document = cloneJson(source) as PortfolioDocument
  const byAssetId = new Map<string, CharacterImageAttachmentPayload>()
  for (const payload of payloads) {
    if (isValidReference(payload?.ref)
      && typeof payload.payloadBase64 === 'string'
      && decodedByteLength(payload.payloadBase64) === payload.ref.byteLength) {
      byAssetId.set(payload.ref.assetId, payload)
    }
  }
  for (const project of document.projects) {
    const characters = Array.isArray(project.content.characters) ? project.content.characters : []
    for (const character of characters) {
      if (!Array.isArray(character.characterImages)) continue
      const payloadsForCharacter = character.characterImages
        .map((image) => image.attachment ? byAssetId.get(image.attachment.assetId) : undefined)
        .filter((payload): payload is CharacterImageAttachmentPayload => Boolean(payload))
      character.characterImages = materializeCharacterImages(character.characterImages, payloadsForCharacter).images
    }
  }
  return document
}

