import type { ContextBlock, ContextCollection, ContextGroup, ContextItem, CustomModuleEntry, CustomModuleSchema, Resource, Store } from '../types.ts'
import type { StandardResourceType } from '../agent/resourceStructure.ts'
import { normalizeResourceTriggers } from '../context/retrieval.ts'
import { createDefaultWorldEngineState, migrateWorldEngineState } from './worldEngine.ts'
import { normalizeResourceReviewMetadata } from './resourceReviewMetadata.ts'
import { createDefaultCustomModuleStore, normalizeCustomModuleStore } from './customModules.ts'
import { createDefaultMemeStore, normalizeMemeStore } from './memes.ts'
import { defaultModelSettings } from '../api/modelSettings.ts'
import { estimateTextTokens } from '../api/contextBudget.ts'


export const storageKey = 'novel-generator-mvp'

const workResourceCollections = ['world', 'characters', 'items', 'skills', 'outline', 'style'] as const

const defaultContextItems = (collection: ContextCollection, title: string, source = title, tokens = 0): ContextItem[] => ([
  { id: `ctx-${collection}-entries`, title, source, role: collection === 'chapter' || collection === 'recent' || collection === 'output' ? 'user' : 'system', tokens, enabled: true, collection },
])

/**
 * The initial two-level prompt layout. The legacy `contextBlocks` below is
 * kept as a flat compatibility view for older callers and snapshots.
 */
export const defaultContextGroups: ContextGroup[] = [
  { id: 'ctx-system', title: '系统约束', source: '固定提示块', role: 'system', tokens: 180, enabled: true, collection: 'system', collapsed: true, items: defaultContextItems('system', '系统提示', '固定提示块', 180) },
  { id: 'ctx-world', title: '世界书', source: '世界书条目', role: 'system', tokens: 320, enabled: true, collection: 'world', collapsed: true, items: defaultContextItems('world', '世界书条目', '世界书', 320) },
  { id: 'ctx-characters', title: '角色卡', source: '角色卡条目', role: 'system', tokens: 420, enabled: true, collection: 'characters', collapsed: true, items: defaultContextItems('characters', '角色条目', '角色卡', 420) },
  { id: 'ctx-items', title: '道具卡', source: '道具卡条目', role: 'system', tokens: 220, enabled: true, collection: 'items', collapsed: true, items: defaultContextItems('items', '道具条目', '道具卡', 220) },
  { id: 'ctx-skills', title: '技能卡', source: '技能卡条目', role: 'system', tokens: 220, enabled: true, collection: 'skills', collapsed: true, items: defaultContextItems('skills', '技能条目', '技能卡', 220) },
  { id: 'ctx-style', title: '文风规则', source: '文风方案', role: 'system', tokens: 260, enabled: true, collection: 'style', collapsed: true, items: defaultContextItems('style', '启用的文风规则', '文风规则', 260) },
  { id: 'ctx-custom', title: '自定义模块', source: '实验性自定义数据结构', role: 'system', tokens: 0, enabled: true, collection: 'custom', collapsed: true, items: [] },
  { id: 'ctx-engine', title: '世界引擎', source: '已确认世界状态', role: 'system', tokens: 360, enabled: true, collection: 'worldEngine', collapsed: true, items: defaultContextItems('worldEngine', '已确认世界状态', '世界引擎', 360) },
  { id: 'ctx-task', title: '大纲 / 本章任务', source: '故事大纲与当前章节', role: 'user', tokens: 420, enabled: true, collection: 'chapter', collapsed: true, items: defaultContextItems('chapter', '章节任务', '本章大纲', 420) },
  { id: 'ctx-recent', title: '前章摘要与近期正文', source: '已定稿章节', role: 'user', tokens: 860, enabled: true, collection: 'recent', collapsed: true, items: defaultContextItems('recent', '前章摘要与正文', '近期正文', 860) },
  { id: 'ctx-output', title: '输出要求', source: '固定提示块', role: 'user', tokens: 120, enabled: true, collection: 'output', collapsed: true, items: defaultContextItems('output', '输出要求', '固定提示块', 120) },
]

// Keep a flat compatibility projection for pre-v8 snapshots without carrying
// the old design-time "本章资料 outlet" placeholder into new projects.
const legacyContextBlocks: ContextBlock[] = defaultContextGroups.map(({ items, ...group }) => ({
  ...group,
  items: structuredClone(items),
}))

