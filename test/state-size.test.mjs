import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_STATE_SIZE_LIMITS,
  describeStateSize,
  estimateJsonByteSize,
  estimateStateSize,
  formatByteSize,
  stateSizeLimitMessage,
  utf8ByteLength,
} from '../src/data/stateSize.ts'

test('JSON size estimates count UTF-8 bytes, including CJK text', () => {
  assert.equal(utf8ByteLength('归元'), Buffer.byteLength('归元', 'utf8'))
  assert.equal(estimateJsonByteSize({ text: '归元' }, 0), Buffer.byteLength('{"text":"归元"}', 'utf8'))
  assert.ok(estimateJsonByteSize({ text: '归元' }, 2) > estimateJsonByteSize({ text: '归元' }, 0))
})

test('state size report exposes sorted top-level occupancy and thresholds', () => {
  const report = estimateStateSize({ small: 'a', large: 'x'.repeat(12) }, { warningBytes: 1, maxBytes: 10000, space: 0 })
  assert.equal(report.level, 'warning')
  assert.equal(report.breakdown[0].key, 'large')
  assert.ok(report.breakdown[0].bytes > report.breakdown[1].bytes)
  assert.match(describeStateSize('profile', report), /profile约/)
})

test('state size report becomes an error only beyond the hard ceiling', () => {
  const report = estimateStateSize({ text: 'x'.repeat(40) }, { warningBytes: 1, maxBytes: 20, space: 0 })
  assert.equal(report.level, 'error')
  assert.match(stateSizeLimitMessage('作品集', report), /超过保存上限/)
})

test('a hard ceiling still applies when no warning threshold is supplied', () => {
  const report = estimateStateSize({ text: 'x'.repeat(40) }, { maxBytes: 20, space: 0 })
  assert.equal(report.level, 'error')
  assert.equal(report.warningBytes, 20)
  assert.equal(report.maxBytes, 20)
})

test('default profile limit matches the request boundary and .qy remains unbounded', () => {
  assert.ok(DEFAULT_STATE_SIZE_LIMITS.profileWarningBytes < DEFAULT_STATE_SIZE_LIMITS.profileMaxBytes)
  assert.equal(DEFAULT_STATE_SIZE_LIMITS.portfolioMaxBytes, Number.POSITIVE_INFINITY)
  assert.equal(estimateStateSize({ ok: true }, {
    warningBytes: DEFAULT_STATE_SIZE_LIMITS.profileWarningBytes,
    maxBytes: DEFAULT_STATE_SIZE_LIMITS.profileMaxBytes,
  }).level, 'ok')
  assert.equal(formatByteSize(0), '0 B')
})


