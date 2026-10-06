import type {
  PortfolioDocument,
  PortfolioMetadata,
  PortfolioProject,
  PortfolioProjectContent,
  PortfolioSharedContent,
  Resource,
  Store,
} from '../types'

/**
 * Input accepted by `createPortfolioDocument`. The `portfolio` object form is
 * useful when preserving metadata from an existing file; the short fields are
 * convenient for a new portfolio.
 */
export type PortfolioDocumentInput = {
  portfolio?: Partial<PortfolioMetadata>
  portfolioId?: string
  id?: string
  title?: string
  createdAt?: number
  updatedAt?: number
  activeProjectId?: string
  projects: PortfolioProject[]
  sharedContent?: Partial<PortfolioSharedContent>
  styleRules?: Resource[]
}

export type PortfolioProjectInput = {
  id: string
  title: string
  createdAt?: number
  updatedAt?: number
}

export class PortfolioValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`.qy 作品集文件校验失败：${issues.join('；')}`)
    this.name = 'PortfolioValidationError'
    this.issues = issues
  }
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isCanonicalId(value: unknown): value is string {
  return isNonEmptyString(value) && value === value.trim()
}

function validateResourceArray(value: unknown, path: string, issues: string[]) {
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是数组`)
    return
  }
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`
    if (!isRecord(item)) {
      issues.push(`${itemPath} 必须是对象`)
      continue
    }
    if (!isCanonicalId(item.id)) issues.push(`${itemPath}.id 必须是无首尾空格的非空字符串`)
    if (!isNonEmptyString(item.title)) issues.push(`${itemPath}.title 必须是非空字符串`)
    if (!isRecord(item.fields)) issues.push(`${itemPath}.fields 必须是对象`)
  }
}

