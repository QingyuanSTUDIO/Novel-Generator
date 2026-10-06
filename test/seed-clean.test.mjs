import assert from 'node:assert/strict'
import { test } from 'node:test'
import { seed } from '../src/data/seed.ts'

test('new seed data does not carry the retired 本章资料 placeholder field', () => {
  const resources = [
    ...(seed.world ?? []),
    ...(seed.characters ?? []),
    ...(seed.items ?? []),
    ...(seed.skills ?? []),
    ...(seed.outline ?? []),
    ...(seed.style ?? []),
  ]

  assert.ok(resources.length > 0)
  for (const resource of resources) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(resource.fields ?? {}, '本章资料'),
      false,
      `${resource.title} 不应继续带有已移除的“本章资料”字段`,
    )
  }
})
