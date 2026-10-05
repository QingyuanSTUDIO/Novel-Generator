<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Circle, FileText, Lightbulb, LoaderCircle, Search, Sparkles, X } from 'lucide-vue-next'
import ContextUsageIndicator from './ContextUsageIndicator.vue'
import type { ContextBudgetReport } from '../api/contextBudget'
import type { ChatUsage } from '../api/chatUsage'
import type { AgentTask } from '../types'

type ActivitySource = 'writer' | 'agent' | 'world-engine' | 'search' | 'idle'
type WriterActivityState = 'idle' | 'running' | 'done' | 'error'

const props = withDefaults(defineProps<{
  writingBusy?: boolean
  /** Kept separately from busy so completed candidates and failures stay visible. */
  writerState?: WriterActivityState
  /** For example: 已接收 320 字, 候选正文已生成, or the actual error message. */
  writerDetail?: string
  agentBusy?: boolean
  agentPendingConfirmation?: boolean
  worldEngineBusy?: boolean
  searchBusy?: boolean
  agentTasks?: AgentTask[]
  budget?: ContextBudgetReport | null
  usage?: ChatUsage | null
  metricsStatus?: 'preview' | 'running' | 'done' | 'error'
  contextBudgetLabel?: string
}>(), {
  writingBusy: false,
  writerState: 'idle',
  writerDetail: '',
  agentBusy: false,
  agentPendingConfirmation: false,
  worldEngineBusy: false,
  searchBusy: false,
  agentTasks: () => [],
  contextBudgetLabel: '本次请求预算',
})

const meaningfulTasks = computed(() => props.agentTasks.filter((task) => task.id !== 'agent-ready'))
const runningTask = computed(() => meaningfulTasks.value.find((task) => task.state === 'running'))
const failedTask = computed(() => meaningfulTasks.value.find((task) => task.state === 'error'))
const latestTask = computed(() => [...meaningfulTasks.value].reverse().find((task) => task.state !== 'queued') ?? meaningfulTasks.value[meaningfulTasks.value.length - 1])
const displayTasks = computed(() => meaningfulTasks.value.slice(-4))
const writerBusy = computed(() => props.writingBusy || props.writerState === 'running')
const hasWriterActivity = computed(() => props.writerState !== 'idle')
const hasAgentActivity = computed(() => meaningfulTasks.value.length > 0 || props.agentPendingConfirmation)
const lastActivitySource = ref<ActivitySource>('idle')

// Keep the most recent completed activity visible when both the writer and
// Agent have work history. A previous candidate must not mask a newer Agent run.
watch(() => [props.writingBusy, props.writerState, props.writerDetail], () => {
  if (writerBusy.value || hasWriterActivity.value) lastActivitySource.value = 'writer'
}, { immediate: true })
watch(() => [
  props.agentBusy,
  props.agentPendingConfirmation,
  meaningfulTasks.value.map((task) => `${task.id}:${task.state}:${task.detail ?? ''}`).join('|'),
], () => {
  if (props.agentBusy || hasAgentActivity.value) lastActivitySource.value = 'agent'
}, { immediate: true })

const source = computed<ActivitySource>(() => {
  if (writerBusy.value) return 'writer'
  if (props.agentBusy) return 'agent'
  if (props.worldEngineBusy) return 'world-engine'
  if (props.searchBusy) return 'search'
  if (lastActivitySource.value === 'writer' && hasWriterActivity.value) return 'writer'
  if (lastActivitySource.value === 'agent' && hasAgentActivity.value) return 'agent'
  if (hasWriterActivity.value) return 'writer'
  if (hasAgentActivity.value) return 'agent'
  return 'idle'
})

const isBusy = computed(() => (
  source.value === 'writer' ? writerBusy.value
    : source.value === 'agent' ? props.agentBusy
      : source.value === 'world-engine' ? props.worldEngineBusy
        : source.value === 'search' ? props.searchBusy : false
))
const activityError = computed(() => !isBusy.value && (
  source.value === 'writer' ? props.writerState === 'error'
    : source.value === 'agent' && Boolean(failedTask.value)
))
const awaitingConfirmation = computed(() => source.value === 'agent' && !isBusy.value && !activityError.value && props.agentPendingConfirmation)

