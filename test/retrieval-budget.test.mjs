import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRetrievalIndex, retrieveContext, retrieveContextReport } from '../src/context/retrieval.ts'

function source(collection, resource, sourceIndex = 0) {
  return { collection, resource, sourceIndex }
}

function resource(id, title, extra = {}) {
  return {
    id,
    title,
    tag: '',
    summary: `${title} 的资料摘要。`,
    fields: {},
    ...extra,
  }
}

test('常驻资料遵守总条数上限，并按注入顺序稳定裁剪', () => {
  const sources = [
    source('world', resource('always-late', '常驻后置', {
      retrieval: { triggerStrategy: 'always', injectionOrder: 30 },
    }), 0),
    source('world', resource('always-first', '常驻前置', {
      retrieval: { triggerStrategy: 'always', injectionOrder: 10 },
    }), 1),
    source('characters', resource('keyword', '沈砚', {
      fields: { '触发键': '沈砚' },
    }), 2),
  ]

  const report = retrieveContextReport(sources, '沈砚', { maxResults: 1 })
  assert.deepEqual(report.matches.map((match) => match.resource.id), ['always-first'])
  assert.equal(report.skipped.length, 2)
  assert.ok(report.skipped.every((match) => match.reason === 'max-results'))
  assert.deepEqual(retrieveContext(sources, '沈砚', { maxResults: 1 }).map((match) => match.resource.id), ['always-first'])
})

test('Token 预算会裁剪常驻资料并报告每条被省略资料的估算', () => {
  const sources = [
    source('world', resource('first', '第一条', {
      retrieval: { triggerStrategy: 'always', injectionOrder: 10 },
      fields: { 内容: '第一条内容。' },
    }), 0),
    source('world', resource('second', '第二条', {
      retrieval: { triggerStrategy: 'always', injectionOrder: 20 },
      fields: { 内容: '第二条内容。' },
    }), 1),
  ]
  // Use a one-item full report to obtain the exact current estimate without
  // reaching into an implementation-only tokenizer helper.
  const firstOnly = retrieveContextReport(sources, '', { maxResults: 1 })
  const budget = firstOnly.estimatedTokens
  const report = retrieveContextReport(sources, '', { maxTokens: budget })
  assert.deepEqual(report.matches.map((match) => match.resource.id), ['first'])
  assert.equal(report.skipped.length, 1)
  assert.equal(report.skipped[0].resource.id, 'second')
  assert.equal(report.skipped[0].reason, 'max-tokens')
  assert.ok(report.skipped[0].estimatedTokens > 0)
})

test('禁用的直接命中不会进入结果，但会标明禁用原因；显式 includeDisabled 才会读取', () => {
  const disabled = source('characters', resource('disabled', '沈砚', {
    enabled: false,
    fields: { '触发键': '沈砚' },
  }))
  const report = retrieveContextReport([disabled], '沈砚')
  assert.equal(report.matches.length, 0)
  assert.equal(report.skipped.length, 1)
  assert.equal(report.skipped[0].reason, 'disabled')
  assert.equal(retrieveContext([disabled], '沈砚', { includeDisabled: true }).length, 1)
})

test('结构化检索索引只保留身份、来源和锁定元数据，不重复发送完整字段', () => {
  const match = {
    ...source('characters', resource('char-1', '沈砚', {
      summary: '这是一个很长的摘要。'.repeat(40),
      fields: { 性格: '谨慎', 当前状态: '在码头' },
      lockedAll: true,
      lockedFields: ['性格'],
      holdingItems: ['item-1'],
      reviewStatus: 'pending',
      reviewStatusLocked: true,
      injectionOrder: 12,
    })),
    depth: 1,
    matchedKeys: ['沈砚', '码头'],
    matchType: 'recursive',
  }
  const [entry] = buildRetrievalIndex([match])
  assert.deepEqual(entry, {
    collection: 'characters',
    id: 'char-1',
    title: '沈砚',
    summary: '这是一个很长的摘要。'.repeat(40).slice(0, 240),
    depth: 1,
    matchedKeys: ['沈砚', '码头'],
    matchType: 'recursive',
    injectionOrder: 12,
    lockedAll: true,
    lockedFields: ['性格'],
    holdingItems: ['item-1'],
    reviewStatus: 'pending',
    reviewStatusLocked: true,
  })
  assert.equal('fields' in entry, false)
  assert.equal('resource' in entry, false)
})
