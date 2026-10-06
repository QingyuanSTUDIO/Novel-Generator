/**
 * Desktop boundary for the portable `.qy` format.
 *
 * The renderer owns the TypeScript model, but Electron must validate files
 * without importing source TypeScript.  Keep this validator deliberately
 * dependency-free and strict about the portfolio envelope so malformed or
 * legacy single-work files are never silently opened as a blank portfolio.
 */

const forbiddenKeys = [
  'providers',
  'modelOptions',
  'theme',
  'settings',
  'agentHistory',
  'agentMessages',
  'agentConversations',
  'activeAgentConversationId',
  'agentPosition',
]

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isCanonicalId(value) {
  return isNonEmptyString(value) && value === value.trim()
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function checkForbiddenKeys(value, path, issues) {
  if (!isRecord(value)) return
  for (const key of forbiddenKeys) {
    if (key in value) issues.push(`${path}.${key} 不允许写入作品集文件`)
  }
}

function validateResources(value, path, issues) {
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

function validateGroups(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是数组`)
    return
  }
  for (const [index, group] of value.entries()) {
    const groupPath = `${path}[${index}]`
    if (!isRecord(group)) {
      issues.push(`${groupPath} 必须是对象`)
      continue
    }
    if (!isCanonicalId(group.id)) issues.push(`${groupPath}.id 必须是无首尾空格的非空字符串`)
    if (!isNonEmptyString(group.title)) issues.push(`${groupPath}.title 必须是非空字符串`)
    if (typeof group.collapsed !== 'boolean') issues.push(`${groupPath}.collapsed 必须是布尔值`)
  }
}

function validateResourceGroups(value, path, issues) {
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`)
    return
  }
  for (const collection of ['world', 'characters', 'items', 'skills']) {
    const groups = value[collection]
    if (!Array.isArray(groups)) {
      issues.push(`${path}.${collection} 必须是数组`)
      continue
    }
    validateGroups(groups, `${path}.${collection}`, issues)
  }
  if ('style' in value) issues.push(`${path}.style 不应存在；共享文风分组应放在 sharedContent.styleGroups`)
}

const requiredArrays = [
  'volumes',
  'chapters',
  'world',
  'characters',
  'items',
  'skills',
  'outline',
  'contextBlocks',
]

const requiredObjects = [
  'contextGroups',
  'worldEngine',
  'customModules',
  'memes',
]

/**
 * Return all validation failures. This mirrors the portable contract in
 * `src/data/portfolio.ts` closely enough for the desktop IPC boundary while
 * remaining loadable by Electron's plain Node runtime.
 */
