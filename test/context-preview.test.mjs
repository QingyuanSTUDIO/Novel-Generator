import test from 'node:test'
import assert from 'node:assert/strict'
import { createContextPreviewSnapshot } from '../src/context/contextPreview.ts'

test('context preview preserves retrieval provenance, skip reasons, message estimates, and budget', () => {
  const resource = {
    id: 'r1', title: '角色甲', tag: '', summary: '角色摘要', fields: {},
  }
  const match = {
    collection: 'characters', resource, sourceIndex: 0, depth: 1,
    matchedKeys: ['角色甲'], matchType: 'recursive', estimatedTokens: 42,
  }
  const snapshot = createContextPreviewSnapshot({
    purpose: 'agent', query: '角色甲', matches: [match], skipped: [{
      collection: 'items', id: 'i1', title: '道具乙', depth: 0,
      matchedKeys: ['道具乙'], matchType: 'direct', reason: 'layout-disabled', estimatedTokens: 18,
    }],
    parts: [{ collection: 'characters', label: '角色甲', rank: 10, text: '角色数据', estimatedTokens: 5 }],
    messages: [
      { role: 'system', content: '系统约束' },
      { role: 'user', content: '请更新角色' },
    ],
  })
  assert.equal(snapshot.purpose, 'agent')
  assert.equal(snapshot.resources[0].depth, 1)
  assert.equal(snapshot.resources[0].estimatedTokens, 42)
  assert.equal(snapshot.skipped[0].reason, 'layout-disabled')
  assert.equal(snapshot.parts[0].estimatedTokens, 5)
  assert.equal(snapshot.messages.length, 2)
  assert.ok(snapshot.estimatedInputTokens > 0)
})