function validateResourceGroupArray(value: unknown, path: string, issues: string[]) {
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是数组`)
    return
  }
  for (const [index, rawGroup] of value.entries()) {
    const groupPath = `${path}[${index}]`
    if (!isRecord(rawGroup)) {
      issues.push(`${groupPath} 必须是对象`)
      continue
    }
    if (!isCanonicalId(rawGroup.id)) issues.push(`${groupPath}.id 必须是无首尾空格的非空字符串`)
    if (!isNonEmptyString(rawGroup.title)) issues.push(`${groupPath}.title 必须是非空字符串`)
    if (typeof rawGroup.collapsed !== 'boolean') issues.push(`${groupPath}.collapsed 必须是布尔值`)
  }
}

function validateResourceGroups(value: Record<string, unknown>, path: string, issues: string[]) {
  for (const collection of ['world', 'characters', 'items', 'skills']) {
    validateResourceGroupArray(value[collection], `${path}.${collection}`, issues)
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasForbiddenPortableKey(value: Record<string, unknown>, path: string, issues: string[]) {
  for (const key of [
    'providers',
    'modelOptions',
    'theme',
    'settings',
    'agentHistory',
    'agentMessages',
    'agentConversations',
    'activeAgentConversationId',
    'agentPosition',
  ]) {
    if (key in value) issues.push(`${path}.${key} 不允许写入作品集文件`)
  }
}

const requiredProjectArrays: Array<keyof PortfolioProjectContent> = [
  'volumes',
  'chapters',
  'world',
  'characters',
  'items',
  'skills',
  'outline',
  'contextBlocks',
  'resourceGroups',
]

const requiredProjectObjects: Array<keyof PortfolioProjectContent> = [
  'contextGroups',
  'worldEngine',
  'customModules',
  'memes',
]

/**
 * Return all structural problems instead of silently turning malformed data
 * into a blank work. `parsePortfolioDocument` uses this as its single source
 * of truth for version 2 validation.
 */
export function validatePortfolioDocument(value: unknown): string[] {
  const issues: string[] = []
  if (!isRecord(value)) return ['根节点必须是对象']

  if (value.format !== 'qy') issues.push('format 必须为 "qy"')
  if (value.version !== 2) issues.push('version 必须为 2；旧版单作品文件不属于作品集格式')
  if (value.kind !== 'portfolio') issues.push('kind 必须为 "portfolio"')
  hasForbiddenPortableKey(value, '根节点', issues)

  const portfolio = value.portfolio
  if (!isRecord(portfolio)) {
    issues.push('portfolio 必须是对象')
  } else {
    if (!isCanonicalId(portfolio.id)) issues.push('portfolio.id 必须是无首尾空格的非空字符串')
    if (!isNonEmptyString(portfolio.title)) issues.push('portfolio.title 必须是非空字符串')
    if (!isFiniteNumber(portfolio.createdAt)) issues.push('portfolio.createdAt 必须是有限数字')
    if (!isFiniteNumber(portfolio.updatedAt)) issues.push('portfolio.updatedAt 必须是有限数字')
    if (typeof portfolio.activeProjectId !== 'string') {
      issues.push('portfolio.activeProjectId 必须是字符串')
    }
    hasForbiddenPortableKey(portfolio, 'portfolio', issues)
  }

  const sharedContent = value.sharedContent
  if (!isRecord(sharedContent)) {
    issues.push('sharedContent 必须是对象')
  } else {
    validateResourceArray(sharedContent.styleRules, 'sharedContent.styleRules', issues)
    validateResourceGroupArray(sharedContent.styleGroups, 'sharedContent.styleGroups', issues)
    hasForbiddenPortableKey(sharedContent, 'sharedContent', issues)
  }

  const projects = value.projects
  if (!Array.isArray(projects)) {
    issues.push('projects 必须是数组')
  } else {
    const ids = new Set<string>()
    for (const [index, rawProject] of projects.entries()) {
      const path = `projects[${index}]`
      if (!isRecord(rawProject)) {
        issues.push(`${path} 必须是对象`)
        continue
      }
      if (!isCanonicalId(rawProject.id)) issues.push(`${path}.id 必须是无首尾空格的非空字符串`)
      else if (ids.has(rawProject.id)) issues.push(`${path}.id 与其他作品重复：${rawProject.id}`)
      else ids.add(rawProject.id)
      // A newly created work may intentionally have an empty display title;
      // the portfolio title itself remains required, but blank project names
      // are valid and are rendered as an untitled work until renamed.
      if (typeof rawProject.title !== 'string') issues.push(`${path}.title 必须是字符串`)
      if (!isFiniteNumber(rawProject.createdAt)) issues.push(`${path}.createdAt 必须是有限数字`)
      if (!isFiniteNumber(rawProject.updatedAt)) issues.push(`${path}.updatedAt 必须是有限数字`)

      const content = rawProject.content
      if (!isRecord(content)) {
        issues.push(`${path}.content 必须是对象`)
        continue
      }
      hasForbiddenPortableKey(content, `${path}.content`, issues)
      if ('style' in content) issues.push(`${path}.content.style 不应存在；文风规则应放在 sharedContent.styleRules`)
      if (!isFiniteNumber(content.schemaVersion)) issues.push(`${path}.content.schemaVersion 必须是有限数字`)
      for (const key of requiredProjectArrays) {
        if (!(key in content)) issues.push(`${path}.content.${String(key)} 缺失`)
        else if (key === 'resourceGroups') {
          if (!isRecord(content[key])) {
            issues.push(`${path}.content.resourceGroups 必须是对象`)
          } else {
            if ('style' in content[key]) issues.push(`${path}.content.resourceGroups.style 不应存在；文风规则分组应放在 sharedContent.styleGroups`)
            validateResourceGroups(content[key], `${path}.content.resourceGroups`, issues)
          }
        } else if (!Array.isArray(content[key])) {
          issues.push(`${path}.content.${String(key)} 必须是数组`)
        }
      }
      for (const key of requiredProjectObjects) {
        if (!(key in content)) {
          issues.push(`${path}.content.${String(key)} 缺失`)
        } else if (key === 'contextGroups' && !Array.isArray(content[key])) {
          issues.push(`${path}.content.contextGroups 必须是数组`)
        } else if (key !== 'contextGroups' && !isRecord(content[key])) {
          issues.push(`${path}.content.${String(key)} 必须是对象`)
        }
      }
    }

    if (isRecord(portfolio) && typeof portfolio.activeProjectId === 'string') {
      const activeId = portfolio.activeProjectId
      if (projects.length > 0 && !ids.has(activeId)) {
        issues.push(`portfolio.activeProjectId 不存在：${activeId}`)
      } else if (projects.length === 0 && activeId !== '') {
        issues.push('空作品集的 portfolio.activeProjectId 必须为空字符串')
      }
    }
  }

  return issues
}

export function isPortfolioDocument(value: unknown): value is PortfolioDocument {
  return validatePortfolioDocument(value).length === 0
}

export function parsePortfolioDocument(value: unknown): PortfolioDocument {
  const issues = validatePortfolioDocument(value)
  if (issues.length > 0) throw new PortfolioValidationError(issues)
  return clonePlain(value) as PortfolioDocument
}

function generatedId(prefix: string) {
  // Keep the Crypto receiver when calling `randomUUID`.  Extracting the
  // method first makes Chromium/Node's Web Crypto implementation throw
  // `Illegal invocation`, which used to surface when the first portfolio was
  // saved through “另存为” and had no existing portfolio id yet.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Convert the current in-memory Store shape into one project payload. This
 * helper is intentionally independent from App.vue so the persistence layer
 * can later switch projects without changing the data contract.
 */
export function createPortfolioProject(store: Store, input: PortfolioProjectInput): PortfolioProject {
  const copy = clonePlain(store)
  const {
    providers: _providers,
    modelOptions: _modelOptions,
    style: _style,
    resourceGroups: sourceResourceGroups,
    ...content
  } = copy
  const { style: _styleGroup, ...resourceGroups } = sourceResourceGroups
  const now = Date.now()
  return {
    id: input.id,
    title: input.title.trim(),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    content: { ...content, resourceGroups } as PortfolioProjectContent,
  }
}

export function createPortfolioDocument(input: PortfolioDocumentInput): PortfolioDocument {
  const now = Date.now()
  const sourceMetadata = input.portfolio ?? {}
  const projects = clonePlain(input.projects)
  const activeProjectId = input.activeProjectId
    ?? sourceMetadata.activeProjectId
    ?? projects[0]?.id
    ?? ''
  const document: PortfolioDocument = {
    format: 'qy',
    version: 2,
    kind: 'portfolio',
    portfolio: {
      id: input.portfolioId ?? input.id ?? sourceMetadata.id ?? generatedId('portfolio'),
      title: (input.title ?? sourceMetadata.title ?? '').trim(),
      createdAt: input.createdAt ?? sourceMetadata.createdAt ?? now,
      updatedAt: input.updatedAt ?? sourceMetadata.updatedAt ?? now,
      activeProjectId,
    },
    sharedContent: {
      styleRules: clonePlain(input.styleRules ?? input.sharedContent?.styleRules ?? []),
      styleGroups: clonePlain(input.sharedContent?.styleGroups ?? []),
    },
    projects,
  }
  const issues = validatePortfolioDocument(document)
  if (issues.length > 0) throw new PortfolioValidationError(issues)
  return document
}