export const seed: Store = {
  schemaVersion: 10,
  volumes: [
    { id: 'volume-1', title: '第一卷 · 失踪船', collapsed: false },
  ],
  chapters: [
    { id: 'ch-6', title: '06 伪造的船票', status: '已定稿', content: '沈砚在雨后的码头找到一张不属于这个年代的船票。', wordCount: 26, volumeId: 'volume-1' },
    { id: 'ch-7', title: '07 钥匙的去向', status: '已定稿', content: '他把铜钥匙推到林舟手边，等对方收进衣袋。', wordCount: 24, volumeId: 'volume-1' },
    { id: 'ch-8', title: '08 潮声里的回信', status: '草稿', content: `第三声钟还没有响。

沈砚站在栈桥尽头，把船票翻到背面。纸角被雨水泡软了，那串日期却比正面的蓝章更清楚。

“这一天，没有船出港。”林舟说。

沈砚抬起头。远处的闸门正在落下，铁链绷直，水面挤出一条白线。

他记得这个日期。兄长修好的最后一只怀表，后盖上也刻着它。`, wordCount: 112, volumeId: 'volume-1', taskGoal: '追查伪造船票，发现日期与兄长留下的怀表有关。', cast: ['沈砚', '林舟'] },
    { id: 'ch-9', title: '09 怀表的主人', status: '已规划', content: '', wordCount: 0, volumeId: 'volume-1' },
  ],
  world: [
    { id: 'world-curfew', title: '雾港宵禁', tag: '硬设定 · P70', summary: '钟楼三响后，内港禁止船只出入。', fields: { '触发策略': '关键词', '触发键': '雾港, 水闸, 夜航', '内容': '钟楼第三次报时后，水闸关闭，巡夜人会检查所有栈桥。', '过滤条件': '雾港 AND (夜航 OR 水闸)', '注入位置': '章节约束区 · 顺序 70', '预算 / 强度': '约 96 tokens · 硬设定', '递归': '不可递归；直接命中优先于背景条目' } },
    { id: 'world-tower', title: '旧钟楼', tag: '递归候选 · P30', summary: '废弃钟室里存放着二十年前的航海记录。', fields: { '触发策略': '关键词', '触发键': '旧钟楼, 钟室, 北港钟楼', '内容': '废弃钟室里存放着二十年前的航海记录，暗格入口藏在停摆的主钟后方。', '作者秘密': '钟室暗格藏有失踪船的航海记录。', '读者揭露': '计划第 12 章；第 8 章不可直接说明。', '递归链': '雾港宵禁 → 旧钟楼 → 失踪船航海记录' } },
  ],
  characters: [
    { id: 'char-shen', title: '沈砚', tag: '主角 · 视角人物', summary: '寻找失踪兄长的修表匠，习惯先观察再追问。', fields: { '触发策略': '关键词', '角色身份': '主角', '性别': '男', '种族': '人类', '性格': '谨慎克制，习惯先观察再追问；面对亲人线索时容易执拗。', '外貌': '', '人物动机': '找到兄长；不愿为线索牵连无辜的人。', '当前状态': '雾港码头 · 左手受伤 · 持有一张伪造船票', '已知信息': '船票是假的；兄长失踪前曾去过钟楼。', '尚未知晓': '失踪船的真实航线、林舟的委托人。', '说话习惯': '追问具体细节，紧张时回答变短。' }, holdingItems: ['item-ticket'], holdingSkills: ['skill-tide'] },
    { id: 'char-lin', title: '林舟', tag: '配角', summary: '摆渡人，收到铜钥匙后答应去试钟楼的门。', fields: { '触发策略': '关键词', '角色身份': '配角', '性别': '男', '种族': '人类', '性格': '表面随和，内心戒备；涉及妹妹时会冒险。', '外貌': '', '人物动机': '还清旧债，保护留在港内的妹妹。', '当前状态': '东栈桥 · 持有铜钥匙 · 准备夜航', '对沈砚的态度': '愿意合作，但隐瞒了委托人的身份。', '已知信息': '铜钥匙可能打开钟楼侧门。' }, holdingItems: ['item-key'], holdingSkills: [] },
  ],
  items: [
    { id: 'item-key', title: '铜钥匙', tag: '林舟持有', summary: '柄部刻着潮汐纹，齿口有一道新锉痕。', fields: { '触发策略': '关键词', '用途': '可打开旧钟楼侧门；不能打开钟室暗格。', '当前持有人': '林舟', '当前位置': '林舟随身携带，东栈桥。', '转移记录': '第 7 章：沈砚 → 林舟', '正文证据': '“沈砚把钥匙推到林舟手边，等他收进衣袋。”', '关联线索': '钥匙上的锉痕' } },
    { id: 'item-ticket', title: '伪造船票', tag: '沈砚持有', summary: '纸张与真票相同，出票日期却早了十年。', fields: { '触发策略': '关键词', '当前持有人': '沈砚', '当前位置': '沈砚随身携带', '可见信息': '票号、异常日期、褪色的蓝章。', '使用限制': '不能用于合法登船。', '本章用途': '作为追问旧航线的线索。' } },
  ],
  skills: [
    { id: 'skill-tide', title: '潮汐感知', tag: '主动 · 侦察', summary: '短时间内感知附近水流、闸门和船只的异常变化。', fields: { '触发策略': '关键词', '技能性质': '主动', '技能效果': '集中注意力后，能辨认水面回声与潮汐方向，发现异常航迹。', '关联线索': '第 12 章可发现旧钟楼暗渠的回声来源。', '使用限制': '每次使用后需要休息；无法读取他人的记忆。' } },
    { id: 'skill-clockwork', title: '钟表直觉', tag: '被动 · 专长', summary: '通过齿轮磨损和走时误差判断钟表最近的使用情况。', fields: { '触发策略': '关键词', '技能性质': '被动', '技能效果': '接触钟表时自动注意到异常磨损、停摆时间和被人拆动过的痕迹。', '关联线索': '后续可由怀表的误差锁定最后一位持有人。', '使用限制': '只能判断物理痕迹，不能直接得出幕后真相。' } },
  ],
  outline: [
    { id: 'outline-book', title: '全书总纲 · 雾港来信', tag: '全书', summary: '沈砚从伪造船票追查失踪兄长，最终揭开旧航线与钟楼暗格的真相。', outlineType: 'book', fields: { '主线': '从失踪船票开始，逐步揭开雾港旧航线、钟楼暗格与兄长失踪的关联。', '最终落点': '主角确认真相，并决定是否让被掩盖的航海记录重见天日。' } },
    { id: 'outline-volume-1', title: '第一卷大纲 · 失踪船', tag: '卷', summary: '建立雾港、船票和主要人物关系，推进到钟楼线索。', outlineType: 'volume', outlineParentId: 'outline-book', fields: { '卷目标': '让沈砚从追查一张假船票，走到旧钟楼门前。', '卷结局': '确认怀表与失踪船日期相关。' } },
    { id: 'outline-range-6-8', title: '第 6—8 章 · 船票与日期', tag: '章节范围', summary: '从伪造船票推进到日期与怀表的对应关系。', outlineType: 'chapterRange', outlineParentId: 'outline-volume-1', outlineStartChapterId: 'ch-6', outlineEndChapterId: 'ch-8', fields: { '章节目标': '把“假船票”线索推进到“有人故意留下日期”。', '冲突': '摆渡人不愿谈起旧航线，沈砚必须交换有价值的信息。', '结尾状态': '沈砚决定去找怀表原主人；不揭露失踪船目的地。' } },
    { id: 'outline-8', title: '第 8 章场景 · 潮声里的回信', tag: '场景', summary: '沈砚在雾港码头确认船票日期与兄长怀表有关。', outlineType: 'scene', outlineParentId: 'outline-range-6-8', outlineStartChapterId: 'ch-8', outlineEndChapterId: 'ch-8', fields: { '章节目标': '把“假船票”线索推进到“有人故意留下日期”。', '视角 / 地点': '沈砚 · 雾港码头 · 宵禁前', '关键转折': '票上的日期对应兄长修过的一只怀表。' } },
    { id: 'outline-range-9', title: '第 9 章 · 怀表的主人', tag: '章节范围', summary: '带着日期找人，却遇到一个不该出现的证人。', outlineType: 'chapterRange', outlineParentId: 'outline-volume-1', outlineStartChapterId: 'ch-9', outlineEndChapterId: 'ch-9', fields: { '章节目标': '验证怀表与船票日期的关联。', '入场状态': '以第 8 章最终确认状态为准。', '场景': '抵达修表铺，确认旧客户记录。' } },
  ],
  style: [
    { id: 'style-action', title: '用动作承载情绪', tag: '尽量遵守', summary: '减少抽象总结，保留必要的心理描写。', enabled: true, fields: { '规则': '优先通过动作、选择和对话体现情绪，不把感受都总结出来。', '反例': '一股复杂的情绪涌上心头。', '正例': '他把写好的地址划掉，又问了一遍末班船的时间。' } },
    { id: 'style-pov', title: '保持限知视角', tag: '必须遵守', summary: '不越过视角人物的信息边界解释真相。', enabled: true, fields: { '视角': '第三人称限知，当前视角人物：沈砚。', '约束': '不能直接叙述其他角色未表现出来的内心活动。', '允许': '描写可见动作、听到的对话和标明不确定性的推测。', '润色边界': '保留剧情事实、信息揭露时机与人物立场。' } },
  ],
  providers: [
    { id: 'provider-main', title: '主要写作接口', tag: 'OpenAI Compatible · 未测试', summary: 'OpenAI 兼容协议 · 获取模型后从下拉栏选择。', enabled: true, fields: { '协议': 'OpenAI Compatible', '接口地址': 'https://api.openai.com/v1', '模型': '', 'API Key': '', '上下文长度': String(defaultModelSettings.contextTokens), '流式输出': 'true', '使用代理': 'false', '代理地址': '127.0.0.1', '代理端口': '7890', '状态': '未测试' } },
  ],
  modelOptions: {},
  contextBlocks: legacyContextBlocks,
  contextGroups: structuredClone(defaultContextGroups),
  resourceGroups: { world: [], characters: [], items: [], skills: [], style: [] },
  worldEngine: createDefaultWorldEngineState(),
  customModules: createDefaultCustomModuleStore(),
  memes: createDefaultMemeStore(),
}

