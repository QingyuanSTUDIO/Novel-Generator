import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPortfolioDocument,
  createPortfolioProject,
  parsePortfolioDocument,
  validatePortfolioDocument,
  PortfolioValidationError,
} from '../src/data/portfolio.ts'

function createStore(seed = '') {
  return {
    schemaVersion: 10,
    volumes: [{ id: `v-${seed}`, title: `卷 ${seed}`, collapsed: false }],
    chapters: [{ id: `c-${seed}`, title: `第一章 ${seed}`, status: '草稿', content: '正文', wordCount: 2, volumeId: `v-${seed}` }],
    world: [],
    characters: [],
    items: [],
    skills: [],
    outline: [],
    style: [{ id: `style-${seed}`, title: '共享文风', tag: '', summary: '', fields: {} }],
    providers: [{ id: 'api-secret', title: '不应导出', tag: '', summary: '', fields: { key: 'secret' } }],
    modelOptions: { 'api-secret': ['model-a'] },
    contextBlocks: [],
    contextGroups: [],
    resourceGroups: { world: [], characters: [], items: [], skills: [], style: [] },
    customModules: { schemas: [], entries: [] },
    memes: { entries: [], updatedAt: 0 },
    worldEngine: {},
  }
}

test('version 2 .qy portfolio keeps two projects and shared style separate', () => {
  const first = createPortfolioProject(createStore('a'), { id: 'project-a', title: '第一部' })
  const second = createPortfolioProject(createStore('b'), { id: 'project-b', title: '第二部' })
  const document = createPortfolioDocument({
    portfolioId: 'portfolio-1',
    title: '我的作品集',
    activeProjectId: 'project-b',
    projects: [first, second],
    styleRules: [{ id: 'style-shared', title: '统一文风', tag: '', summary: '', fields: {} }],
    createdAt: 1,
    updatedAt: 2,
  })

  assert.equal(document.format, 'qy')
  assert.equal(document.version, 2)
  assert.equal(document.kind, 'portfolio')
  assert.equal(document.portfolio.activeProjectId, 'project-b')
  assert.deepEqual(document.projects.map((project) => project.title), ['第一部', '第二部'])
  assert.equal(document.sharedContent.styleRules[0].title, '统一文风')
  assert.equal('providers' in document.projects[0].content, false)
  assert.equal('modelOptions' in document.projects[0].content, false)
  assert.equal('style' in document.projects[0].content, false)
  assert.equal('style' in document.projects[0].content.resourceGroups, false)
  assert.deepEqual(document.sharedContent.styleGroups, [])

  const parsed = parsePortfolioDocument(document)
  assert.deepEqual(parsed, document)
})

test('portfolio creation without an id keeps Web Crypto receiver bound', () => {
  const document = createPortfolioDocument({
    title: '首次另存为',
    projects: [],
    styleRules: [],
  })

  assert.match(document.portfolio.id, /^portfolio-/)
  assert.ok(document.portfolio.id.length > 'portfolio-'.length)
})

test('portfolio validation reports duplicate ids, bad active project and exported settings', () => {
  const first = createPortfolioProject(createStore('a'), { id: 'same', title: '第一部' })
  const second = createPortfolioProject(createStore('b'), { id: 'same', title: '第二部' })
  const document = createPortfolioDocument({
    portfolioId: 'portfolio-1',
    title: '我的作品集',
    projects: [first],
    styleRules: [],
  })
  document.portfolio.activeProjectId = 'missing'
  document.projects.push(second)
  document.projects[0].content.providers = []
  document.projects[0].content.agentHistory = []

  const issues = validatePortfolioDocument(document)
  assert.ok(issues.some((issue) => issue.includes('重复')))
  assert.ok(issues.some((issue) => issue.includes('activeProjectId 不存在')))
  assert.ok(issues.some((issue) => issue.includes('providers')))
  assert.ok(issues.some((issue) => issue.includes('agentHistory')))
  assert.throws(() => parsePortfolioDocument(document), (error) => {
    assert.ok(error instanceof PortfolioValidationError)
    assert.equal(error.issues.length, issues.length)
    return true
  })
})

test('version 1 and missing portfolio fields are rejected without blank fallback', () => {
  const oldDocument = { format: 'qy', version: 1, title: '旧文件', content: { chapters: [], volumes: [] } }
  const issues = validatePortfolioDocument(oldDocument)
  assert.ok(issues.some((issue) => issue.includes('version 必须为 2')))
  assert.ok(issues.some((issue) => issue.includes('kind')))
  assert.throws(() => parsePortfolioDocument(oldDocument), PortfolioValidationError)

  const empty = createPortfolioDocument({
    portfolioId: 'empty',
    title: '空作品集',
    projects: [],
  })
  assert.equal(empty.portfolio.activeProjectId, '')
  assert.deepEqual(empty.projects, [])
  assert.deepEqual(parsePortfolioDocument(empty), empty)
})

test('portfolio validation rejects malformed shared structures and non-canonical ids', () => {
  const project = createPortfolioProject(createStore('a'), { id: 'project-a', title: '第一部' })
  const document = createPortfolioDocument({
    portfolioId: 'portfolio-1',
    title: '我的作品集',
    projects: [project],
    styleRules: [],
  })
  document.portfolio.id = ' portfolio-1 '
  document.sharedContent.styleRules = [{ id: 'style-bad', title: '', fields: '不是对象' }]
  document.sharedContent.styleGroups = [{ id: 'group-bad', title: '规则', collapsed: 'false' }]
  delete document.projects[0].content.contextGroups

  const issues = validatePortfolioDocument(document)
  assert.ok(issues.some((issue) => issue.includes('portfolio.id')))
  assert.ok(issues.some((issue) => issue.includes('styleRules[0].title')))
  assert.ok(issues.some((issue) => issue.includes('styleRules[0].fields')))
  assert.ok(issues.some((issue) => issue.includes('styleGroups[0].collapsed')))
  assert.ok(issues.some((issue) => issue.includes('contextGroups 缺失')))
})