const activityTitle = computed(() => {
  if (source.value === 'writer') {
    if (writerBusy.value) return '正在生成正文'
    if (props.writerState === 'error') return '正文生成失败'
    return '候选正文已生成'
  }
  if (source.value === 'agent') {
    if (props.agentBusy) return runningTask.value?.label || 'Agent 正在工作'
    if (activityError.value) return 'Agent 工作失败'
    if (awaitingConfirmation.value) return 'Agent 修改待确认'
    if (latestTask.value) return `刚刚：${latestTask.value.label}`
  }
  if (source.value === 'world-engine') return '正在推演世界引擎'
  if (source.value === 'search') return '正在检索网络热梗'
  return 'AI 已就绪'
})

const activityDetail = computed(() => {
  if (source.value === 'writer') {
    if (props.writerDetail.trim()) return props.writerDetail
    if (writerBusy.value) return '正在根据章节任务、正文上下文和已启用资料生成候选正文'
    if (props.writerState === 'error') return '本次生成未成功，请检查错误信息后重试'
    return '候选正文等待采纳'
  }
  if (source.value === 'agent') {
    if (props.agentBusy) return runningTask.value?.detail || '正在读取作品资料并整理操作计划'
    if (activityError.value) return failedTask.value?.detail || `${failedTask.value?.label ?? 'Agent 任务'}未成功`
    if (awaitingConfirmation.value) return '操作计划已生成，等待你确认后才会写入作品'
    return latestTask.value?.detail || 'Agent 已完成本次请求'
  }
  if (source.value === 'world-engine') return '正在读取大纲、章节和世界状态，生成待确认推演结果'
  if (source.value === 'search') return '正在拆分关键词、分批搜索并整理结果'
  return '等待写作、Agent 或世界引擎任务'
})

const stateLabel = computed(() => {
  if (isBusy.value) return '执行中'
  if (activityError.value) return '出错'
  if (awaitingConfirmation.value) return '待确认'
  if (source.value === 'writer' || source.value === 'agent') return '已完成'
  return '空闲'
})

function taskIcon(state: AgentTask['state']) {
  if (state === 'running') return LoaderCircle
  if (state === 'done') return Check
  if (state === 'error') return X
  return Circle
}

function sourceIcon(kind: ActivitySource) {
  if (kind === 'writer') return FileText
  if (kind === 'agent') return Sparkles
  if (kind === 'world-engine') return Lightbulb
  if (kind === 'search') return Search
  return Circle
}
</script>

<template>
  <section class="ai-activity-strip" :class="[`ai-activity-${source}`, { busy: isBusy, error: activityError }]" role="status" aria-live="polite">
    <div class="ai-activity-main">
      <span class="ai-activity-icon" aria-hidden="true">
        <LoaderCircle v-if="isBusy" class="spin" :size="15" />
        <component :is="sourceIcon(source)" v-else :size="15" />
      </span>
      <div class="ai-activity-copy">
        <div class="ai-activity-title-row"><span class="ai-activity-kicker">AI 活动</span><span class="ai-activity-source">{{ source === 'writer' ? '正文' : source === 'agent' ? 'Agent' : source === 'world-engine' ? '世界引擎' : source === 'search' ? '网络检索' : '工作台' }}</span><strong :title="activityTitle">{{ activityTitle }}</strong></div>
        <small :title="activityDetail">{{ activityDetail }}</small>
      </div>
    </div>
    <div v-if="source === 'agent' && displayTasks.length" class="ai-activity-timeline" aria-label="最近 AI 操作">
      <span v-for="task in displayTasks" :key="task.id" :class="['ai-activity-step', `ai-activity-step-${task.state}`]" :title="task.detail || task.label">
        <component :is="taskIcon(task.state)" :class="{ spin: task.state === 'running' }" :size="12" />
        <b>{{ task.label }}</b>
      </span>
    </div>
    <div v-if="props.budget !== undefined || props.usage !== undefined" class="ai-activity-usage">
      <ContextUsageIndicator :budget="props.budget ?? null" :usage="props.usage" :status="props.metricsStatus" :budget-label="props.contextBudgetLabel" label="本次请求" />
    </div>
    <span class="ai-activity-state" :class="{ busy: isBusy, error: activityError, pending: awaitingConfirmation }">
      <span class="ai-activity-state-dot"></span>{{ stateLabel }}
    </span>
  </section>
</template>

<style scoped>
.ai-activity-usage { min-width: 0; flex: 0 1 auto; display: flex; align-items: center; }
@media (max-width: 900px) {
  .ai-activity-usage :deep(.context-usage-remaining) { display: none; }
}
</style>