const contextCollectionValues: ContextCollection[] = ['system', 'world', 'characters', 'items', 'skills', 'style', 'outline', 'worldEngine', 'chapter', 'recent', 'output', 'custom']

function isContextCollection(value: unknown): value is ContextCollection {
  return typeof value === 'string' && contextCollectionValues.includes(value as ContextCollection)
}

function inferredContextCollection(block: Partial<ContextGroup>): ContextCollection {
  if (isContextCollection(block.collection)) return block.collection
  const value = `${block.id ?? ''} ${block.title ?? ''} ${block.source ?? ''}`.toLocaleLowerCase()
  if (value.includes('世界引擎') || value.includes('engine')) return 'worldEngine'
  if (value.includes('世界书') || value.includes('world')) return 'world'
  if (value.includes('角色') || value.includes('character')) return 'characters'
  if (value.includes('道具') || value.includes('item')) return 'items'
  if (value.includes('技能') || value.includes('skill')) return 'skills'
  if (value.includes('文风') || value.includes('style')) return 'style'
  if (value.includes('任务') || value.includes('大纲') || value.includes('task')) return 'chapter'
  if (value.includes('近期') || value.includes('正文') || value.includes('recent')) return 'recent'
  if (value.includes('输出') || value.includes('output')) return 'output'
  if (value.includes('系统') || value.includes('system')) return 'system'
  return 'custom'
}

function normalizeContextItem(item: Partial<ContextItem>, fallback: ContextItem): ContextItem {
  const resourceIds = Array.isArray(item.resourceIds)
    ? item.resourceIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : undefined
  return {
    ...fallback,
    ...item,
    id: typeof item.id === 'string' && item.id.trim() ? item.id : fallback.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : fallback.title,
    source: typeof item.source === 'string' ? item.source : fallback.source,
    role: item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : 'system',
    tokens: Number.isFinite(Number(item.tokens)) ? Math.max(0, Number(item.tokens)) : fallback.tokens,
    enabled: item.enabled !== false,
    collection: isContextCollection(item.collection) ? item.collection : fallback.collection,
    resourceId: typeof item.resourceId === 'string' && item.resourceId.trim() ? item.resourceId : undefined,
    resourceIds,
    customModuleId: typeof item.customModuleId === 'string' && item.customModuleId.trim() ? item.customModuleId : undefined,
    tag: typeof item.tag === 'string' ? item.tag : fallback.tag,
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : undefined,
  }
}

/**
 * Upgrade old flat context blocks to the two-level layout. The function is
 * intentionally tolerant because snapshots created before schema v8 may have
 * missing fields or hand-edited entries.
 */
