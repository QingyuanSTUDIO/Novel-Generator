import { agentResourceFieldCatalog, agentResourceTemplateFields, canonicalAgentResourceField } from './resourceFieldPolicy.ts'
import type { AgentResourceType } from './schema'

export type StandardResourceType = Extract<AgentResourceType, 'world' | 'character' | 'item' | 'skill'>
export type StandardResourcePromptHints = Record<StandardResourceType, Record<string, string>>
export type StandardCreationPromptHints = StandardResourcePromptHints

const types = ['world', 'character', 'item', 'skill'] as const satisfies readonly StandardResourceType[]
const aliases: Record<string, string> = {
  title: '名称',
  name: '名称',
  summary: '摘要',
  description: '摘要',
}

const fields = (type: StandardResourceType) => [...new Set(['名称', '摘要', ...agentResourceTemplateFields[type]])]

const canonical = (type: StandardResourceType, field: string) => {
  const trimmed = field.trim()
  return aliases[trimmed] ?? aliases[trimmed.toLowerCase()] ?? canonicalAgentResourceField(type, trimmed)
}

/**
 * Default author guidance for the four built-in card types. These are schema
 * instructions for create_resource, rather than facts that belong to cards.
 */
const defaultHintsByType: Record<StandardResourceType, Record<string, string>> = {
  world: {
    名称: '使用作品内稳定、明确的设定名称；不要把“世界书条目”等类型说明写进名称。',
    摘要: '用一两句话概括设定的核心内容和剧情作用；只写已确认事实，不把推测当成定论。',
    触发策略: '只能填写“常驻”或“关键词”；默认使用“关键词”，只有作者明确要求每次注入时才使用“常驻”。',
    触发键: '填写正文、章节任务或相关条目中可能自然出现的短词，使用中文逗号分隔；不要把整段说明写进触发键。',
    内容: '写可以直接注入上下文的客观规则、地点、背景或世界事实；明确边界，区分已确认内容和未知内容。',
    适用范围: '说明这条设定在哪些地点、章节、场景或叙事条件下生效；没有限制时留空。',
    状态: '填写当前已确认状态，例如生效、暂未确认或已改变；保持简短，不新增剧情事实。',
  },
  character: {
    名称: '使用角色在作品中的稳定称呼；不要把身份、状态或形容词拼进名称。',
    摘要: '用一两句话概括角色的核心身份、当前剧情作用和最重要的矛盾；只写已确认内容。',
    触发策略: '只能填写“常驻”或“关键词”；默认使用“关键词”，没有明确要求时不要让角色每次都注入。',
    触发键: '填写角色名、别名、称号和自然相关词，使用中文逗号分隔；没有自定义触发键时，系统默认使用角色名称。',
    角色身份: '只能填写“主角”“配角”或“路人”；关系和行动重点只为主角、配角记录，路人保持简洁。',
    性别: '填写作品中已经确定的性别；未知时留空，不要根据名字或刻板印象猜测。',
    种族: '填写已确认的种族、族群或物种；未知时留空，不要为了完整而编造。',
    性格: '概括稳定的性格倾向和行为模式，优先使用可观察的选择与反应，避免只堆空泛褒贬词。',
    外貌: '填写稳定、可观察的外貌特征；不要把临时伤势、服装变化或当前状态混入外貌。',
    人物动机: '填写角色当前已确认的目标、欲望和行动原因；不要替角色预言尚未发生的行动。',
    当前状态: '记录当前时间点的地点、身体或心理状态、持有物及正在进行的事情；只写已确认事实。',
    已知信息: '只列出角色已经知道并可以据此行动的信息；不要把作者知道但角色未知的内容放进来。',
    尚未知晓: '列出作者确认但角色当前不知道的关键事实，用于控制信息揭露；正文中不能因此提前泄露。',
    说话习惯: '描述稳定的语气、措辞、句式或口头禅，用于保持角色声音；不要要求每句台词机械重复。',
  },
  item: {
    名称: '使用作品内稳定、可区分的道具名称；不要把持有人或用途写进名称。',
    摘要: '简要概括道具的外观辨识点、核心用途和当前剧情作用；只写已确认事实。',
    触发策略: '只能填写“常驻”或“关键词”；默认使用“关键词”，只有明确需要持续提醒时才使用“常驻”。',
    触发键: '填写道具名称、别名、编号或正文中自然出现的相关词，使用中文逗号分隔；留空时不要凭空扩展关键词。',
    用途: '说明道具能完成的动作、剧情功能以及不能替代的功能；不要凭空增加能力或效果。',
    当前持有人: '填写当前已确认持有者的角色名称；无人持有或尚未确认时留空。',
    当前位置: '填写当前已确认的地点、存放处或携带状态；与持有人变化保持一致。',
    使用限制: '写已确认的条件、代价、冷却、风险或不能做到的事情；没有限制时留空。',
    关联线索: '只记录已经建立的角色、事件、大纲或正文关联；不要把待推测的联系写成事实。',
  },
  skill: {
    名称: '使用作品内稳定、明确的技能名称；不要把主动/被动等性质写进名称。',
    摘要: '用一两句话概括技能的核心能力和剧情作用；只写已确认效果，不把潜在升级当成现状。',
    触发策略: '只能填写“常驻”或“关键词”；默认使用“关键词”，除非作者明确要求每次注入。',
    触发键: '填写技能名称、别名或自然相关词，使用中文逗号分隔；没有自定义触发键时使用技能名称。',
    技能性质: '只能填写“主动”或“被动”；主动技能需要角色主动使用，被动技能才可作为持续生效能力描述。',
    技能效果: '描述触发条件、具体效果、作用范围和可观察表现；区分确定效果与推测，不夸大能力边界。',
    关联线索: '只记录技能与角色、道具、事件或大纲中已经建立的关联；未知联系留空。',
  },
}

