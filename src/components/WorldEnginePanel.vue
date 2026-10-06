<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Activity, BookOpen, CalendarClock, Check, ChevronRight, Clock3, Database, Globe2, GitBranch, ListChecks, LockKeyhole, LockKeyholeOpen, Package, Play, RotateCw, ShieldCheck, TrendingUp, Users } from 'lucide-vue-next'
import ContextPreviewPanel from './ContextPreviewPanel.vue'
import type { ContextBudgetReport } from '../api/contextBudget'
import type { ContextPreviewSnapshot } from '../context/contextPreview'
import type { Chapter, Resource, WorldEngineChangeProposal, WorldEngineProposal, WorldEngineState } from '../types'

/**
 * The engine state is intentionally structural here. This keeps the panel
 * compatible with old stores while the persisted WorldEngineState is rolled
 * out. Missing arrays simply render as empty states.
 */
export type WorldEnginePanelState = WorldEngineState

/**
 * Time progression is deliberately expressed in story-level units. A fiction
 * may not have a Gregorian calendar, so the engine confirms the resulting
 * label instead of pretending that a textual clock can always be parsed.
 */
type TimeAdvanceMode = 'current' | 'chapter' | 'day' | 'month' | 'custom'

const timeAdvanceOptions: { value: TimeAdvanceMode; label: string; detail: string }[] = [
  { value: 'current', label: '当前', detail: '保持当前世界时间' },
  { value: 'chapter', label: '按章', detail: '按一章的默认跨度推进' },
  { value: 'day', label: '按天', detail: '推进一天' },
  { value: 'month', label: '按月', detail: '推进一个月' },
  { value: 'custom', label: '自定义天数', detail: '输入本轮要推进的天数' },
]

const props = defineProps<{
  worldEngine?: WorldEnginePanelState
  outline: Resource[]
  chapters: Chapter[]
  world: Resource[]
  characters: Resource[]
  items: Resource[]
  skills: Resource[]
  activeChapter?: Chapter
  providers: Resource[]
  selectedProviderId: string
  busy: boolean
  contextPreview?: ContextPreviewSnapshot | null
  contextBudget?: ContextBudgetReport | null
}>()

const emit = defineEmits<{
  runSimulation: []
  save: []
  updateTimeSpan: [mode: TimeAdvanceMode, customDays?: number]
  addEvent: [title: string]
  updateEventReviewStatus: [id: string, status: 'pending' | 'complete']
  toggleEventReviewStatusLock: [id: string, locked: boolean]
  toggleEventLockAll: [id: string, locked: boolean]
  selectProvider: [id: string]
  approveProposal: [id: string, selectedChangeIds?: string[]]
  rejectProposal: [id: string]
}>()

const eventDraft = ref('')
const isSubmitting = ref(false)
const lastRunLabel = ref('尚未推演')
const timeAdvanceMode = ref<TimeAdvanceMode>('current')
const customDays = ref<number | null>(1)

const engine = computed<Partial<WorldEngineState>>(() => props.worldEngine ?? {})
const clockDetails = computed(() => {
  /*
   * Keep this boundary tolerant while persisted projects migrate. The
   * canonical fields are added by the world-engine data layer, but older
   * projects only have clock.label and should still render safely.
   */
  const clock = (engine.value.clock ?? {}) as unknown as Record<string, unknown>
  const modeValue = clock.timeAdvanceMode
  const mode: TimeAdvanceMode = modeValue === 'chapter'
    || modeValue === 'day'
    || modeValue === 'month'
    || modeValue === 'custom'
    ? modeValue
    : 'current'
  const custom = Number(clock.customDays)
  return {
    currentTime: text(clock.currentTime ?? clock.label, '未设定'),
    previousTime: text(clock.previousTime ?? clock.startTime, '尚未记录'),
    targetTime: text(clock.targetTime ?? clock.estimatedEndLabel, '推演确认后计算'),
    mode,
    customDays: Number.isFinite(custom) && custom > 0 ? Math.floor(custom) : undefined,
    reason: text(clock.timeAdvanceReason, ''),
  }
})
const worldClock = computed(() => clockDetails.value.currentTime)
const characterStates = computed(() => Array.isArray(engine.value.characterStates) ? engine.value.characterStates : [])
const relationships = computed(() => Array.isArray(engine.value.relationships) ? engine.value.relationships : [])
const events = computed(() => Array.isArray(engine.value.events) ? engine.value.events : [])
const timeline = computed(() => Array.isArray(engine.value.timeline) ? engine.value.timeline : [])
const proposals = computed(() => Array.isArray(engine.value.pendingProposals) ? engine.value.pendingProposals.filter((proposal) => proposal.status === 'pending') : [])
const logs = computed(() => Array.isArray(engine.value.logs) ? engine.value.logs : [])
const selectedProposalChanges = ref<Record<string, string[]>>({})

const situationEvents = computed(() => events.value.filter((event) => event.kind === 'trend' || event.kind === 'consequence'))
const incidentEvents = computed(() => events.value.filter((event) => event.kind === 'event' || event.kind === 'action' || event.kind === 'discovery'))

const selectedTimeAdvanceOption = computed(() => timeAdvanceOptions.find((option) => option.value === timeAdvanceMode.value) ?? timeAdvanceOptions[0])
const timeAdvanceSummary = computed(() => {
  if (timeAdvanceMode.value === 'custom') {
    const days = customDays.value && customDays.value > 0 ? Math.floor(customDays.value) : undefined
    return days ? `推进 ${days} 天` : '请输入正整数天数'
  }
  return selectedTimeAdvanceOption.value.detail
})

