import type { Store } from '../types'
import type { ConsoleInspectQuery } from './types'

type InspectorOptions = {
  portfolio(): { id: string; title: string; path: string; projectId: string; chapterId?: string; ready: boolean }
  projects(): Array<{ id: string; title: string; store: Store }>
  providers(): unknown
  schema(collection?: string): unknown
  context(query: string): unknown
}

const omittedKeys = new Set([
  'providers', 'modeloptions', 'characterimages', 'charactercoverimageid',
  'apikey', 'accesstoken', 'authorization', 'password', 'secret', 'credentials',
])

/** CLI inspection describes writing data, never settings or image payloads. */
export function consoleProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(consoleProjection)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omittedKeys.has(key.toLowerCase().replace(/[\s_-]/gu, '')))
    .map(([key, item]) => [key, consoleProjection(item)]))
}

export function createConsoleInspector(options: InspectorOptions) {
  return (query: ConsoleInspectQuery) => {
    const portfolio = options.portfolio()
    if (query.kind === 'status') {
      return {
        ready: portfolio.ready,
        portfolioId: portfolio.id || null,
        portfolioTitle: portfolio.title,
        projectId: portfolio.projectId || null,
        chapterId: portfolio.chapterId || null,
        filePath: portfolio.path || null,
        savedFile: Boolean(portfolio.path),
        projects: options.projects().map(({ id, title }) => ({ id, title })),
      }
    }
    if (!portfolio.ready) throw new Error('作品尚未完成读取。')
    if (query.kind === 'providers') return consoleProjection(options.providers())
    if (query.kind === 'schema') return consoleProjection(options.schema(query.collection))
    const projectId = query.projectId || portfolio.projectId
    const project = options.projects().find((item) => item.id === projectId)
    if (!project) throw new Error('当前作品集中没有这个作品。')
    if (query.kind === 'context') {
      if (projectId !== portfolio.projectId) throw new Error('上下文检索需要先在桌面端打开目标作品。')
      return consoleProjection(options.context(query.query || ''))
    }
    if (query.collection && !['volumes', 'chapters', 'world', 'characters', 'items', 'skills',
      'outline', 'style', 'resourceGroups', 'contextBlocks', 'contextGroups', 'worldEngine',
      'customModules', 'memes'].includes(query.collection)) throw new Error('不支持的创作资料分类。')
    return {
      portfolioId: portfolio.id, projectId, title: project.title,
      ...(query.collection
        ? { collection: query.collection, data: consoleProjection(project.store[query.collection as keyof Store]) }
        : { store: consoleProjection(project.store) }),
    }
  }
}