export function normalizeContextGroups(input: unknown, legacyBlocks: ContextBlock[] = []): ContextGroup[] {
  if (Array.isArray(input) && input.length) {
    const normalized = input.filter((group): group is Record<string, unknown> => Boolean(group && typeof group === 'object')).map((raw, index) => {
      const group = raw as Partial<ContextGroup>
      const fallbackCollection = inferredContextCollection(group)
      const fallbackItem: ContextItem = {
        id: `${typeof group.id === 'string' && group.id ? group.id : `context-group-${index + 1}`}-entries`,
        title: typeof group.title === 'string' && group.title ? group.title : '未命名提示块',
        source: typeof group.source === 'string' ? group.source : '自定义提示块',
        role: group.role === 'user' ? 'user' : group.role === 'assistant' ? 'assistant' : 'system',
        tokens: Number.isFinite(Number(group.tokens)) ? Math.max(0, Number(group.tokens)) : 0,
        enabled: true,
        collection: fallbackCollection,
      }
      const items = Array.isArray(group.items)
        ? group.items.map((item: ContextItem) => normalizeContextItem(item as Partial<ContextItem>, fallbackItem))
        : [fallbackItem]
      return {
        id: typeof group.id === 'string' && group.id.trim() ? group.id : `context-group-${index + 1}`,
        title: typeof group.title === 'string' && group.title.trim() ? group.title : fallbackItem.title,
        source: typeof group.source === 'string' ? group.source : fallbackItem.source,
        role: group.role === 'user' ? 'user' : group.role === 'assistant' ? 'assistant' : 'system',
        tokens: Number.isFinite(Number(group.tokens)) ? Math.max(0, Number(group.tokens)) : items.reduce((sum, item) => sum + item.tokens, 0),
        enabled: group.enabled !== false,
        collection: fallbackCollection,
        order: Number.isFinite(Number(group.order)) ? Number(group.order) : index,
        collapsed: group.collapsed !== false,
        items,
      }
    }).filter((group) => group.id !== 'ctx-lore')
    if (!normalized.length) return structuredClone(defaultContextGroups)
    if (!normalized.some((group) => group.collection === 'custom')) {
      const customGroup = defaultContextGroups.find((group) => group.collection === 'custom')
      if (customGroup) {
        normalized.push({
          ...structuredClone(customGroup),
          collection: 'custom',
          order: normalized.length,
          collapsed: customGroup.collapsed !== false,
          items: structuredClone(customGroup.items),
        })
      }
    }
    return normalized
  }

  const blocks = Array.isArray(legacyBlocks) ? legacyBlocks : []
  if (!blocks.length) return structuredClone(defaultContextGroups)
  const migrated = blocks.filter((block) => block.id !== 'ctx-lore').map((block, index) => {
    const collection = inferredContextCollection(block)
    const fallback: ContextItem = { id: `${block.id}-entries`, title: block.title, source: block.source, role: block.role, tokens: block.tokens, enabled: block.enabled !== false, collection }
    const items = Array.isArray(block.items) && block.items.length
      ? block.items.map((item) => normalizeContextItem(item, fallback))
      : [fallback]
    return { ...block, collection, order: index, collapsed: block.collapsed !== false, items }
  })
  // Older layouts had one combined "本章资料" block. Add missing major
  // resource groups so cards can be ordered individually after migration.
  const existingCollections = new Set(migrated.map((group) => group.collection))
  const missingGroups = defaultContextGroups
    .filter((group) => {
      const collection = group.collection
      return Boolean(collection && ['world', 'characters', 'items', 'skills', 'custom'].includes(collection) && !existingCollections.has(collection))
    })
    .map((group, index) => ({ ...structuredClone(group), order: migrated.length + index }))
  return [...migrated, ...missingGroups]
}

/** Return the normalized prompt layout and ensure it exists on old stores. */
export function ensureContextLayout(store: Pick<Store, 'contextBlocks' | 'contextGroups'>): ContextGroup[] {
  if (Array.isArray(store.contextGroups) && store.contextGroups.length) return store.contextGroups
  const groups = normalizeContextGroups(store.contextGroups, store.contextBlocks)
  store.contextGroups = groups
  return groups
}

const contextLayoutResourceCollections = ['world', 'characters', 'items', 'skills', 'style'] as const

function contextValueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Estimate the prompt footprint of a resource from its current content.
 * This intentionally ignores a persisted ContextItem.tokens value: that value
 * is only a compatibility/display field and must never become stale after a
 * card edit. The same text shape is used by retrieval formatting (title,
 * summary and labelled fields), with tags included as prompt metadata.
 */
export function estimateContextResourceTokens(resource: Resource): number {
  const text = [
    resource.title,
    resource.tag,
    resource.summary,
    ...Object.entries(resource.fields ?? {}).map(([key, value]) => `${key}: ${contextValueText(value)}`),
  ].filter(Boolean).join('\n')
  return Math.max(16, estimateTextTokens(text))
}

/** Estimate a custom-module block from its live schema and entry data. */
export function estimateContextCustomModuleTokens(schema: CustomModuleSchema, entries: CustomModuleEntry[]): number {
  const schemaText = [
    schema.title,
    schema.description,
    // Field promptHint is creation-only guidance. It is exposed through the
    // Agent creation contract, so it must not inflate the runtime context
    // estimate for an already stored custom-module schema.
    ...schema.fields.map((field) => `${field.label || field.key}: ${field.description || ''}`),
  ].filter(Boolean)
  const entryText = entries.map((entry) => [
    entry.title,
    ...Object.entries(entry.data ?? {}).map(([key, value]) => `${key}: ${contextValueText(value)}`),
  ].filter(Boolean).join('\n'))
  return Math.max(16, estimateTextTokens([...schemaText, ...entryText].join('\n')))
}

/**
 * Return the currently enabled prompt footprint for a two-level context
 * layout. Persisted aggregate tokens are intentionally ignored here: they are
 * a compatibility/display field and can be stale after a card edit or after
 * its child items are disabled.
 */