watch(
  () => [clockDetails.value.mode, clockDetails.value.customDays] as const,
  ([mode, days]) => {
    timeAdvanceMode.value = mode
    if (days) customDays.value = days
  },
  { immediate: true },
)

watch(
  () => proposals.value.map((proposal) => `${proposal.id}:${proposal.changes.map((change) => change.id).join(',')}`),
  () => {
    const activeIds = new Set(proposals.value.map((proposal) => proposal.id))
    for (const id of Object.keys(selectedProposalChanges.value)) {
      if (!activeIds.has(id)) delete selectedProposalChanges.value[id]
    }
    for (const proposal of proposals.value) {
      const validIds = new Set(proposal.changes.map((change) => change.id))
      const existing = selectedProposalChanges.value[proposal.id]
      if (!existing) {
        // Time is intentionally opt-in. The author must separately confirm a
        // clock change even when approving the rest of a proposal.
        selectedProposalChanges.value[proposal.id] = proposal.changes
          .filter((change) => change.kind !== 'clock')
          .map((change) => change.id)
        continue
      }
      selectedProposalChanges.value[proposal.id] = existing.filter((id) => validIds.has(id))
    }
  },
  { immediate: true },
)

function characterRole(character: Resource) {
  const role = String(character.fields?.['角色身份'] ?? '').trim()
  if (role === '主角' || role === '配角' || role === '路人') return role
  if (character.tag.includes('主角')) return '主角'
  if (character.tag.includes('路人')) return '路人'
  return '配角'
}

const relationshipCharacterKeys = computed(() => {
  const keys = new Set<string>()
  props.characters.forEach((character) => {
    const role = characterRole(character)
    if (role !== '主角' && role !== '配角') return
    keys.add(character.id)
    keys.add(character.title)
  })
  return keys
})

const filteredRelationships = computed(() => relationships.value.filter((relationship) => (
  relationshipCharacterKeys.value.has(relationship.fromCharacterId)
  && relationshipCharacterKeys.value.has(relationship.toCharacterId)
)))

function relationshipCharacterName(id: string) {
  const character = props.characters.find((item) => item.id === id || item.title === id)
  return character?.title ?? id
}

const resourceOverview = computed(() => [
  { key: 'world', label: '世界设定', detail: '地点、规则与常驻条目', count: props.world.length, icon: Globe2 },
  { key: 'items', label: '道具与技能', detail: '可被角色持有和触发', count: props.items.length + props.skills.length, icon: Package },
  { key: 'chapters', label: '正文资料', detail: '章节与时间线输入', count: props.chapters.length, icon: BookOpen },
])

const latestChapters = computed(() => props.chapters.slice(-3).reverse())
const latestOutline = computed(() => props.outline.slice(0, 8))
const sourceStats = computed(() => [
  { key: 'world', label: '世界书', count: props.world.length, icon: Globe2 },
  { key: 'characters', label: '角色卡', count: props.characters.length, icon: Users },
  { key: 'items', label: '道具卡', count: props.items.length, icon: Database },
  { key: 'skills', label: '技能卡', count: props.skills.length, icon: ListChecks },
  { key: 'chapters', label: '正文', count: props.chapters.length, icon: BookOpen },
  { key: 'outline', label: '大纲', count: props.outline.length, icon: ListChecks },
])

function text(value: unknown, fallback = '未记录') {
  const result = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return result || fallback
}

function stateCharacterName(state: unknown) {
  const item = state && typeof state === 'object' ? state as Record<string, unknown> : {}
  return text(item.characterName ?? item.name ?? item.title ?? item.characterId, '未命名角色')
}

function stateCharacterDetail(state: unknown) {
  const item = state && typeof state === 'object' ? state as Record<string, unknown> : {}
  const location = text(item.location ?? item.place, '')
  const status = text(item.status ?? item.state ?? item.mood, '')
  const action = text(item.nextAction ?? item.action ?? item.goal, '')
  return [location, status, action].filter(Boolean).join(' · ') || '暂无后台状态'
}

function eventTitle(event: unknown) {
  const item = event && typeof event === 'object' ? event as Record<string, unknown> : {}
  return text(item.title ?? item.name ?? item.event, '未命名事件')
}

function eventSummary(event: unknown) {
  const item = event && typeof event === 'object' ? event as Record<string, unknown> : {}
  return text(item.summary ?? item.description ?? item.detail, '等待世界引擎补充描述')
}

function eventReviewStatus(event: WorldEngineState['events'][number]) {
  return event.reviewStatus === 'complete' ? 'complete' : 'pending'
}

function timelineLabel(item: unknown) {
  const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
  return text(record.time ?? record.date ?? record.chapter ?? record.title, '未设时间')
}

function proposalSummary(proposal: unknown) {
  const item = proposal && typeof proposal === 'object' ? proposal as Record<string, unknown> : {}
  return text(item.summary ?? item.reason ?? item.change ?? item.title, '待确认的世界状态变化')
}

function outlineTypeLabel(value: unknown) {
  if (value === 'book') return '全书大纲'
  if (value === 'volume') return '卷大纲'
  if (value === 'chapterRange') return '章节范围大纲'
  if (value === 'scene') return '场景大纲'
  return '大纲'
}

