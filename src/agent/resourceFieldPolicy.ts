import type { AgentResourceType } from './schema'

/**
 * Fields that belong to the built-in card templates.
 *
 * Agent-created standard cards must stay inside these templates. A new
 * independent set of fields belongs in a custom module instead. Existing
 * fields on an older card remain editable during updates for compatibility.
 */
export const agentResourceFieldCatalog: Record<AgentResourceType, readonly string[]> = {
  world: [
    '触发策略',
    '触发键',
    '内容',
    '适用范围',
    '状态',
    // Legacy world-book metadata kept for existing works.
    '过滤条件',
    '注入位置',
    '预算 / 强度',
    '递归',
    '作者秘密',
    '读者揭露',
    '递归链',
    '本章资料',
  ],
  character: [
    '触发策略',
    '触发键',
    '角色身份',
    '性别',
    '种族',
    '性格',
    '外貌',
    '人物动机',
    '当前状态',
    '已知信息',
    '尚未知晓',
    '说话习惯',
    '对沈砚的态度',
  ],
  item: [
    '触发策略',
    '触发键',
    '用途',
    '当前持有人',
    '当前位置',
    '使用限制',
    '关联线索',
    '可见信息',
    '本章用途',
    '转移记录',
    '正文证据',
  ],
  skill: [
    '触发策略',
    '触发键',
    '技能性质',
    '技能效果',
    '关联线索',
    '使用限制',
  ],
  outline: [
    '主线',
    '最终落点',
    '章节目标',
    '卷目标',
    '卷结局',
    '场景',
    '冲突',
    '结尾状态',
    '视角 / 地点',
    '关键转折',
    '入场状态',
    '本章动作',
    '计划',
    '目标',
    '后果',
  ],
  world_event: [
    '类型',
    '摘要',
    '内容',
    '时间',
    '发生时间',
    '后果',
    '状态',
  ],
  style: [
    '规则',
    '反例',
    '正例',
    '内容',
    '视角',
    '约束',
    '允许',
    '润色边界',
    '适用范围',
  ],
}

/**
 * Full field contract shown to the model when it creates a standard card.
 * Keep this separate from the permissive compatibility catalog above: older
 * works may contain legacy fields, but new cards should be returned with the
 * complete current template so they are immediately useful in the editor.
 */
export const agentResourceTemplateFields: Record<AgentResourceType, readonly string[]> = {
  world: ['触发策略', '触发键', '内容', '适用范围', '状态'],
  character: ['触发策略', '触发键', '角色身份', '性别', '种族', '性格', '外貌', '人物动机', '当前状态', '已知信息', '尚未知晓', '说话习惯'],
  item: ['触发策略', '触发键', '用途', '当前持有人', '当前位置', '使用限制', '关联线索'],
  skill: ['触发策略', '触发键', '技能性质', '技能效果', '关联线索'],
  outline: ['主线', '最终落点', '章节目标', '卷目标', '卷结局', '场景', '冲突', '结尾状态', '视角 / 地点', '关键转折', '入场状态', '本章动作', '计划', '目标', '后果'],
  world_event: ['类型', '摘要', '内容', '时间', '发生时间', '后果', '状态'],
  style: ['规则', '反例', '正例', '内容', '视角', '约束', '允许', '润色边界', '适用范围'],
}

/**
 * The UI uses Chinese field labels, while a model will often return a
 * camelCase JSON shape even when the rest of the operation follows the
 * documented protocol. Keep this compatibility layer deliberately explicit:
 * an arbitrary English property must still be rejected as a new field.
 */
const commonAgentFieldAliases: Record<string, string> = {
  triggerStrategy: '触发策略',
  triggerMode: '触发策略',
  strategy: '触发策略',
  mode: '触发策略',
  triggerKeys: '触发键',
  triggerKey: '触发键',
  keywords: '触发键',
  keyword: '触发键',
  keys: '触发键',
  content: '内容',
  scope: '适用范围',
  status: '状态',
}

