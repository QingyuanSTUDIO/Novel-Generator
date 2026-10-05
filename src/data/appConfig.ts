import {
  Bot,
  Blocks,
  Code2,
  Feather,
  Flame,
  Globe,
  KeyRound,
  LayoutList,
  ListTree,
  PenLine,
  Sparkles,
  Users,
} from 'lucide-vue-next'
import { agentResponseSchema } from '../agent/schema'
import type { Store } from '../types'

export type PageKey = 'writer' | 'world' | 'characters' | 'items' | 'skills' | 'outline' | 'worldEngine' | 'style' | 'context' | 'agent' | 'api' | 'json' | 'custom' | 'memes'

export const navItems = [
  { key: 'writer', label: '章节写作', icon: PenLine, section: '开始写作' },
  { key: 'world', label: '世界书', icon: Globe, section: '创作空间' },
  { key: 'characters', label: '角色卡', icon: Users, section: '创作空间' },
  { key: 'items', label: '道具卡', icon: KeyRound, section: '创作空间' },
  { key: 'skills', label: '技能卡', icon: Sparkles, section: '创作空间' },
  { key: 'custom', label: '自定义模块', icon: Blocks, section: '创作空间' },
  { key: 'memes', label: '网络热梗', icon: Flame, section: '创作空间' },
  { key: 'outline', label: '故事大纲', icon: ListTree, section: '全局把握' },
  { key: 'worldEngine', label: '世界引擎', icon: Globe, section: '全局把握' },
  { key: 'agent', label: 'AI Agent', icon: Bot, section: 'AI功能' },
  { key: 'style', label: '文风规则', icon: Feather, section: '全局功能' },
  { key: 'context', label: '上下文编排', icon: LayoutList, section: 'Debug' },
  { key: 'json', label: 'JSON 结构查看器', icon: Code2, section: 'Debug' },
] as const

export const pageConfig: Record<Exclude<PageKey, 'writer' | 'context' | 'agent' | 'json' | 'custom' | 'memes'>, { collection: keyof Store; title: string; intro: string }> = {
  world: { collection: 'world', title: '世界书', intro: '动态条目按触发键、关联和优先级注入本章上下文。' },
  characters: { collection: 'characters', title: '角色卡', intro: '固定档案与随章节变化的状态分开维护。' },
  items: { collection: 'items', title: '道具卡', intro: '让持有人、位置和使用限制有据可查。' },
  skills: { collection: 'skills', title: '技能卡', intro: '维护角色能力、触发效果和与世界引擎线索的关联。' },
  outline: { collection: 'outline', title: '故事大纲', intro: '全书 → 卷 → 章 → 场景；计划与事实分开。' },
  worldEngine: { collection: 'worldEngine', title: '世界引擎', intro: '读取大纲、正文、角色卡与已确认状态，生成可审阅的后台世界变化。大纲通过智能检索提供给引擎。' },
  style: { collection: 'style', title: '文风规则', intro: '作为写作模式的底层提示词，正文和 Agent 创作资料都会遵循启用规则。' },
  api: { collection: 'providers', title: 'API 管理', intro: '连接配置全局复用，模型请求经本机代理转发。' },
}