function outlineSummary(outline: Resource) {
  const fields = outline.fields ?? {}
  const details = [
    fields['摘要'],
    fields['章节目标'],
    fields['卷目标'],
    fields['冲突'],
    fields['结尾状态'],
    fields['卷结局'],
    fields['关键转折'],
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return details[0] ?? outline.summary ?? '暂无大纲摘要'
}

function outlineDetails(outline: Resource) {
  const fields = outline.fields ?? {}
  return [
    ['目标', fields['章节目标'] ?? fields['卷目标'] ?? fields['主线']],
    ['冲突', fields['冲突']],
    ['结尾状态', fields['结尾状态'] ?? fields['卷结局'] ?? fields['最终落点']],
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([label, value]) => `${label}：${String(value).trim()}`)
}

function submitEvent() {
  const title = eventDraft.value.trim()
  if (!title) return
  emit('addEvent', title)
  eventDraft.value = ''
}

function emitTimeAdvance() {
  const days = customDays.value && Number.isFinite(customDays.value) && customDays.value > 0
    ? Math.floor(customDays.value)
    : undefined
  emit('updateTimeSpan', timeAdvanceMode.value, timeAdvanceMode.value === 'custom' ? days : undefined)
}

function handleTimeAdvanceMode(value: string) {
  if (value === 'chapter' || value === 'day' || value === 'month' || value === 'custom') {
    timeAdvanceMode.value = value
  } else {
    timeAdvanceMode.value = 'current'
  }
  emitTimeAdvance()
}

function handleCustomDays(value: string) {
  const parsed = Number.parseInt(value, 10)
  customDays.value = Number.isFinite(parsed) && parsed > 0 ? parsed : null
  if (customDays.value) emitTimeAdvance()
}

function requestSimulation() {
  if (isSubmitting.value || props.busy) return
  emitTimeAdvance()
  isSubmitting.value = true
  lastRunLabel.value = '已提交推演请求'
  emit('runSimulation')
  window.setTimeout(() => { isSubmitting.value = false }, 450)
}

function saveEngine() {
  emitTimeAdvance()
  emit('save')
  lastRunLabel.value = '已保存'
}

function changeKindLabel(kind: WorldEngineChangeProposal['kind']) {
  return ({
    clock: '时间推进',
    character: '角色后台状态',
    relationship: '角色关系',
    event: '事件',
    timeline: '时间线',
    note: '工作小结',
  } as Record<WorldEngineChangeProposal['kind'], string>)[kind]
}

function changePatchSummary(change: WorldEngineChangeProposal) {
  const patch = change.patch ?? {}
  if (change.kind === 'clock') {
    const target = typeof patch.targetTime === 'string' ? patch.targetTime : typeof patch.currentTime === 'string' ? patch.currentTime : ''
    return target ? `目标时间：${target}` : '按已选择的时间跨度推进'
  }
  const details = Object.entries(patch)
    .filter(([key, value]) => key !== 'evidence' && value !== undefined && value !== '')
    .slice(0, 2)
    .map(([key, value]) => `${key}：${Array.isArray(value) ? value.join('、') : String(value)}`)
  return details.join(' · ')
}

function selectedChangeIds(proposal: WorldEngineProposal) {
  return selectedProposalChanges.value[proposal.id] ?? []
}

function isProposalChangeSelected(proposal: WorldEngineProposal, change: WorldEngineChangeProposal) {
  return selectedChangeIds(proposal).includes(change.id)
}

function toggleProposalChange(proposal: WorldEngineProposal, change: WorldEngineChangeProposal, checked: boolean) {
  const selected = new Set(selectedChangeIds(proposal))
  if (checked) selected.add(change.id)
  else selected.delete(change.id)
  selectedProposalChanges.value[proposal.id] = proposal.changes
    .map((item) => item.id)
    .filter((id) => selected.has(id))
}

function toggleAllProposalChanges(proposal: WorldEngineProposal) {
  const selected = selectedChangeIds(proposal)
  selectedProposalChanges.value[proposal.id] = selected.length === proposal.changes.length
    ? []
    : proposal.changes.map((change) => change.id)
}

function approveProposal(proposal: WorldEngineProposal) {
  const selected = selectedChangeIds(proposal)
  if (!selected.length) return
  emit('approveProposal', proposal.id, selected)
}
</script>

<template>
  <section class="world-engine-panel" aria-labelledby="world-engine-panel-title">
    <header class="world-engine-head">
      <div class="world-engine-heading">
        <span class="eyebrow">动态世界状态</span>
        <h2 id="world-engine-panel-title">世界引擎</h2>
        <p>把静态设定、近期正文和大纲转化为可审阅的世界变化，再提供给正文生成和 Agent。</p>
      </div>
      <div class="world-engine-head-actions">
        <label class="world-engine-provider-select"><span>推演 API</span><select :value="props.selectedProviderId" aria-label="选择世界引擎 API" @change="emit('selectProvider', ($event.target as HTMLSelectElement).value)"><option v-if="!props.providers.length" value="">未配置 API</option><option v-for="provider in props.providers" :key="provider.id" :value="provider.id">{{ provider.title }}{{ provider.fields['模型'] ? ` · ${provider.fields['模型']}` : '' }}</option></select></label>
        <button class="button secondary" type="button" @click="saveEngine"><Check :size="14" />保存状态</button>
        <button class="button primary" type="button" :disabled="isSubmitting || props.busy" @click="requestSimulation"><RotateCw v-if="isSubmitting || props.busy" class="spin" :size="14" /><Play v-else :size="14" />{{ isSubmitting || props.busy ? '推演中…' : '生成推演提案' }}</button>
      </div>
    </header>

    <div class="world-engine-status-row">
      <div class="world-engine-stat"><span>当前世界时间</span><strong>{{ worldClock }}</strong><small>{{ lastRunLabel }}</small></div>
      <div class="world-engine-stat"><span>角色后台状态</span><strong>{{ characterStates.length }}</strong><small>现场角色由正文保护</small></div>
      <div class="world-engine-stat"><span>待确认变化</span><strong>{{ proposals.length }}</strong><small>确认后才写入正式状态</small></div>
      <div class="world-engine-stat"><span>关系与事件</span><strong>{{ filteredRelationships.length + events.length }}</strong><small>关系树与宏观事件</small></div>
    </div>

    <section class="world-engine-time-panel" aria-label="世界时间推进">
      <div class="world-engine-time-head">
        <div>
          <span class="eyebrow">时间轴</span>
          <h3>本轮推演跨度</h3>
          <p>选择推演确认后世界时间要推进的范围。自定义模式使用故事内的天数，不依赖现实历法。</p>
        </div>
        <div class="world-engine-time-controls">
          <label class="world-engine-time-select">
            <span>推进方式</span>
            <select :value="timeAdvanceMode" aria-label="选择推演时间跨度" @change="handleTimeAdvanceMode(($event.target as HTMLSelectElement).value)">
              <option v-for="option in timeAdvanceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label v-if="timeAdvanceMode === 'custom'" class="world-engine-time-custom">
            <span>天数</span>
            <input
              :value="customDays ?? ''"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              placeholder="例如：3"
              aria-label="自定义推演天数"
              @change="handleCustomDays(($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </div>
      <div class="world-engine-time-overview">
        <div class="world-engine-time-stat">
          <span>起始时间</span>
          <strong>{{ clockDetails.previousTime }}</strong>
          <small>本轮推演前的已确认时间</small>
        </div>
        <div class="world-engine-time-stat">
          <span>当前时间</span>
          <strong>{{ clockDetails.currentTime }}</strong>
          <small>已确认并提供给正文与 Agent</small>
        </div>
        <div class="world-engine-time-stat">
          <span>本轮跨度</span>
          <strong>{{ timeAdvanceMode === 'custom' && customDays ? `推进 ${Math.floor(customDays)} 天` : selectedTimeAdvanceOption.label }}</strong>
          <small>{{ timeAdvanceSummary }}</small>
        </div>
        <div class="world-engine-time-stat">
          <span>预计结束</span>
          <strong>{{ clockDetails.targetTime }}</strong>
          <small>{{ clockDetails.targetTime === '推演确认后计算' ? '确认提案后写入时间线' : '来自最近一次确认的推演结果' }}</small>
        </div>
      </div>
      <p v-if="clockDetails.reason" class="world-engine-time-reason"><Clock3 :size="13" />{{ clockDetails.reason }}</p>
    </section>

    <div class="world-engine-sources">
      <div class="world-engine-section-label"><Database :size="14" /><span>本轮推演输入</span><small>智能检索后注入，不一次塞入全部资料</small></div>
      <div class="world-engine-source-list">
        <div v-for="source in sourceStats" :key="source.key" class="world-engine-source"><component :is="source.icon" :size="15" /><span>{{ source.label }}</span><strong>{{ source.count }}</strong></div>
      </div>
      <ContextPreviewPanel :preview="props.contextPreview" :budget="props.contextBudget" compact title="世界引擎实际上下文" />
    </div>

    <nav class="world-engine-category-nav" aria-label="世界引擎分类">
      <a href="#world-engine-situation"><TrendingUp :size="15" /><span>局势</span><strong>{{ situationEvents.length }}</strong><small>天下大势</small></a>
      <a href="#world-engine-incidents"><Activity :size="15" /><span>事件</span><strong>{{ incidentEvents.length }}</strong><small>事件链与后果</small></a>
      <a href="#world-engine-relations"><GitBranch :size="15" /><span>关系</span><strong>{{ filteredRelationships.length }}</strong><small>主角与配角</small></a>
      <a href="#world-engine-resources"><Package :size="15" /><span>资源</span><strong>{{ props.world.length + props.items.length + props.skills.length }}</strong><small>设定与资料</small></a>
    </nav>

    <div class="world-engine-body">
      <article id="world-engine-situation" class="world-engine-card world-engine-card-wide world-engine-category-card">
        <div class="world-engine-card-head"><div><span class="eyebrow">局势</span><h3>天下大势</h3><p class="world-engine-card-subtitle">影响多方行动的长期趋势与已确认后果</p></div><span class="world-engine-card-count">{{ situationEvents.length }}</span></div>
        <div v-if="situationEvents.length" class="world-engine-event-list">
          <div v-for="event in situationEvents" :key="event.id" class="world-engine-event">
            <div class="world-engine-event-icon"><TrendingUp :size="14" /></div>
            <div class="world-engine-event-copy">
              <strong>{{ eventTitle(event) }}</strong>
              <p>{{ eventSummary(event) }}</p>
              <div class="world-engine-event-meta">
                <span class="world-engine-event-source" :class="event.creationSource === 'agent' ? 'agent' : 'manual'">{{ event.creationSource === 'agent' ? 'Agent 创建' : '手动创建' }}</span>
                <button class="world-engine-event-review" :class="eventReviewStatus(event)" type="button" :aria-label="`切换${eventTitle(event)}的校对状态`" @click="emit('updateEventReviewStatus', event.id, eventReviewStatus(event) === 'complete' ? 'pending' : 'complete')">{{ eventReviewStatus(event) === 'complete' ? '完成' : '待修改' }}</button>
                <button class="world-engine-event-lock" :class="{ locked: event.reviewStatusLocked }" type="button" :title="event.reviewStatusLocked ? '校对状态已锁定，Agent 不可修改' : '锁定校对状态，禁止 Agent 修改'" :aria-label="event.reviewStatusLocked ? '解锁校对状态' : '锁定校对状态'" @click="emit('toggleEventReviewStatusLock', event.id, !event.reviewStatusLocked)"><LockKeyhole v-if="event.reviewStatusLocked" :size="12" /><LockKeyholeOpen v-else :size="12" /></button>
                <button class="world-engine-event-lock" :class="{ locked: event.lockedAll }" type="button" :title="event.lockedAll ? '解锁条目，并恢复锁定前的校对状态锁' : '锁定整个条目，禁止 Agent 修改任何内容'" :aria-label="event.lockedAll ? '解锁整个条目' : '锁定整个条目'" @click="emit('toggleEventLockAll', event.id, !event.lockedAll)"><LockKeyhole v-if="event.lockedAll" :size="12" /><LockKeyholeOpen v-else :size="12" /></button>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="world-engine-empty"><TrendingUp :size="16" /><span>暂未形成天下大势。推演确认后，长期趋势会在这里汇总。</span></div>
      </article>

      <article id="world-engine-incidents" class="world-engine-card world-engine-card-wide world-engine-category-card">
        <div class="world-engine-card-head"><div><span class="eyebrow">事件</span><h3>事件链与后果</h3><p class="world-engine-card-subtitle">正在发生的行动、发现和局部冲突</p></div><span class="world-engine-card-count">{{ incidentEvents.length }}</span></div>
        <div v-if="incidentEvents.length" class="world-engine-event-list">
          <div v-for="event in incidentEvents" :key="event.id" class="world-engine-event">
            <div class="world-engine-event-icon"><Activity :size="14" /></div>
            <div class="world-engine-event-copy">
              <strong>{{ eventTitle(event) }}</strong>
              <p>{{ eventSummary(event) }}<span v-if="event.status" class="world-engine-event-status">{{ event.status === 'active' ? '进行中' : event.status === 'resolved' ? '已解决' : event.status === 'planned' ? '计划中' : '已搁置' }}</span></p>
              <div class="world-engine-event-meta">
                <span class="world-engine-event-source" :class="event.creationSource === 'agent' ? 'agent' : 'manual'">{{ event.creationSource === 'agent' ? 'Agent 创建' : '手动创建' }}</span>
                <button class="world-engine-event-review" :class="eventReviewStatus(event)" type="button" :aria-label="`切换${eventTitle(event)}的校对状态`" @click="emit('updateEventReviewStatus', event.id, eventReviewStatus(event) === 'complete' ? 'pending' : 'complete')">{{ eventReviewStatus(event) === 'complete' ? '完成' : '待修改' }}</button>
                <button class="world-engine-event-lock" :class="{ locked: event.reviewStatusLocked }" type="button" :title="event.reviewStatusLocked ? '校对状态已锁定，Agent 不可修改' : '锁定校对状态，禁止 Agent 修改'" :aria-label="event.reviewStatusLocked ? '解锁校对状态' : '锁定校对状态'" @click="emit('toggleEventReviewStatusLock', event.id, !event.reviewStatusLocked)"><LockKeyhole v-if="event.reviewStatusLocked" :size="12" /><LockKeyholeOpen v-else :size="12" /></button>
                <button class="world-engine-event-lock" :class="{ locked: event.lockedAll }" type="button" :title="event.lockedAll ? '解锁条目，并恢复锁定前的校对状态锁' : '锁定整个条目，禁止 Agent 修改任何内容'" :aria-label="event.lockedAll ? '解锁整个条目' : '锁定整个条目'" @click="emit('toggleEventLockAll', event.id, !event.lockedAll)"><LockKeyhole v-if="event.lockedAll" :size="12" /><LockKeyholeOpen v-else :size="12" /></button>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="world-engine-empty"><Activity :size="16" /><span>暂未记录事件链。你可以手动添加一个待推演事件。</span></div>
        <form class="world-engine-event-form" @submit.prevent="submitEvent"><input v-model="eventDraft" type="text" placeholder="手动添加一个待推演事件" aria-label="手动添加事件" /><button class="icon-button" type="submit" title="添加事件" aria-label="添加事件"><ChevronRight :size="16" /></button></form>
      </article>

      <article class="world-engine-card">
        <div class="world-engine-card-head"><div><span class="eyebrow">后台推进</span><h3>角色状态</h3><p class="world-engine-card-subtitle">不占用当前场景的角色行动</p></div><span class="world-engine-card-count">{{ characterStates.length }}</span></div>
        <div v-if="characterStates.length" class="world-engine-character-list"><div v-for="(state, index) in characterStates.slice(0, 5)" :key="String(state.id ?? state.characterId ?? index)" class="world-engine-character"><Users :size="14" /><div><strong>{{ stateCharacterName(state) }}</strong><p>{{ stateCharacterDetail(state) }}</p></div></div></div>
        <div v-else class="world-engine-empty"><Users :size="16" /><span>尚未记录角色的后台行动。</span></div>
      </article>

      <article class="world-engine-card world-engine-timeline-card">
        <div class="world-engine-card-head"><div><span class="eyebrow">事件记录</span><h3>时间线</h3><p class="world-engine-card-subtitle">按世界时间追踪已确认变化</p></div><span class="world-engine-card-count">{{ timeline.length }}</span></div>
        <div v-if="timeline.length" class="world-engine-timeline"><div v-for="(item, index) in timeline.slice(0, 5)" :key="String(item.id ?? index)" class="world-engine-timeline-item"><time>{{ timelineLabel(item) }}</time><span>{{ text(item.title ?? item.summary, '未命名节点') }}</span></div></div>
        <div v-else-if="latestChapters.length" class="world-engine-timeline"><div v-for="chapter in latestChapters" :key="chapter.id" class="world-engine-timeline-item"><time>{{ chapter.title }}</time><span>{{ chapter.content.trim() ? '已有正文，可作为世界引擎输入' : '尚未写入正文' }}</span></div></div>
        <div v-else class="world-engine-empty"><CalendarClock :size="16" /><span>正文推进后会在这里形成时间线。</span></div>
      </article>

      <article id="world-engine-relations" class="world-engine-card world-engine-card-wide world-engine-category-card">
        <div class="world-engine-card-head"><div><span class="eyebrow">关系</span><h3>主角与配角关系</h3><p class="world-engine-card-subtitle">只显示主角、配角之间的关系，路人不会进入关系网</p></div><span class="world-engine-card-count">{{ filteredRelationships.length }}</span></div>
        <div v-if="filteredRelationships.length" class="world-engine-relationship-list"><div v-for="relationship in filteredRelationships.slice(0, 8)" :key="relationship.id" class="world-engine-relationship"><div class="world-engine-relationship-names"><strong>{{ relationshipCharacterName(relationship.fromCharacterId) }}</strong><ChevronRight :size="14" /><strong>{{ relationshipCharacterName(relationship.toCharacterId) }}</strong></div><span class="world-engine-relationship-label">{{ relationship.label }}</span><p>{{ relationship.detail || '暂无关系细节' }}</p><small v-if="relationship.confidence">{{ relationship.confidence === 'confirmed' ? '已确认' : relationship.confidence === 'inferred' ? '推断' : '待核实' }}</small></div></div>
        <div v-else class="world-engine-empty"><GitBranch :size="16" /><span>尚未记录主角与配角之间的关系。路人角色不会显示在这里。</span></div>
      </article>

      <article id="world-engine-resources" class="world-engine-card world-engine-card-wide world-engine-category-card">
        <div class="world-engine-card-head"><div><span class="eyebrow">资源</span><h3>世界资料概览</h3><p class="world-engine-card-subtitle">世界引擎可以按需检索这些资料，不会每轮全部注入</p></div><span class="world-engine-card-count">{{ props.world.length + props.items.length + props.skills.length }}</span></div>
        <div class="world-engine-resource-overview"><div v-for="resource in resourceOverview" :key="resource.key" class="world-engine-resource-tile"><component :is="resource.icon" :size="17" /><div><strong>{{ resource.label }}</strong><p>{{ resource.detail }}</p></div><b>{{ resource.count }}</b></div></div>
      </article>

      <article class="world-engine-card world-engine-card-wide">
        <div class="world-engine-card-head"><div><span class="eyebrow">大纲</span><h3>大纲约束与因果</h3><p class="world-engine-card-subtitle">当前大纲为世界引擎提供剧情目标、冲突和结尾状态约束</p></div><span class="world-engine-card-count">{{ latestOutline.length }}</span></div>
        <div v-if="latestOutline.length" class="world-engine-hook-list world-engine-outline-list">
          <div v-for="outline in latestOutline" :key="outline.id" class="world-engine-hook world-engine-outline-item">
            <span class="world-engine-hook-status">{{ outlineTypeLabel(outline.outlineType) }}</span>
            <span class="world-engine-hook-copy">
              <strong>{{ text(outline.title, '未命名大纲') }}</strong>
              <small>{{ outlineSummary(outline) }}</small>
              <small v-for="detail in outlineDetails(outline)" :key="detail">{{ detail }}</small>
            </span>
          </div>
        </div>
        <div v-else class="world-engine-empty"><ShieldCheck :size="16" /><span>创建大纲后，世界引擎会在这里读取剧情约束与因果。</span></div>
      </article>

      <article class="world-engine-card">
        <div class="world-engine-card-head"><div><span class="eyebrow">审阅队列</span><h3>待确认提案</h3></div><span class="world-engine-card-count">{{ proposals.length }}</span></div>
        <div v-if="proposals.length" class="world-engine-proposal-list">
          <div v-for="(proposal, index) in proposals.slice(0, 4)" :key="String(proposal.id ?? index)" class="world-engine-proposal">
            <ListChecks :size="14" />
            <div class="world-engine-proposal-copy">
              <span>{{ proposal.reasoning || proposalSummary(proposal) }}<small>{{ proposal.changes?.length ?? 0 }} 项变化 · 已选 {{ selectedChangeIds(proposal).length }} 项</small></span>
              <details class="world-engine-proposal-details">
                <summary>逐项审阅（时间推进需单独确认）</summary>
                <div class="world-engine-change-list">
                  <label v-for="change in proposal.changes" :key="change.id" class="world-engine-change">
                    <input type="checkbox" :checked="isProposalChangeSelected(proposal, change)" @change="toggleProposalChange(proposal, change, ($event.target as HTMLInputElement).checked)" />
                    <span class="world-engine-change-copy">
                      <strong>{{ changeKindLabel(change.kind) }}</strong>
                      <span>{{ change.summary }}</span>
                      <small v-if="changePatchSummary(change)">{{ changePatchSummary(change) }}</small>
                      <small v-if="change.kind === 'clock'" class="world-engine-clock-warning">需要单独确认，不会因批准其他变化而自动推进</small>
                    </span>
                  </label>
                </div>
                <button class="world-engine-select-all" type="button" @click="toggleAllProposalChanges(proposal)">{{ selectedChangeIds(proposal).length === proposal.changes.length ? '取消全选' : '全选（含时间）' }}</button>
              </details>
            </div>
            <div class="world-engine-proposal-actions">
              <button class="button primary" type="button" :disabled="selectedChangeIds(proposal).length === 0" @click="approveProposal(proposal)">确认写入 {{ selectedChangeIds(proposal).length }} 项</button>
              <button class="button secondary" type="button" @click="emit('rejectProposal', String(proposal.id))">丢弃</button>
            </div>
          </div>
        </div>
        <div v-else class="world-engine-empty"><ShieldCheck :size="16" /><span>没有待确认变化。世界引擎只会把审阅通过的提案提供给 Agent。</span></div>
      </article>
    </div>

    <footer v-if="logs.length" class="world-engine-footer"><span><CalendarClock :size="13" />最近日志</span><span>{{ logs[0]?.status === 'error' ? (logs[0]?.error || '最近一次推演失败') : '最近一次推演已记录' }}</span></footer>
  </section>
</template>

<style scoped>
.world-engine-time-panel { min-width: 0; padding: 12px; border: 1px solid var(--theme-border); border-radius: 7px; background: var(--theme-surface); }
.world-engine-time-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.world-engine-time-head h3 { margin-top: 4px; color: var(--theme-font); font-size: 13px; }
.world-engine-time-head p { max-width: 650px; margin-top: 3px; color: var(--theme-muted); font-size: 9px; line-height: 1.45; }
.world-engine-time-controls { display: flex; align-items: flex-end; gap: 7px; flex: 0 0 auto; }
.world-engine-time-select, .world-engine-time-custom { display: flex; flex-direction: column; gap: 4px; color: var(--theme-muted); font-size: 10px; }
.world-engine-time-select select, .world-engine-time-custom input { min-width: 118px; height: 30px; border: 1px solid var(--theme-border); border-radius: 5px; padding: 0 8px; color: var(--theme-font); background: var(--theme-surface); font-size: 10px; outline: 0; }
.world-engine-time-custom input { width: 74px; min-width: 74px; }
.world-engine-time-select select:focus, .world-engine-time-custom input:focus { border-color: var(--theme-button); box-shadow: 0 0 0 2px var(--theme-focus-ring); }
.world-engine-time-overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; margin-top: 10px; }
.world-engine-time-stat { min-width: 0; padding: 8px 9px; border: 1px solid var(--theme-border); border-radius: 5px; background: var(--theme-secondary); }
.world-engine-time-stat span, .world-engine-time-stat small { display: block; color: var(--theme-muted); font-size: 9px; }
.world-engine-time-stat strong { display: block; margin: 4px 0 2px; overflow: hidden; color: var(--theme-font); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.world-engine-time-stat small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.world-engine-time-reason { display: flex; align-items: center; gap: 5px; margin-top: 8px; color: var(--theme-muted); font-size: 9px; line-height: 1.45; }
.world-engine-time-reason svg { flex: 0 0 auto; color: var(--theme-button); }
.world-engine-event-copy { min-width: 0; flex: 1; }
.world-engine-event-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 6px; }
.world-engine-proposal-copy { min-width: 0; flex: 1; }
.world-engine-proposal-copy > span { display: block; min-width: 0; color: var(--theme-font); line-height: 1.45; }
.world-engine-proposal-copy > span small { display: block; margin-top: 4px; color: var(--theme-muted); font-size: 9px; }
.world-engine-proposal-details { margin-top: 8px; border-top: 1px solid var(--theme-border-soft); }
.world-engine-proposal-details summary { padding-top: 7px; color: var(--theme-button); font-size: 10px; cursor: pointer; }
.world-engine-change-list { display: grid; gap: 5px; margin-top: 7px; }
.world-engine-change { display: flex; align-items: flex-start; gap: 7px; padding: 6px 7px; border: 1px solid var(--theme-border); border-radius: 5px; background: var(--theme-secondary); cursor: pointer; }
.world-engine-change input { flex: 0 0 auto; margin-top: 2px; accent-color: var(--theme-button); }
.world-engine-change-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; color: var(--theme-font); font-size: 10px; }
.world-engine-change-copy strong { color: var(--theme-button); font-size: 9px; font-weight: 600; }
.world-engine-change-copy span { overflow-wrap: anywhere; }
.world-engine-change-copy small { color: var(--theme-muted); font-size: 9px; line-height: 1.35; overflow-wrap: anywhere; }
.world-engine-clock-warning { color: var(--theme-warning, var(--theme-button)) !important; }
.world-engine-select-all { margin-top: 7px; padding: 3px 0; border: 0; color: var(--theme-button); background: transparent; font: inherit; font-size: 10px; cursor: pointer; }
.world-engine-outline-item { align-items: flex-start; }
.world-engine-outline-item .world-engine-hook-status { margin-top: 1px; }
.world-engine-outline-item .world-engine-hook-copy small { white-space: normal; line-height: 1.4; }
.world-engine-event-source, .world-engine-event-review { display: inline-flex; align-items: center; min-height: 20px; padding: 2px 6px; border: 0; border-radius: 4px; font: inherit; font-size: 9px; line-height: 1.25; }
.world-engine-event-source.agent { color: var(--theme-button); background: var(--theme-accent-soft); }
.world-engine-event-source.manual { color: var(--theme-muted); background: var(--theme-neutral-soft); }
.world-engine-event-review { cursor: pointer; }
.world-engine-event-review.pending { color: var(--theme-font); background: var(--theme-accent-soft); }
.world-engine-event-review.complete { color: var(--theme-font); background: var(--theme-accent-soft); }
.world-engine-event-lock { width: 22px; height: 22px; display: inline-grid; place-items: center; padding: 0; border: 1px solid var(--theme-border); border-radius: 4px; color: var(--theme-muted); background: var(--theme-surface); cursor: pointer; }
.world-engine-event-lock.locked { border-color: var(--theme-border); color: var(--theme-danger); background: var(--theme-neutral-soft); }
.world-engine-event-meta button:focus-visible { outline: 2px solid var(--theme-button); outline-offset: 2px; }