const agentFieldAliasesByResource: Partial<Record<AgentResourceType, Record<string, string>>> = {
  character: {
    identity: '角色身份',
    role: '角色身份',
    characterRole: '角色身份',
    gender: '性别',
    race: '种族',
    personality: '性格',
    appearance: '外貌',
    motivation: '人物动机',
    currentStatus: '当前状态',
    knownInformation: '已知信息',
    unknownInformation: '尚未知晓',
    speechPattern: '说话习惯',
    attitudeToShenYan: '对沈砚的态度',
  },
  item: {
    purpose: '用途',
    holder: '当前持有人',
    currentHolder: '当前持有人',
    location: '当前位置',
    currentLocation: '当前位置',
    usageLimit: '使用限制',
    relatedClues: '关联线索',
    visibleInformation: '可见信息',
    chapterPurpose: '本章用途',
    transferRecord: '转移记录',
    plotEvidence: '正文证据',
  },
  skill: {
    skillType: '技能性质',
    skillNature: '技能性质',
    effect: '技能效果',
    skillEffect: '技能效果',
    relatedClues: '关联线索',
    usageLimit: '使用限制',
  },
  outline: {
    mainline: '主线',
    finalDestination: '最终落点',
    chapterGoal: '章节目标',
    volumeGoal: '卷目标',
    volumeEnding: '卷结局',
    scene: '场景',
    conflict: '冲突',
    endingState: '结尾状态',
    viewpointLocation: '视角 / 地点',
    keyTurningPoint: '关键转折',
    entryState: '入场状态',
    chapterAction: '本章动作',
    plan: '计划',
    goal: '目标',
    consequence: '后果',
  },
  world_event: {
    type: '类型',
    summary: '摘要',
    time: '时间',
    occurredAt: '发生时间',
    consequence: '后果',
  },
  style: {
    rules: '规则',
    examples: '正例',
    positiveExample: '正例',
    negativeExample: '反例',
    viewpoint: '视角',
    constraints: '约束',
    allowed: '允许',
    polishBoundary: '润色边界',
  },
}

function aliasLookup(resourceType: AgentResourceType): Record<string, string> {
  const aliases = {
    ...commonAgentFieldAliases,
    ...(agentFieldAliasesByResource[resourceType] ?? {}),
  }
  return Object.entries(aliases).reduce<Record<string, string>>((lookup, [key, value]) => {
    lookup[key] = value
    lookup[key.toLocaleLowerCase()] = value
    return lookup
  }, {})
}

/**
 * Return the canonical Chinese field label for a model field name.
 * Unknown fields are returned unchanged so callers can report/reject them.
 */
export function canonicalAgentResourceField(resourceType: AgentResourceType, field: string): string {
  const trimmed = field.trim()
  if (!trimmed) return field
  const aliases = aliasLookup(resourceType)
  return aliases[trimmed] ?? aliases[trimmed.toLocaleLowerCase()] ?? trimmed
}

/**
 * Normalize the fields of one Agent operation while preserving unknown keys
 * for validation diagnostics. Explicit canonical labels win over aliases if a
 * model accidentally sends both versions of the same field.
 */
export function normalizeAgentResourceFields(
  resourceType: AgentResourceType,
  fields: Record<string, string> | undefined,
): Record<string, string> {
  if (!fields) return {}
  const entries = Object.entries(fields)
  const explicitCanonical = new Set(
    entries
      .map(([field]) => [field, canonicalAgentResourceField(resourceType, field)] as const)
      .filter(([field, canonical]) => field.trim() === canonical)
      .map(([, canonical]) => canonical),
  )
  const normalized: Record<string, string> = {}
  for (const [field, value] of entries) {
    const canonical = canonicalAgentResourceField(resourceType, field)
    if (canonical !== field.trim() && explicitCanonical.has(canonical)) continue
    if (!Object.prototype.hasOwnProperty.call(normalized, canonical)) normalized[canonical] = value
  }
  return normalized
}

export function isAgentResourceFieldAllowed(
  resourceType: AgentResourceType,
  field: string,
  existingFields?: Record<string, unknown>,
) {
  const canonical = canonicalAgentResourceField(resourceType, field)
  if (Object.prototype.hasOwnProperty.call(existingFields ?? {}, field)
    || Object.prototype.hasOwnProperty.call(existingFields ?? {}, canonical)) return true
  return agentResourceFieldCatalog[resourceType].includes(canonical)
}

export function unknownAgentResourceFields(
  resourceType: AgentResourceType,
  fields: Record<string, unknown> | undefined,
  existingFields?: Record<string, unknown>,
) {
  if (!fields) return []
  return Object.keys(fields).filter((field) => !isAgentResourceFieldAllowed(resourceType, field, existingFields))
}