export function estimateEnabledContextTokens(groups: Pick<ContextGroup, 'enabled' | 'items'>[]): number {
  return groups.reduce((sum, group) => {
    if (group.enabled === false) return sum
    return sum + (group.items ?? []).reduce((itemSum, item) => (
      item.enabled === false ? itemSum : itemSum + Math.max(0, Number(item.tokens) || 0)
    ), 0)
  }, 0)
}

/** Keep the second level tied to the current cards while preserving its order and switches. */
export function syncContextResourceItems(store: Store): ContextGroup[] {
  let groups = ensureContextLayout(store)
  const withoutLegacyOutlet = groups.filter((group) => group.id !== 'ctx-lore')
  if (withoutLegacyOutlet.length !== groups.length) {
    groups = withoutLegacyOutlet
    store.contextGroups = groups
  }
  const resourcesById = new Map<string, { resource: Resource; collection: typeof contextLayoutResourceCollections[number] }>()
  for (const collection of contextLayoutResourceCollections) {
    for (const resource of store[collection]) resourcesById.set(resource.id, { resource, collection })
  }
  const customSchemas = store.customModules?.schemas ?? []
  const customSchemaById = new Map(customSchemas.map((schema) => [schema.id, schema]))
  let customGroup = groups.find((group) => group.collection === 'custom')
  if (!customGroup && customSchemas.length) {
    const template = defaultContextGroups.find((group) => group.collection === 'custom')
    if (template) {
      customGroup = {
        ...structuredClone(template),
        id: groups.some((group) => group.id === template.id) ? `${template.id}-modules` : template.id,
        order: groups.length,
        items: [],
      }
      groups.push(customGroup)
      store.contextGroups = groups
    }
  }
  const customItemByModuleId = new Map<string, ContextItem>()

  // A custom-module item is only meaningful inside the custom-module block.
  // Older layouts (and an unrestricted drag operation) could leave one in a
  // world/character/item/skill block. Prefer the copy already in the canonical
  // custom block, then use the first stray copy so its enabled/order settings
  // are not lost when it is repaired.
  for (const group of groups) {
    for (const item of group.items ?? []) {
      if (!item.customModuleId || !customSchemaById.has(item.customModuleId)) continue
      const current = customItemByModuleId.get(item.customModuleId)
      if (!current || group === customGroup) {
        customItemByModuleId.set(item.customModuleId, item)
      }
    }
  }
  const ownerByResourceId = new Map<string, string>()
  for (const group of groups) {
    for (const item of group.items ?? []) {
      // A custom module must never claim ownership in a standard resource
      // block, even if a stale item also carries a resourceId.
      if (item.customModuleId) continue
      const resourceId = item.resourceId ?? item.resourceIds?.[0]
      if (resourceId && resourcesById.has(resourceId) && !ownerByResourceId.has(resourceId)) ownerByResourceId.set(resourceId, group.id)
    }
  }
  for (const group of groups) {
    const collection = group.collection
    if (!collectionResourceCollection(collection)) {
      group.items = (group.items ?? []).flatMap((item) => {
        // Custom-module items are rebuilt in the canonical custom block below.
        // Drop them from every other kind of block, including stale duplicate
        // custom blocks, so they cannot appear in world-book context.
        if (item.customModuleId) return []
        const resourceId = item.resourceId ?? item.resourceIds?.[0]
        const record = resourceId ? resourcesById.get(resourceId) : undefined
        if (resourceId && !record) return []
        return record
          ? [{
              ...item,
              title: record.resource.title,
              source: record.resource.tag || item.source,
              tag: record.resource.tag,
              tokens: estimateContextResourceTokens(record.resource),
            }]
          : [item]
      })
      continue
    }
    const resources = store[collection]
    const current = group.items ?? []
    const currentByResourceId = new Map<string, ContextItem>()
    for (const item of current) {
      const resourceId = item.resourceId ?? item.resourceIds?.[0]
      if (resourceId) currentByResourceId.set(resourceId, item)
    }
    const buildItem = (resource: Resource, previous?: ContextItem): ContextItem => {
      return {
        id: previous?.id ?? `ctx-${collection}-${resource.id}`,
        title: resource.title,
        source: resource.tag || collection,
        role: group.role,
        tokens: estimateContextResourceTokens(resource),
        enabled: previous ? previous.enabled !== false : resource.enabled !== false,
        collection: resourcesById.get(resource.id)?.collection ?? collection,
        resourceId: resource.id,
        tag: resource.tag,
        order: previous?.order,
      }
    }
    const nextItems: ContextItem[] = []
    const seen = new Set<string>()
    for (const item of current) {
      // A custom-module item belongs to the custom block, regardless of where
      // an older drag operation placed it.
      if (item.customModuleId) continue
      const resourceId = item.resourceId ?? item.resourceIds?.[0]
      if (resourceId) {
        const record = resourcesById.get(resourceId)
        if (!record || seen.has(resourceId)) continue
        const owner = ownerByResourceId.get(resourceId)
        if (record.collection !== collection && owner !== group.id) continue
        if (record.collection === collection && owner && owner !== group.id) continue
        nextItems.push(buildItem(record.resource, item))
        seen.add(resourceId)
        continue
      }
      if (item.id !== `ctx-${collection}-entries`) nextItems.push(item)
    }
    // New cards are appended after the saved order. Cards already owned by a
    // different group stay there, which makes cross-group drag persistent.
    for (const resource of resources) {
      if (seen.has(resource.id)) continue
      const owner = ownerByResourceId.get(resource.id)
      if (owner && owner !== group.id) continue
      nextItems.push(buildItem(resource, currentByResourceId.get(resource.id)))
      seen.add(resource.id)
    }
    group.items = nextItems
    // Keep the aggregate live even when the last resource was removed. A
    // previous persisted group.tokens value must never survive an empty block.
    group.tokens = nextItems.reduce((sum, item) => sum + item.tokens, 0)
  }
  if (customGroup) {
    const current = customGroup.items ?? []
    const nextItems: ContextItem[] = []
    const seen = new Set<string>()
    for (const item of current) {
      const moduleId = item.customModuleId
      if (!moduleId) {
        if (!item.resourceId && !item.resourceIds?.length) nextItems.push(item)
        continue
      }
      const schema = customSchemaById.get(moduleId)
      if (!schema || seen.has(moduleId)) continue
      const canonicalItem = customItemByModuleId.get(moduleId) ?? item
      const entries = (store.customModules?.entries ?? []).filter((entry) => entry.schemaId === schema.id)
      nextItems.push({
        ...canonicalItem,
        id: canonicalItem.id || `ctx-custom-${moduleId}`,
        title: schema.title,
        source: schema.description || canonicalItem.source || '自定义模块',
        tokens: estimateContextCustomModuleTokens(schema, entries),
        collection: 'custom',
        customModuleId: moduleId,
      })
      seen.add(moduleId)
    }
    for (const schema of customSchemas) {
      if (seen.has(schema.id)) continue
      const canonicalItem = customItemByModuleId.get(schema.id)
      const entries = (store.customModules?.entries ?? []).filter((entry) => entry.schemaId === schema.id)
      const tokens = estimateContextCustomModuleTokens(schema, entries)
      nextItems.push({
        id: canonicalItem?.id || `ctx-custom-${schema.id}`,
        title: schema.title,
        source: schema.description || canonicalItem?.source || `自定义模块 · ${entries.length} 条数据`,
        role: customGroup.role,
        tokens,
        enabled: canonicalItem?.enabled !== false,
        collection: 'custom',
        customModuleId: schema.id,
        order: canonicalItem?.order,
      })
      seen.add(schema.id)
    }
    customGroup.items = nextItems
    customGroup.tokens = nextItems.reduce((sum, item) => sum + item.tokens, 0)
    customGroup.source = customSchemas.length ? `实验性自定义数据结构 · ${customSchemas.length} 个模块` : '实验性自定义数据结构'
  }
  // Keep the legacy flat projection synchronized with the live two-level
  // layout. This also removes stale design-time blocks from old snapshots
  // after their first normalization.
  store.contextBlocks = groups.map(({ items, ...group }) => ({
    ...group,
    // `store` is usually a Vue reactive proxy when this function is called
    // from the mounted app. structuredClone cannot clone that proxy, which
    // used to abort onMounted before desktop persistence hydration started.
    // Copy the shallow item records and their only nested array explicitly.
    items: items.map((item) => ({
      ...item,
      ...(item.resourceIds ? { resourceIds: [...item.resourceIds] } : {}),
    })),
  }))
  return groups
}

