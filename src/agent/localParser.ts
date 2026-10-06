import type { AgentOperation, AgentResourceType } from './schema'
import { agentResourceTemplateFields, strictStandardResourceTypes } from './resourceFieldPolicy.ts'

type ParsedAgentCommand = { message: string; operations: AgentOperation[] }
type AgentGroupCollection = 'world' | 'characters' | 'items' | 'skills' | 'style'

const groupCollectionRules: Array<{ collection: AgentGroupCollection; words: string[] }> = [
  { collection: 'world', words: ['世界书'] },
  { collection: 'characters', words: ['角色', '人物'] },
  { collection: 'items', words: ['道具', '物品'] },
  { collection: 'skills', words: ['技能'] },
  { collection: 'style', words: ['文风规则', '文风'] },
]

const groupNounPattern = /折叠栏|分组/u
const quotePattern = /[“「『"]([^”」』"]+)[”」』"]/gu

function cleanGroupValue(value: string) {
  return value.trim().replace(/^[“「『"]|[”」』"]$/gu, '').replace(/(?:折叠栏|分组)$/u, '').trim()
}

function getQuotedValues(text: string) {
  return [...text.matchAll(quotePattern)].map((match) => match[1].trim()).filter(Boolean)
}

function inferGroupCollection(text: string, activeCollection?: string): AgentGroupCollection | undefined {
  const cleanText = text.replace(quotePattern, ' ')
  const prefix = cleanText.split(/叫做?|名为|命名为|名称为|标题为/u)[0]

  for (const rule of groupCollectionRules) {
    const words = rule.words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
    const category = `(?:${words})(?:卡|条目)?`
    const categoryBeforeGroup = new RegExp(`${category}\\s*(?:页面?\\s*)?(?:折叠栏|分组)`, 'u')
    const pageContext = new RegExp(`(?:在|到|从|给|对)?\\s*${category}(?:页面?)?(?:里|中|内|上)(?:面)?`, 'u')
    const leadingCategory = new RegExp(`^\\s*${category}(?:页面?)?\\s*[:：，,]?`, 'u')
    if (categoryBeforeGroup.test(prefix) || pageContext.test(cleanText) || leadingCategory.test(cleanText)) return rule.collection
  }

  return isGroupCollection(activeCollection) ? activeCollection : undefined
}

function isGroupCollection(value: string | undefined): value is AgentGroupCollection {
  return value === 'world' || value === 'characters' || value === 'items' || value === 'skills' || value === 'style'
}

function extractGroupTitle(text: string) {
  const quoted = getQuotedValues(text)
  if (quoted.length) return quoted[quoted.length - 1]

  const afterNoun = text.match(/(?:折叠栏|分组)(?:的)?(?:名称|名字|标题)?\s*(?:叫做?|名为|命名为|设置为|为|是|[:：])?\s*([^，,。；;]+)$/u)
  if (afterNoun?.[1]) return cleanGroupValue(afterNoun[1])

  const named = text.match(/(?:叫做?|名为|命名为|名称为|标题为)\s*([^，,。；;]+?)(?:的)?(?:折叠栏|分组)?(?:[，,。；;]|$)/u)
  if (named?.[1]) return cleanGroupValue(named[1])

  const withoutCommand = text
    .replace(/^(?:请|帮我|麻烦)?\s*(?:新建|创建|新增|添加|建立|删除|移除|删掉|取消)\s*/u, '')
    .replace(/(?:世界书|角色|人物|道具|物品|技能|文风规则|文风)(?:卡|条目)?/gu, '')
    .replace(/(?:一个|一条|名为|叫做?|名称为|标题为|折叠栏|分组)/gu, '')
    .replace(/[，,。；;].*$/u, '')
  return cleanGroupValue(withoutCommand) || undefined
}

function parseGroupCommand(text: string, activeCollection?: string): ParsedAgentCommand | undefined {
  if (!groupNounPattern.test(text)) return undefined

  const collection = inferGroupCollection(text, activeCollection)
  const quoted = getQuotedValues(text)
  const hasCreate = /新建|创建|新增|添加|建立/u.test(text)
  const hasDelete = /删除|移除|删掉/u.test(text)
  const hasMove = /放进|放入|移入|归入|移动到|移到|放到|拖入|拖到|加入|移出|取消分组|清除分组|未分组/u.test(text)

  if (hasCreate) {
    if (!collection) return { message: '请说明要在哪类内容中创建折叠栏，例如“世界书”或“角色”；也可以从对应栏目中打开 Agent。', operations: [] }
    const title = extractGroupTitle(text)
    if (!title) return { message: '请提供新折叠栏的名称。', operations: [] }
    const operation = { action: 'create_resource_group', collection, title }
    return { message: `已准备在${groupCollectionRules.find((rule) => rule.collection === collection)?.words[0]}中创建折叠栏“${title}”。`, operations: [operation as unknown as AgentOperation] }
  }

  if (hasDelete) {
    if (!collection) return { message: '请说明要删除哪类内容中的折叠栏，例如“世界书”或“角色”。', operations: [] }
    const target = extractGroupTitle(text)
    if (!target) return { message: '请提供要删除的折叠栏名称。删除折叠栏会保留其中的卡片，并将卡片移回未分组。', operations: [] }
    const operation = { action: 'delete_resource_group', collection, target }
    return { message: `已准备删除折叠栏“${target}”；其中的卡片会保留并移回未分组。`, operations: [operation as unknown as AgentOperation] }
  }

  if (hasMove) {
    if (!collection) return { message: '请说明要移动哪类内容中的条目，例如“世界书”或“角色”。', operations: [] }
    const ungrouped = /移出(?:折叠栏|分组)|取消分组|清除分组|移到未分组|放回未分组|设为未分组/u.test(text)
    const target = quoted[0] ?? extractMoveTarget(text)
    if (!target) return { message: '请提供要移动的条目名称。', operations: [] }
    const groupTarget = ungrouped ? null : quoted[1] ?? extractMoveGroupTarget(text)
    if (!ungrouped && !groupTarget) return { message: '请提供目标折叠栏名称，或明确说明移回未分组。', operations: [] }
    const operation = { action: 'move_resource_to_group', collection, target, groupTarget }
    const destination = groupTarget ? `折叠栏“${groupTarget}”` : '未分组'
    return { message: `已准备将“${target}”移入${destination}。`, operations: [operation as unknown as AgentOperation] }
  }

  return undefined
}

function extractMoveTarget(text: string) {
  const match = text.match(/(?:把|将)\s*(.+?)\s*(?:放进|放入|移入|归入|移动到|移到|放到|拖入|拖到|加入|移出|取消分组|清除分组|移到未分组|放回未分组)/u)
  return match?.[1] ? cleanGroupValue(match[1].replace(/^(?:条目|卡片)\s*/u, '')) : undefined
}

function extractMoveGroupTarget(text: string) {
  const match = text.match(/(?:放进|放入|移入|归入|移动到|移到|放到|拖入|拖到|加入)\s*(.+?)(?:折叠栏|分组)?(?:里|中)?[。！!？?，,；;]?$/u)
  return match?.[1] ? cleanGroupValue(match[1]) : undefined
}

const resourceRules: Array<{ type: AgentResourceType; words: string[]; label: string; defaultTitle: string }> = [
  { type: 'character', words: ['角色', '人物'], label: '角色', defaultTitle: '未命名角色' },
  { type: 'item', words: ['道具', '物品'], label: '道具', defaultTitle: '未命名道具' },
  { type: 'skill', words: ['技能'], label: '技能', defaultTitle: '未命名技能' },
  { type: 'world', words: ['世界书', '设定', '条目'], label: '世界书条目', defaultTitle: '未命名世界书条目' },
  { type: 'outline', words: ['大纲', '章节'], label: '大纲条目', defaultTitle: '未命名大纲条目' },
  { type: 'world_event', words: ['世界引擎', '世界事件', '行动', '大势'], label: '世界引擎事件', defaultTitle: '未命名世界事件' },
  { type: 'style', words: ['文风', '规则'], label: '文风规则', defaultTitle: '未命名文风规则' },
]

function parseKeyValues(text: string) {
  const fields: Record<string, string> = {}
  for (const part of text.split(/[，,；;]/)) {
    const match = part.trim().match(/^([^:：=]+)[:：=](.+)$/)
    if (match) fields[match[1].trim()] = match[2].trim()
  }
  return fields
}

function completeLocalCreateFields(resourceType: AgentResourceType, fields: Record<string, string>) {
  if (!strictStandardResourceTypes.includes(resourceType as (typeof strictStandardResourceTypes)[number])) {
    return { fields: Object.keys(fields).length ? fields : undefined, includeAllFields: undefined }
  }
  return {
    fields: Object.fromEntries(agentResourceTemplateFields[resourceType].map((field) => [field, fields[field] ?? ''])),
    includeAllFields: true as const,
  }
}

function extractTitle(prompt: string, words: string[], fallback: string) {
  const quoted = prompt.match(/[“"「『]([^”"」』]+)[”"」』]/)
  if (quoted?.[1]) return quoted[1].trim()
  const named = prompt.match(/名为\s*([^，,。；;]+?)(?:的)?(?:角色|人物|道具|物品|技能|世界书条目|世界书|条目|大纲条目|大纲|章节|文风规则|文风|规则)?(?:[，,。；;]|$)/)
  if (named?.[1]) return named[1].trim()
  const colon = prompt.match(/[:：]\s*([^，,。；;]+)(?:[，,。；;]|$)/)
  if (colon?.[1]) return colon[1].trim()
  let title = prompt.replace(/^(请|帮我|麻烦)?\s*(创建|新建|添加|生成|建立)\s*(一个|一条|一名|一个名为)?/u, '').trim()
  for (const word of words) title = title.replace(word, '')
  title = title.replace(/^(卡|条目)\s*/u, '').split(/[，,。；;]/)[0].trim()
  return title || fallback
}

export function parseLocalAgentPrompt(prompt: string, activeCollection?: string): ParsedAgentCommand {
  const text = prompt.trim()
  if (!text) return { message: '请告诉我需要创建、修改或写入什么。', operations: [] }

  if (/(搜索|检索|查找|收集).*(网络热梗|热梗|网络梗|流行梗)|网络热梗.*(搜索|检索|查找|收集)/u.test(text)) {
    const engine = /谷歌|Google/i.test(text) ? 'google' : /DuckDuckGo|鸭鸭/i.test(text) ? 'duckduckgo' : 'bing'
    const quoted = text.match(/[“「『"]([^”」』"]+)[”」』"]/u)?.[1]
    const query = quoted?.trim() || text.replace(/帮我|请|搜索|检索|查找|收集|一下|网络热梗|网络梗|热梗|最新|近期|今年/gu, ' ').replace(/\s+/gu, ' ').trim() || '近期网络热梗'
    const operation = { action: 'search_web_memes', engine, query, limit: 10 } as AgentOperation
    return { message: '已准备联网搜索网络热梗，并将搜索结果整理后写入网络热梗栏目，不会创建世界书条目。', operations: [operation] }
  }

  const groupCommand = parseGroupCommand(text, activeCollection)
  if (groupCommand) return groupCommand

  const append = text.match(/(?:追加|写入|续写)(?:当前章节|正文|章节正文)?\s*[:：]\s*([\s\S]+)/)
  if (append?.[1]) return { message: '已准备把内容追加到当前章节正文。', operations: [{ action: 'append_chapter', content: append[1].trim() }] }

  const update = text.match(/^(?:修改|更新|编辑)\s*(角色|人物|道具|物品|技能|世界书条目|世界书|条目|大纲条目|大纲|世界引擎|世界事件|行动|大势|文风规则|文风|规则)?\s*[:：]?\s*([^，,：:]+)(?:[，,]\s*|\s+)([\s\S]+)$/)
  if (update?.[2] && update?.[3]) {
    const rule = resourceRules.find((item) => update[1] && item.words.some((word) => update[1]?.includes(word)))
    const fields = parseKeyValues(update[3])
    const summaryMatch = update[3].match(/(?:摘要|简介|说明|描述)[:：]\s*([^，,；;]+)/)
    const operation: AgentOperation = {
      action: 'update_resource',
      resourceType: rule?.type ?? 'world',
      target: update[2].trim(),
      summary: summaryMatch?.[1]?.trim(),
      fields: Object.keys(fields).length ? fields : undefined,
    }
    return { message: `已准备更新${rule?.label ?? '资料'}“${operation.target}”。`, operations: [operation] }
  }

  const rule = resourceRules.find((item) => item.words.some((word) => text.includes(word)))
  if (rule && /创建|新建|添加|生成|建立/.test(text)) {
    const title = extractTitle(text, rule.words, rule.defaultTitle)
    const fields = parseKeyValues(text)
    const summaryMatch = text.match(/(?:摘要|简介|说明|描述)[:：]\s*([^，,；;]+)/)
    delete fields['摘要']
    delete fields['简介']
    delete fields['说明']
    delete fields['描述']
    for (const key of Object.keys(fields)) {
      if (/^(创建|新建|添加|生成|建立)/.test(key)) delete fields[key]
    }
    const completed = completeLocalCreateFields(rule.type, fields)
    const operation: AgentOperation = {
      action: 'create_resource',
      resourceType: rule.type,
      title,
      summary: summaryMatch?.[1]?.trim(),
      fields: completed.fields,
      ...(completed.includeAllFields === true ? { includeAllFields: true } : {}),
    }
    return { message: `已准备创建${rule.label}“${title}”。`, operations: [operation] }
  }

  return { message: '当前本地 Agent 支持创建角色、道具、技能、世界书条目、大纲、世界引擎事件、文风规则，以及追加当前章节正文；也支持按名称更新资料和管理折叠栏。', operations: [] }
}

