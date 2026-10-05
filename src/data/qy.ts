import type { Store } from '../types'

/**
 * Portable work-file format. A .qy document deliberately contains only
 * story/project content; API presets, theme, autosave and other application
 * settings stay in the desktop profile.
 */
export type QyContent = Omit<Store, 'providers' | 'modelOptions'>

export type QyDocument = {
  format: 'qy'
  version: 1
  title: string
  updatedAt: number
  content: QyContent
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createQyDocument(store: Store, title: string): QyDocument {
  const copy = clonePlain(store)
  const { providers: _providers, modelOptions: _modelOptions, ...content } = copy
  return {
    format: 'qy',
    version: 1,
    title: title.trim(),
    updatedAt: Date.now(),
    content: content as QyContent,
  }
}

export function parseQyDocument(value: unknown): QyDocument {
  if (!value || typeof value !== 'object') throw new Error('文件内容不是有效的 .qy 文档')
  const raw = value as Partial<QyDocument>
  if (raw.format !== 'qy' || raw.version !== 1 || !raw.content || typeof raw.content !== 'object') {
    throw new Error('文件格式或版本不受支持')
  }
  const content = raw.content as Partial<QyContent>
  if (!Array.isArray(content.chapters) || !Array.isArray(content.volumes)) {
    throw new Error('作品文件缺少章节或分卷数据')
  }
  return {
    format: 'qy',
    version: 1,
    title: typeof raw.title === 'string' ? raw.title : '',
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
    content: clonePlain(content) as QyContent,
  }
}

export function mergeQyContent(document: QyDocument, currentStore: Store): Store {
  const current = clonePlain(currentStore)
  const content = clonePlain(document.content)
  return {
    ...current,
    ...content,
    // These are application settings and must never be imported from a work
    // file, even if a hand-edited document contains them.
    providers: current.providers,
    modelOptions: current.modelOptions,
  }
}

