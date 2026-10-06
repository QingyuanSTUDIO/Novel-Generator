import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseQyPortfolio,
  qyPortfolioTitle,
  QyPortfolioValidationError,
  validateQyPortfolio,
} from '../electron/qy.mjs'

function content(seed = 'a') {
  return {
    schemaVersion: 10,
    volumes: [],
    chapters: [],
    world: [],
    characters: [],
    items: [],
    skills: [],
    outline: [],
    contextBlocks: [],
    contextGroups: [],
    resourceGroups: { world: [], characters: [], items: [], skills: [] },
    worldEngine: {},
    customModules: { schemas: [], entries: [] },
    memes: { entries: [], updatedAt: 0, seed },
  }
}

function document() {
  return {
    format: 'qy',
    version: 2,
    kind: 'portfolio',
    portfolio: {
      id: 'portfolio-1',
      title: '我的作品集',
      createdAt: 1,
      updatedAt: 2,
      activeProjectId: 'project-a',
    },
    sharedContent: {
      styleRules: [],
      styleGroups: [],
    },
    projects: [{
      id: 'project-a',
      title: '第一部',
      createdAt: 1,
      updatedAt: 2,
      content: content(),
    }],
  }
}

test('Electron accepts a valid v2 portfolio and uses portfolio title', () => {
  const value = document()
  assert.deepEqual(validateQyPortfolio(value), [])
  assert.equal(qyPortfolioTitle(value), '我的作品集')
  assert.deepEqual(parseQyPortfolio(value), value)
})

test('Electron rejects legacy v1 single-work files', () => {
  assert.throws(
    () => parseQyPortfolio({ format: 'qy', version: 1, title: '旧作品', content: {} }),
    (error) => error instanceof QyPortfolioValidationError
      && error.issues.some((issue) => issue.includes('version 必须为 2')),
  )
})

test('Electron rejects application settings from portable files', () => {
  const value = document()
  value.projects[0].content.providers = []
  const issues = validateQyPortfolio(value)
  assert.ok(issues.some((issue) => issue.includes('providers')))
  assert.throws(() => parseQyPortfolio(value), QyPortfolioValidationError)
})