export function createEmptyStandardResourcePromptHints(): StandardResourcePromptHints {
  return Object.fromEntries(
    types.map((type) => [type, Object.fromEntries(fields(type).map((field) => [field, '']))]),
  ) as StandardResourcePromptHints
}

export function createDefaultStandardResourcePromptHints(): StandardResourcePromptHints {
  const result = createEmptyStandardResourcePromptHints()
  for (const type of types) {
    for (const [field, hint] of Object.entries(defaultHintsByType[type])) {
      if (Object.prototype.hasOwnProperty.call(result[type], field)) result[type][field] = hint
    }
  }
  return result
}

export const emptyStandardCreationPromptHints = createEmptyStandardResourcePromptHints
export const defaultStandardCreationPromptHints = createDefaultStandardResourcePromptHints

export function normalizeStandardResourcePromptHints(value: unknown): StandardResourcePromptHints {
  const result = createEmptyStandardResourcePromptHints()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const type of types) {
    const source = (value as Record<string, unknown>)[type]
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    const allowed = new Set(fields(type))
    for (const [field, hint] of Object.entries(source)) {
      if (typeof hint !== 'string') continue
      const normalizedField = canonical(type, field)
      if (allowed.has(normalizedField)) result[type][normalizedField] = hint.trim()
    }
  }
  return result
}

export const normalizeStandardCreationPromptHints = normalizeStandardResourcePromptHints

export function buildStandardResourceCreationHintPayload(value: unknown): StandardResourcePromptHints {
  return normalizeStandardResourcePromptHints(value)
}

export function buildCreationStructurePreview(type: StandardResourceType, hints: Record<string, string> = {}) {
  const normalized = normalizeStandardResourcePromptHints({ [type]: hints })[type]
  return {
    action: 'create_resource',
    resourceType: type,
    title: '',
    summary: '',
    fields: Object.fromEntries(agentResourceTemplateFields[type].map((field) => [field, ''])),
    fieldHints: normalized,
  }
}