function collectionResourceCollection(value: ContextCollection | undefined): value is typeof contextLayoutResourceCollections[number] {
  return Boolean(value && contextLayoutResourceCollections.includes(value as typeof contextLayoutResourceCollections[number]))
}

/**
 * Build deterministic ranks for retrieved resources. A specific nested item
 * wins over its collection rank; unspecified resources retain their original
 * retrieval order after the configured groups.
 */
export function contextResourceOrder(store: Pick<Store, 'contextBlocks' | 'contextGroups'>): Map<string, number> {
  const groups = ensureContextLayout(store)
  const result = new Map<string, number>()
  groups.forEach((group, groupIndex) => {
    const groupRank = groupIndex * 100000
    if (group.collection) result.set(group.collection, groupRank)
    group.items.forEach((item, itemIndex) => {
      // A custom module is a separate prompt collection. Ignore stale
      // cross-group copies while calculating ranks; syncContextResourceItems
      // will move them back to the canonical custom block.
      if (item.customModuleId && group.collection !== 'custom') return
      const rank = groupRank + itemIndex * 100
      const collection = item.collection ?? group.collection
      if (!collection) return
      result.set(collection, Math.min(result.get(collection) ?? Number.POSITIVE_INFINITY, rank))
      const resourceIds = [...(item.resourceIds ?? []), ...(item.resourceId ? [item.resourceId] : [])]
      resourceIds.forEach((id) => result.set(`${collection}:${id}`, rank))
      if (item.customModuleId) result.set(`${collection}:${item.customModuleId}`, rank)
    })
  })
  return result
}

const contextResourceCollections = ['world', 'characters', 'items', 'skills'] as const

function migrateResourceContextSettings(resource: any, resourceType: StandardResourceType): Resource {
  const fields = resource.fields && typeof resource.fields === 'object' ? resource.fields : {}
  if (fields['说明'] !== undefined && fields['内容'] === undefined) fields['内容'] = fields['说明']
  delete fields['说明']
  const legacyOrder = String(fields['注入位置'] ?? '').match(/(?:顺序|priority|p)\s*[:：]?\s*(\d+)/i)
  const tagOrder = String(resource.tag ?? '').match(/(?:p|priority)\s*(\d+)/i)
  const recursiveText = String(fields['递归'] ?? '')
  return normalizeResourceTriggers({
    ...resource,
    fields,
    retrieval: {
      ...(resource.retrieval && typeof resource.retrieval === 'object' ? resource.retrieval : {}),
    },
    allowRecursive: typeof resource.allowRecursive === 'boolean'
      ? resource.allowRecursive
      : Boolean(recursiveText) && !/(不可|禁止|不允许|否)/.test(recursiveText),
    allowFurtherRecursive: typeof resource.allowFurtherRecursive === 'boolean'
      ? resource.allowFurtherRecursive
      : /(进一步|继续|深度|多级)/.test(recursiveText) && !/(不可|禁止|不允许|否)/.test(recursiveText),
    injectionOrder: Number.isFinite(Number(resource.injectionOrder))
      ? Math.max(0, Number(resource.injectionOrder))
      : Number(legacyOrder?.[1] ?? tagOrder?.[1] ?? 100),
  })
}