/* Keep the time controls and event workflow badges in the selected palette. */
:global(html[data-theme-mode] .world-engine-time-panel){
  color: var(--theme-font);
  border-color: var(--theme-border);
  background: var(--theme-surface);
}
:global(html[data-theme-mode] .world-engine-time-head h3),
:global(html[data-theme-mode] .world-engine-time-stat strong){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .world-engine-time-head p),
:global(html[data-theme-mode] .world-engine-time-select),
:global(html[data-theme-mode] .world-engine-time-custom),
:global(html[data-theme-mode] .world-engine-time-stat span),
:global(html[data-theme-mode] .world-engine-time-stat small),
:global(html[data-theme-mode] .world-engine-time-reason){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .world-engine-time-select select),
:global(html[data-theme-mode] .world-engine-time-custom input){
  color: var(--theme-font);
  border-color: var(--theme-border);
  background: var(--theme-input-bg);
}
:global(html[data-theme-mode] .world-engine-time-select select:focus),
:global(html[data-theme-mode] .world-engine-time-custom input:focus){
  border-color: var(--theme-button);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-button) 18%, transparent);
}
:global(html[data-theme-mode] .world-engine-time-stat){
  color: var(--theme-font);
  border-color: var(--theme-border);
  background: var(--theme-secondary);
}
:global(html[data-theme-mode] .world-engine-time-reason svg){
  color: var(--theme-button);
}
:global(html[data-theme-mode] .world-engine-event-source.agent),
:global(html[data-theme-mode] .world-engine-event-review.complete){
  color: var(--theme-font);
  background: color-mix(in srgb, var(--theme-secondary) 82%, var(--theme-button) 18%);
}
:global(html[data-theme-mode] .world-engine-event-source.manual){
  color: var(--theme-muted);
  background: color-mix(in srgb, var(--theme-secondary) 90%, var(--theme-font) 10%);
}
:global(html[data-theme-mode] .world-engine-event-review.pending){
  color: var(--theme-font);
  background: color-mix(in srgb, var(--theme-secondary) 72%, var(--theme-button) 28%);
}
:global(html[data-theme-mode] .world-engine-event-lock){
  color: var(--theme-muted);
  border-color: var(--theme-border);
  background: var(--theme-secondary);
}
:global(html[data-theme-mode] .world-engine-event-lock:hover){
  color: var(--theme-button);
  border-color: var(--theme-button);
  background: var(--theme-hover);
}
:global(html[data-theme-mode] .world-engine-event-lock.locked){
  color: var(--theme-button);
  border-color: var(--theme-button);
  background: color-mix(in srgb, var(--theme-secondary) 74%, var(--theme-button) 26%);
}
:global(html[data-theme-mode] .world-engine-event-meta button:focus-visible){
  outline-color: var(--theme-button);
}
:global(html[data-theme-mode] .world-engine-sources){
  color: var(--theme-font);
  border-color: var(--theme-border);
  background: var(--theme-secondary);
}
:global(html[data-theme-mode] .world-engine-section-label){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .world-engine-source-list){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .world-engine-section-label svg),
:global(html[data-theme-mode] .world-engine-source svg){
  color: var(--theme-button);
}
:global(html[data-theme-mode] .world-engine-section-label small),
:global(html[data-theme-mode] .world-engine-source){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .world-engine-source){
  border-color: var(--theme-border);
  background: var(--theme-surface);
}
:global(html[data-theme-mode] .world-engine-source span){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .world-engine-source strong){
  color: var(--theme-button);
}
:global(html[data-theme-mode] .world-engine-timeline-card){
  color: var(--theme-font);
  border-color: var(--theme-border);
  background: var(--theme-surface);
}
:global(html[data-theme-mode] .world-engine-timeline){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .world-engine-timeline-item){
  color: var(--theme-font);
  border-color: var(--theme-border-soft);
}
:global(html[data-theme-mode] .world-engine-timeline-item time){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .world-engine-timeline-item span){
  color: var(--theme-font);
}

@media (max-width: 720px) {
  .world-engine-time-head { flex-direction: column; }
  .world-engine-time-controls { width: 100%; align-items: stretch; }
  .world-engine-time-select { flex: 1; }
  .world-engine-time-select select { width: 100%; }
}

@media (max-width: 560px) {
  .world-engine-time-controls, .world-engine-time-overview { grid-template-columns: minmax(0, 1fr); display: grid; }
  .world-engine-time-custom input { width: 100%; }
}
</style>
