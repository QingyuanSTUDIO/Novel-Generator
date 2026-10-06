import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  externalizeCharacterImages,
  isImageAttachmentId,
  isPortableCharacterImage,
  materializeCharacterImages,
} from '../src/data/characterAttachments.ts'

const redPixel = 'data:image/png;base64,iVBORw0KGgo='

test('externalizing images removes inline payloads and returns safe sidecar payloads', () => {
  const source = [{
    id: 'image-one',
    name: '角色',
    dataUrl: redPixel,
    createdAt: 1,
  }]
  const result = externalizeCharacterImages(source)

  assert.equal(result.externalizedCount, 1)
  assert.equal(result.inlineCount, 0)
  assert.equal(result.images[0].dataUrl, undefined)
  assert.match(result.images[0].attachment.assetId, /^character-image-image-one-[0-9a-f]+$/)
  assert.equal(result.images[0].attachment.mimeType, 'image/png')
  assert.equal(result.images[0].attachment.byteLength, 8)
  assert.deepEqual(result.attachments.map((entry) => entry.payloadBase64), ['iVBORw0KGgo='])
  assert.deepEqual(source[0].dataUrl, redPixel)
})

test('identical images share one attachment while each image keeps its reference', () => {
  const source = [
    { id: 'first', name: '一', dataUrl: redPixel, createdAt: 1 },
    { id: 'second', name: '二', dataUrl: redPixel, createdAt: 2 },
  ]
  const result = externalizeCharacterImages(source)
  assert.equal(result.attachments.length, 1)
  assert.equal(result.images[0].attachment.assetId, result.images[1].attachment.assetId)

  const separate = externalizeCharacterImages(source, { deduplicate: false })
  assert.equal(separate.attachments.length, 2)
  assert.notEqual(separate.images[0].attachment.assetId, separate.images[1].attachment.assetId)
})

test('unsupported and missing data stay inline-compatible and are reported', () => {
  const result = externalizeCharacterImages([
    { id: 'remote', name: '网络地址', dataUrl: 'https://example.test/a.png', createdAt: 1 },
    { id: 'empty', name: '空', dataUrl: '', createdAt: 2 },
  ])
  assert.equal(result.externalizedCount, 0)
  assert.equal(result.inlineCount, 2)
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['unsupported-data-url', 'missing-data-url'])
  assert.equal(result.images[0].dataUrl, 'https://example.test/a.png')
  assert.equal(result.images[1].dataUrl, '')
})

test('materialization round-trips externalized images and reports missing payloads', () => {
  const source = [
    { id: 'first', name: '一', dataUrl: redPixel, createdAt: 1 },
    { id: 'second', name: '二', dataUrl: redPixel, createdAt: 2 },
  ]
  const externalized = externalizeCharacterImages(source)
  const materialized = materializeCharacterImages(externalized.images, externalized.attachments)
  assert.deepEqual(materialized.missingAttachments, [])
  assert.deepEqual(materialized.invalidAttachments, [])
  assert.deepEqual(materialized.images.map((image) => image.dataUrl), [redPixel, redPixel])

  const missing = materializeCharacterImages(externalized.images, [])
  assert.deepEqual(missing.missingAttachments, [externalized.images[0].attachment.assetId])
  assert.equal(missing.images[0].dataUrl, '')
})

test('malformed payloads never become image data', () => {
  const source = [{
    id: 'image-one',
    name: '角色',
    attachment: { assetId: 'asset-one', mimeType: 'image/png', byteLength: 8 },
    createdAt: 1,
  }]
  assert.equal(isPortableCharacterImage(source[0]), true)
  const result = materializeCharacterImages(source, [{
    ref: { assetId: 'asset-one', mimeType: 'image/png', byteLength: 8 },
    payloadBase64: 'not-base64',
  }])
  assert.deepEqual(result.invalidAttachments, ['asset-one'])
  assert.equal(result.images[0].dataUrl, '')
})

test('attachment IDs reject path traversal and control characters', () => {
  assert.equal(isImageAttachmentId('safe-id'), true)
  assert.equal(isImageAttachmentId('../outside'), false)
  assert.equal(isImageAttachmentId('folder/file'), false)
  assert.equal(isImageAttachmentId('bad\u0000id'), false)
})