/** Read-only examples of the JSON contracts used when assembling AI prompts. */
export const jsonStructures = [
  {
    key: 'chapter',
    label: '章节正文',
    description: '正文生成与章节编辑使用的章节对象。',
    value: { id: 'ch-001', title: '01 未命名章节', status: '草稿', content: '章节正文……', wordCount: 6, volumeId: 'volume-001' },
  },
  {
    key: 'world',
    label: '世界书条目',
    description: '常驻设定直接注入，关键词设定按触发词检索。',
    value: { id: 'world-001', title: '潮汐法则', tag: '硬设定', summary: '世界规则摘要', fields: { 触发策略: '关键词', 触发键: '潮汐、港口', 内容: '完整设定内容', 适用范围: '全书' }, retrieval: { triggerStrategy: 'keywords', keys: ['潮汐', '港口'] }, allowRecursive: false, allowFurtherRecursive: false, injectionOrder: 100, lockedFields: [] },
  },
  {
    key: 'character',
    label: '角色卡',
    description: '角色固定信息、状态和持有物品的统一结构。',
    value: { id: 'char-001', title: '沈砚', tag: '主角', summary: '角色信息', fields: { 触发策略: '关键词', 触发键: '', 角色身份: '主角', 性别: '男', 种族: '人类', 性格: '谨慎克制，习惯先观察再追问。', 人物动机: '查明真相', 当前状态: '正常' }, retrieval: { triggerStrategy: 'keywords', keys: [] }, holdingItems: ['item-001'], holdingSkills: ['skill-001'], allowRecursive: false, allowFurtherRecursive: false, injectionOrder: 100, lockedFields: [] },
  },
  {
    key: 'item',
    label: '道具卡',
    description: '道具用途、归属、位置与世界引擎线索关联。',
    value: { id: 'item-001', title: '铜钥匙', tag: '关键道具', summary: '道具信息', fields: { 触发策略: '关键词', 触发键: '', 用途: '打开旧仓库', 当前持有人: '林舟', 当前位置: '港口', 使用限制: '一次性' }, retrieval: { triggerStrategy: 'keywords', keys: [] }, allowRecursive: false, allowFurtherRecursive: false, injectionOrder: 100, lockedFields: [] },
  },
  {
    key: 'skill',
    label: '技能卡',
    description: '技能性质、效果和世界引擎线索。',
    value: { id: 'skill-001', title: '潮汐感知', tag: '主动', summary: '技能信息', fields: { 触发策略: '关键词', 触发键: '', 技能性质: '主动', 技能效果: '感知附近潮汐变化', 关联线索: '与海底遗迹有关' }, retrieval: { triggerStrategy: 'keywords', keys: [] }, allowRecursive: false, allowFurtherRecursive: false, injectionOrder: 100, lockedFields: [] },
  },
  {
    key: 'outline',
    label: '大纲条目',
    description: '全书、卷、章节范围和场景组成的嵌套剧情规划。',
    value: { id: 'outline-001', title: '第 6—8 章 · 船票与日期', outlineType: 'chapterRange', outlineParentId: 'outline-volume-1', outlineStartChapterId: 'ch-6', outlineEndChapterId: 'ch-8', outlineCollapsed: false, tag: '章节范围', summary: '从伪造船票推进到日期与怀表的对应关系。', fields: { 章节目标: '发现伪造船票', 场景: '港口', 冲突: '守卫阻拦', 结尾状态: '获得线索' }, lockedFields: [] },
  },
  {
    key: 'world-engine',
    label: '世界引擎状态',
    description: '已确认的世界时间、后台角色、事件、关系、时间线与工作小结；大纲由检索上下文提供。',
    value: {
      schemaVersion: 3,
      enabled: true,
      status: 'idle',
      clock: {
        label: '星期五 18:00',
        currentTime: '星期五 18:00',
        previousTime: '星期五 15:00',
        timeAdvanceMode: 'day',
        targetTime: '星期六 18:00',
        customDays: null,
        timeAdvanceReason: '本章结束后进入第二天',
        revision: 1,
      },
      characterStates: [],
      relationships: [],
      events: [],
      timeline: [],
      workNotes: [],
      pendingProposals: [],
      logs: [],
    },
  },
  {
    key: 'style',
    label: '文风规则',
    description: '正文与 Agent 创作资料遵循的底层写作约束和正反例。',
    value: { id: 'style-001', title: '克制叙事', tag: '待审阅', summary: '文风规则', fields: { 规则: '使用具体动作替代抽象情绪', 反例: '他感到非常悲伤', 正例: '他把信纸折了两次' }, lockedFields: [] },
  },
  {
    key: 'context-package',
    label: '上下文检索包',
    description: '正文生成和 Agent 共用的智能检索结果，不会把全部资料一次性塞给模型。',
    value: { currentChapter: { id: 'ch-001', title: '01 未命名章节', content: '当前章节正文……' }, retrievedResources: [{ collection: 'characters', id: 'char-001', title: '沈砚', depth: 0, matchedKeys: ['沈砚', '码头'], injectionOrder: 40, content: { summary: '角色信息', fields: { 当前状态: '正常' } } }], retrieval: { maxDepth: 2, maxMatches: 24, ordered: true } },
  },
  {
    key: 'agent-request',
    label: 'Agent 请求包',
    description: '发送给 Agent 的通用工作区结构，包含当前章节、命中资料和可执行操作约束。',
    value: { task: '请创建一个角色并关联一个道具', currentChapter: { id: 'ch-001', title: '01 未命名章节' }, retrievedResources: [], responseFormat: 'agentResponseSchema', lockedFieldsRule: '跳过 lockedFields、holdingItems、holdingSkills' },
  },
  {
    key: 'agent',
    label: 'Agent 操作协议',
    description: 'Agent 返回的通用 JSON Schema，执行前会展示修改计划。',
    value: agentResponseSchema,
  },
] as const

export const groupedResourcePages = ['world', 'characters', 'items', 'skills', 'style'] as const
export type GroupedResourcePage = typeof groupedResourcePages[number]

export function isGroupedResourcePage(page: PageKey): page is GroupedResourcePage {
  return groupedResourcePages.includes(page as GroupedResourcePage)
}