export function validateQyPortfolio(value) {
  const issues = []
  if (!isRecord(value)) return ['根节点必须是对象']
  if (value.format !== 'qy') issues.push('format 必须为 "qy"')
  if (value.version !== 2) issues.push('version 必须为 2；旧版单作品文件不属于作品集格式')
  if (value.kind !== 'portfolio') issues.push('kind 必须为 "portfolio"')
  checkForbiddenKeys(value, '根节点', issues)

  const portfolio = value.portfolio
  if (!isRecord(portfolio)) {
    issues.push('portfolio 必须是对象')
  } else {
    if (!isCanonicalId(portfolio.id)) issues.push('portfolio.id 必须是无首尾空格的非空字符串')
    if (!isNonEmptyString(portfolio.title)) issues.push('portfolio.title 必须是非空字符串')
    if (!isFiniteNumber(portfolio.createdAt)) issues.push('portfolio.createdAt 必须是有限数字')
    if (!isFiniteNumber(portfolio.updatedAt)) issues.push('portfolio.updatedAt 必须是有限数字')
    if (typeof portfolio.activeProjectId !== 'string') issues.push('portfolio.activeProjectId 必须是字符串')
    checkForbiddenKeys(portfolio, 'portfolio', issues)
  }

  const shared = value.sharedContent
  if (!isRecord(shared)) {
    issues.push('sharedContent 必须是对象')
  } else {
    validateResources(shared.styleRules, 'sharedContent.styleRules', issues)
    validateGroups(shared.styleGroups, 'sharedContent.styleGroups', issues)
    checkForbiddenKeys(shared, 'sharedContent', issues)
  }

  const projects = value.projects
  const projectIds = new Set()
  if (!Array.isArray(projects)) {
    issues.push('projects 必须是数组')
  } else {
    for (const [index, project] of projects.entries()) {
      const projectPath = `projects[${index}]`
      if (!isRecord(project)) {
        issues.push(`${projectPath} 必须是对象`)
        continue
      }
      if (!isCanonicalId(project.id)) issues.push(`${projectPath}.id 必须是无首尾空格的非空字符串`)
      else if (projectIds.has(project.id)) issues.push(`${projectPath}.id 与其他作品重复：${project.id}`)
      else projectIds.add(project.id)
      // New works can remain untitled until the author names them. The
      // portfolio title is still required, but an empty project display title
      // is a valid editable state.
      if (typeof project.title !== 'string') issues.push(`${projectPath}.title 必须是字符串`)
      if (!isFiniteNumber(project.createdAt)) issues.push(`${projectPath}.createdAt 必须是有限数字`)
      if (!isFiniteNumber(project.updatedAt)) issues.push(`${projectPath}.updatedAt 必须是有限数字`)

      const content = project.content
      if (!isRecord(content)) {
        issues.push(`${projectPath}.content 必须是对象`)
        continue
      }
      checkForbiddenKeys(content, `${projectPath}.content`, issues)
      if ('style' in content) issues.push(`${projectPath}.content.style 不应存在；文风规则应放在 sharedContent.styleRules`)
      if (!isFiniteNumber(content.schemaVersion)) issues.push(`${projectPath}.content.schemaVersion 必须是有限数字`)
      for (const key of requiredArrays) {
        if (!(key in content)) issues.push(`${projectPath}.content.${key} 缺失`)
        else if (!Array.isArray(content[key])) issues.push(`${projectPath}.content.${key} 必须是数组`)
      }
      if (!('resourceGroups' in content)) {
        issues.push(`${projectPath}.content.resourceGroups 缺失`)
      } else {
        validateResourceGroups(content.resourceGroups, `${projectPath}.content.resourceGroups`, issues)
      }
      for (const key of requiredObjects) {
        if (!(key in content)) issues.push(`${projectPath}.content.${key} 缺失`)
        else if (!isRecord(content[key]) && key !== 'contextGroups') {
          issues.push(`${projectPath}.content.${key} 必须是对象`)
        } else if (key === 'contextGroups' && !Array.isArray(content[key])) {
          issues.push(`${projectPath}.content.contextGroups 必须是数组`)
        }
      }
    }
  }

  if (isRecord(portfolio) && typeof portfolio.activeProjectId === 'string' && Array.isArray(projects)) {
    if (projects.length > 0 && !projectIds.has(portfolio.activeProjectId)) {
      issues.push(`portfolio.activeProjectId 不存在：${portfolio.activeProjectId}`)
    } else if (projects.length === 0 && portfolio.activeProjectId !== '') {
      issues.push('空作品集的 portfolio.activeProjectId 必须为空字符串')
    }
  }
  return issues
}

export class QyPortfolioValidationError extends Error {
  constructor(issues) {
    super(`.qy 作品集文件校验失败：${issues.join('；')}`)
    this.name = 'QyPortfolioValidationError'
    this.issues = issues
  }
}

export function parseQyPortfolio(value) {
  const issues = validateQyPortfolio(value)
  if (issues.length > 0) throw new QyPortfolioValidationError(issues)
  // JSON.parse has already detached the object from the file buffer; clone it
  // again so callers never share a mutable object with any validation helper.
  return JSON.parse(JSON.stringify(value))
}

export function qyPortfolioTitle(value) {
  return isRecord(value?.portfolio) && isNonEmptyString(value.portfolio.title)
    ? value.portfolio.title.trim()
    : ''
}