export function normalizeOutlineHierarchy(store: Store): void {
  const chapters = Array.isArray(store.chapters) ? store.chapters : []
  const volumes = Array.isArray(store.volumes) ? store.volumes : []
  const validChapterIds = new Set(chapters.map((chapter) => chapter.id))
  const validVolumeIds = new Set(volumes.map((volume) => volume.id))
  const outline = Array.isArray(store.outline) ? store.outline : []
  const byId = new Map(outline.map((node) => [node.id, node]))
  let root = outline.find((node) => node.outlineType === 'book') ?? outline.find((node) => node.id === 'outline-book')
  if (!root && outline.length) {
    root = {
      id: 'outline-book',
      title: '全书总纲',
      tag: '全书',
      summary: '全书故事主线与最终落点。',
      fields: { '主线': '', '最终落点': '' },
      outlineType: 'book',
      creationSource: 'manual',
      reviewStatus: 'pending',
      lockedFields: [],
    }
    outline.unshift(root)
    byId.set(root.id, root)
  } else if (root && root.outlineType !== 'book') {
    root.outlineType = 'book'
    root.outlineParentId = undefined
  }
  if (!root && volumes.length) {
    root = {
      id: 'outline-book',
      title: '全书总纲',
      tag: '全书',
      summary: '全书故事主线与最终落点。',
      fields: { '主线': '', '最终落点': '' },
      outlineType: 'book',
      creationSource: 'manual',
      reviewStatus: 'pending',
      lockedFields: [],
    }
    outline.unshift(root)
    byId.set(root.id, root)
  }
  const defaultRootId = root?.id
  for (const volume of volumes) {
    const id = `outline-volume-${volume.id}`
    let volumeNode = outline.find((node) => node.id === id || (node.outlineType === 'volume' && node.outlineParentId === defaultRootId && node.title === volume.title))
    if (!volumeNode && defaultRootId) {
      volumeNode = {
        id,
        title: `${volume.title}大纲`,
        tag: '卷',
        summary: `围绕${volume.title}组织章节范围和场景。`,
        fields: { '卷目标': '', '卷结局': '' },
        outlineType: 'volume',
        outlineParentId: defaultRootId,
        creationSource: 'manual',
        reviewStatus: 'pending',
        lockedFields: [],
      }
      outline.push(volumeNode)
      byId.set(volumeNode.id, volumeNode)
    }
  }
  const firstVolume = outline.find((node) => node.outlineType === 'volume')
  for (const node of outline) {
    node.fields = { ...(node.fields ?? {}) }
    const nodeType = node.outlineType ?? 'chapterRange'
    node.outlineType = ['book', 'volume', 'chapterRange', 'scene'].includes(nodeType) ? nodeType : 'chapterRange'
    node.outlineCollapsed = node.outlineCollapsed === true
    if (node.outlineType === 'book') {
      node.outlineParentId = undefined
      continue
    }
    if (node.outlineParentId && (!byId.has(node.outlineParentId) || node.outlineParentId === node.id)) {
      node.outlineParentId = undefined
    }
    if (!node.outlineParentId && firstVolume && node !== firstVolume && node !== root) {
      node.outlineParentId = firstVolume.id
    }
    if (node.outlineStartChapterId && !validChapterIds.has(node.outlineStartChapterId)) node.outlineStartChapterId = undefined
    if (node.outlineEndChapterId && !validChapterIds.has(node.outlineEndChapterId)) node.outlineEndChapterId = undefined
  }
  // Break malformed cycles deterministically instead of allowing the tree to recurse forever.
  for (const node of outline) {
    const seen = new Set<string>()
    let cursor = node.outlineParentId
    while (cursor && !seen.has(cursor)) {
      if (cursor === node.id) {
        node.outlineParentId = undefined
        break
      }
      seen.add(cursor)
      cursor = byId.get(cursor)?.outlineParentId
    }
  }
  // Keep older snapshots useful even if their volumes were deleted.
  for (const node of outline) {
    if (node.outlineType === 'volume' && node.id.startsWith('outline-volume-')) {
      const volumeId = node.id.slice('outline-volume-'.length)
      if (!validVolumeIds.has(volumeId)) node.outlineParentId = defaultRootId
    }
  }
  store.outline = outline
}

function migrateStoreResourceContextSettings(store: Store): Store {
  const resourceTypes = { world: 'world', characters: 'character', items: 'item', skills: 'skill' } as const
  for (const collection of contextResourceCollections) {
    store[collection] = (store[collection] ?? []).map((resource) => migrateResourceContextSettings(resource, resourceTypes[collection]))
  }
  store.characters = (store.characters ?? []).map((character) => {
    const fields = { ...(character.fields ?? {}) }
    const gender = fields['性别'] ?? ''
    const race = fields['种族'] ?? ''
    const personality = fields['性格'] ?? ''
    const appearance = fields['外貌'] ?? ''
    delete fields['性别']
    delete fields['种族']
    delete fields['性格']
    delete fields['外貌']
    const images = (Array.isArray(character.characterImages) ? character.characterImages : []).filter((image) => image
      && typeof image.id === 'string' && image.id.length > 0
      && typeof image.name === 'string'
      && typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/')
      && typeof image.createdAt === 'number')
    const requestedCoverId = character.characterCoverImageId ?? ''
    const coverImageId = images.some((image) => image.id === requestedCoverId) ? requestedCoverId : images[0]?.id ?? ''
    return {
      ...character,
      fields: { '性别': gender, '种族': race, '性格': personality, '外貌': appearance, ...fields },
      characterImages: images,
      characterCoverImageId: coverImageId,
    }
  })
  store.skills = (store.skills ?? []).map((skill) => {
    skill.fields = { ...(skill.fields ?? {}) }
    skill.fields['技能性质'] = skill.fields['技能性质'] === '被动' ? '被动' : '主动'
    return skill
  })
  store.style = (store.style ?? []).map((style) => {
    style.fields = { ...(style.fields ?? {}) }
    if (style.fields['反例'] === '填写反例') style.fields['反例'] = ''
    if (style.fields['正例'] === '填写正例') style.fields['正例'] = ''
    style.enabled = style.enabled !== false
    return style
  })
  for (const collection of workResourceCollections) {
    store[collection] = store[collection].map(normalizeResourceReviewMetadata)
  }
  store.worldEngine = migrateWorldEngineState(store.worldEngine, Date.now(), store.characters ?? [])
  store.customModules = normalizeCustomModuleStore(store.customModules ?? createDefaultCustomModuleStore())
  store.memes = normalizeMemeStore(store.memes ?? createDefaultMemeStore())
  normalizeOutlineHierarchy(store)
  syncContextResourceItems(store)
  return store
}

export function readStore(): Store {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return migrateStoreResourceContextSettings(structuredClone(seed))
    const saved = JSON.parse(raw) as Partial<Store>
    const merged = { ...structuredClone(seed), ...saved }
    // A pre-v8 snapshot has only the flat blocks. Derive groups from that
    // snapshot rather than silently replacing the author's saved order.
    merged.contextGroups = Array.isArray(saved.contextGroups)
      ? saved.contextGroups
      : normalizeContextGroups(undefined, Array.isArray(saved.contextBlocks) ? saved.contextBlocks : seed.contextBlocks)
    if ((saved.schemaVersion ?? 0) < 2) merged.modelOptions = {}
    const savedVolumes = Array.isArray(saved.volumes) ? saved.volumes : []
    const normalizedVolumes = savedVolumes
      .filter((volume) => Boolean(volume && typeof volume === 'object' && typeof volume.id === 'string'))
      .map((volume) => ({
        id: volume.id,
        title: volume.title?.trim() || '',
        collapsed: volume.collapsed === true,
      }))
    merged.volumes = normalizedVolumes.length ? normalizedVolumes : structuredClone(seed.volumes)
    const fallbackVolumeId = merged.volumes[0]?.id ?? seed.volumes[0].id
    if (!merged.volumes.length) merged.volumes = structuredClone(seed.volumes)
    merged.chapters = (merged.chapters ?? []).map((chapter, index) => ({
      ...chapter,
      volumeId: typeof chapter.volumeId === 'string' && merged.volumes.some((volume) => volume.id === chapter.volumeId)
        ? chapter.volumeId
        : fallbackVolumeId,
      id: typeof chapter.id === 'string' && chapter.id ? chapter.id : `chapter-${index + 1}`,
    }))
    const savedGroups = saved.resourceGroups ?? seed.resourceGroups
    merged.resourceGroups = {
      world: savedGroups.world ?? [],
      characters: savedGroups.characters ?? [],
      items: savedGroups.items ?? [],
      skills: savedGroups.skills ?? [],
      style: savedGroups.style ?? [],
    }
    merged.characters = (merged.characters ?? []).map((character) => {
      const seedCharacter = seed.characters.find((item) => item.id === character.id)
      character.fields = { ...(character.fields ?? {}) }
      if (character.fields['性别'] === undefined) character.fields['性别'] = seedCharacter?.fields['性别'] ?? ''
      if (character.fields['种族'] === undefined) character.fields['种族'] = seedCharacter?.fields['种族'] ?? ''
      if (character.fields['性格'] === undefined) character.fields['性格'] = seedCharacter?.fields['性格'] ?? ''
      if (!character.fields['角色身份']) {
        character.fields['角色身份'] = seedCharacter?.fields['角色身份'] ?? (character.tag.includes('主角') ? '主角' : character.tag.includes('路人') ? '路人' : '配角')
      }
      if (character.id === 'char-shen' && character.tag === '视角人物' && character.fields['角色身份'] === '配角') character.fields['角色身份'] = '主角'
      if (character.id === 'char-shen' && character.tag === '视角人物') character.tag = '主角 · 视角人物'
      if (!character.holdingItems && seedCharacter?.holdingItems) character.holdingItems = [...seedCharacter.holdingItems]
      if (!character.holdingSkills && seedCharacter?.holdingSkills) character.holdingSkills = [...seedCharacter.holdingSkills]
      return character
    })
    // API presets use a single persisted default. Older data did not have this
    // field, so promote the first preset once and keep any later selections
    // mutually exclusive.
    const providers = (merged.providers ?? []).map((provider) => ({
      ...provider,
      enabled: provider.enabled === true,
      fields: {
        ...(provider.fields ?? {}),
        // Streaming is opt-out so existing presets gain the new capability
        // without changing their endpoint, model or credential settings.
        '流式输出': provider.fields?.['流式输出'] === 'false' ? 'false' : 'true',
      },
    }))
    const enabledProvider = providers.find((provider) => provider.enabled)
    if (!enabledProvider && providers[0]) providers[0].enabled = true
    if (enabledProvider) {
      let seen = false
      for (const provider of providers) {
        if (!provider.enabled) continue
        if (seen) provider.enabled = false
        seen = true
      }
    }
    merged.providers = providers
    merged.style = (merged.style ?? []).map((style) => ({ ...style, enabled: style.enabled !== false }))
    merged.customModules = normalizeCustomModuleStore(merged.customModules ?? createDefaultCustomModuleStore())
    merged.memes = normalizeMemeStore(merged.memes ?? createDefaultMemeStore())
    merged.schemaVersion = 10
    return migrateStoreResourceContextSettings(merged)
  } catch {
    return migrateStoreResourceContextSettings(structuredClone(seed))
  }
}



