<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRefs, watch } from 'vue'
import { Check, ChevronDown, ClipboardList, Copy, FileText, LoaderCircle, Maximize2, Minus, Pause, Play, Send, Square, Terminal, X } from 'lucide-vue-next'
import TerminalView from './TerminalView.vue'
import { removeOperationIndexesWithDependents, selectOperationIndexesWithDependencies } from '../agent/planDependencies'
import '../console/console.css'
import type { ConsoleActionInput, ConsoleJob, ConsoleJobStatus, ConsoleSubmission } from '../console/types'
import type { AgentMode, AgentPlanFieldDiff } from '../types'
import { consoleDrafts, consolePanelUi, getConsoleDraft } from '../console/uiState'

const props = withDefaults(defineProps<{
  jobs: ConsoleJob[]
  providers: { id: string; title: string; model: string }[]
  currentTarget?: { portfolioId: string; projectId: string; chapterId?: string; conversationId?: string }
  busy: boolean
  dock?: boolean
  currentJobId?: string
  sessionEndpoint?: string
  error?: string
  projectNames?: Record<string, string>
}>(), { dock: false, currentJobId: '', sessionEndpoint: '', error: '', projectNames: () => ({}) })

const emit = defineEmits<{
  submit: [submission: ConsoleSubmission]
  action: [input: ConsoleActionInput]
  hide: []
  maximize: []
  resize: [height: number]
}>()

const { tab, selectedJobId, statusFilter, logQuery } = toRefs(consolePanelUi)
const targetKey = computed(() => JSON.stringify([props.currentTarget?.portfolioId ?? '', props.currentTarget?.projectId ?? '']))
const draft = computed(() => getConsoleDraft(targetKey.value))
const prompt = computed({ get: () => draft.value.prompt, set: (value: string) => { draft.value.prompt = value } })
const providerId = computed({ get: () => draft.value.providerId, set: (value: string) => { draft.value.providerId = value } })
const mode = computed({ get: () => draft.value.mode, set: (value: AgentMode) => { draft.value.mode = value } })
const submittingRequestId = computed({ get: () => draft.value.pendingRequestId, set: (value: string) => { draft.value.pendingRequestId = value } })
const clipboardStatus = ref('')
let clipboardTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const statusLabels: Record<ConsoleJobStatus, string> = {
  queued: '排队中', running: '执行中', awaiting_approval: '待确认', saving: '保存中',
  completed: '已完成', failed: '失败', paused: '已暂停', canceled: '已取消',
}
const finishedStatuses: ConsoleJobStatus[] = ['completed', 'failed', 'canceled']
const activeCount = computed(() => props.jobs.filter((job) => !finishedStatuses.includes(job.status)).length)
const filteredJobs = computed(() => [...props.jobs].filter((job) => statusFilter.value === 'all'
  || (statusFilter.value === 'active' ? !finishedStatuses.includes(job.status) : finishedStatuses.includes(job.status)))
  .sort((a, b) => b.createdAt - a.createdAt))
const selectedJob = computed(() => props.jobs.find((job) => job.id === selectedJobId.value))
const selectedPlanOperations = ref<number[]>([])
const selectedPlanCount = computed(() => selectedPlanOperations.value.length)
const selectedPlan = computed(() => selectedJob.value?.result?.plan)
const allPlanOperationsSelected = computed(() => Boolean(selectedPlan.value?.operations.length)
  && selectedPlanCount.value === selectedPlan.value!.operations.length)
const targetMismatch = computed(() => {
  const job = selectedJob.value
  if (!job) return ''
  const current = props.currentTarget
  if (!current) return '请先打开任务的作品集并保存，再确认修改。'
  if (job.target.portfolioId !== current.portfolioId) {
    return `请先打开目标作品集（${shortId(job.target.portfolioId)}），并切换到目标作品（${shortId(job.target.projectId)}）。`
  }
  if (job.target.projectId !== current.projectId) return `请先切换到目标作品：${targetLabel(job)}。`
  if (!job.result?.applied && job.target.conversationId && job.target.conversationId !== current.conversationId) {
    return `请先打开原 Agent 对话（${shortId(job.target.conversationId)}）。`
  }
  if (!job.result?.applied && job.target.chapterId && job.target.chapterId !== current.chapterId) {
    return `请先选中任务章节（${shortId(job.target.chapterId)}）。`
  }
  return ''
})
const currentStep = computed(() => {
  const events = selectedJob.value?.events ?? []
  const latest = events[events.length - 1]
  return latest?.state === 'running' ? latest : undefined
})
const logs = computed(() => {
  const query = logQuery.value.trim().toLocaleLowerCase()
  return props.jobs.flatMap((job) => job.events.map((event) => ({ ...event, jobId: job.id, jobTitle: jobTitle(job) })))
    .filter((event) => !query || `${event.title} ${event.detail ?? ''} ${event.jobTitle}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence)
})
const canSubmit = computed(() => Boolean(props.currentTarget?.portfolioId && props.currentTarget.projectId && prompt.value.trim() && !submittingRequestId.value))

watch(() => props.currentJobId, (id) => {
  if (id && !props.jobs.some((job) => job.id === selectedJobId.value)) selectedJobId.value = id
}, { immediate: true })

watch(() => [selectedJob.value?.id, selectedPlan.value?.id, selectedPlan.value?.operations.length] as const, () => {
  selectedPlanOperations.value = selectedPlan.value
    ? selectedPlan.value.operations.map((_, index) => index)
    : []
}, { immediate: true })

watch(() => props.jobs.map((job) => job.id), (ids) => {
  if (ids.includes(selectedJobId.value)) return
  selectedJobId.value = props.currentJobId || props.jobs[props.jobs.length - 1]?.id || ''
}, { immediate: true })

watch(() => [targetKey.value, props.providers.map((provider) => provider.id)] as const, ([, ids]) => {
  if (providerId.value && !ids.includes(providerId.value)) providerId.value = ''
}, { immediate: true })

watch(() => props.jobs, (jobs) => {
  for (const pendingDraft of consoleDrafts.values()) {
    if (!pendingDraft.pendingRequestId) continue
    const accepted = jobs.find((job) => job.requestId === pendingDraft.pendingRequestId)
    if (!accepted) continue
    if (pendingDraft === draft.value) selectedJobId.value = accepted.id
    pendingDraft.pendingRequestId = ''
    if (pendingDraft.prompt.trim() === pendingDraft.submittedPrompt) pendingDraft.prompt = ''
  }
}, { deep: true, immediate: true })

watch(() => props.error, (failure) => {
  if (failure && consolePanelUi.lastSubmissionTargetKey) {
    getConsoleDraft(consolePanelUi.lastSubmissionTargetKey).pendingRequestId = ''
  }
}, { immediate: true })

function submitTask() {
  const target = props.currentTarget
  if (!target || !canSubmit.value) return
  submittingRequestId.value = crypto.randomUUID()
  draft.value.submittedPrompt = prompt.value.trim()
  consolePanelUi.lastSubmissionTargetKey = targetKey.value
  emit('submit', {
    kind: 'agent',
    ...target,
    prompt: draft.value.submittedPrompt,
    providerId: providerId.value || undefined,
    mode: mode.value,
    requestId: submittingRequestId.value,
  })
  tab.value = 'tasks'
}

function selectJob(id: string) {
  selectedJobId.value = id
  tab.value = 'tasks'
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function jobTitle(job: ConsoleJob) {
  return job.kind === 'save' ? '保存作品集' : job.prompt?.trim() || '执行修改计划'
}

function shortId(id: string) {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

function targetLabel(job: ConsoleJob) {
  if (job.target.portfolioId === props.currentTarget?.portfolioId) {
    return props.projectNames[job.target.projectId] || `作品 ${shortId(job.target.projectId)}`
  }
  return `其他作品集 · 作品 ${shortId(job.target.projectId)}`
}

function targetDetails(job: ConsoleJob) {
  return `作品集：${job.target.portfolioId}\n作品：${job.target.projectId}${job.target.chapterId ? `\n章节：${job.target.chapterId}` : ''}${job.target.conversationId ? `\nAgent 对话：${job.target.conversationId}` : ''}`
}

function providerLabel(job: ConsoleJob) {
  const id = job.result?.providerId || job.providerId
  if (!id) return '默认 API'
  return props.providers.find((provider) => provider.id === id)?.title || '指定 API'
}

function toggleAllPlanOperations() {
  if (!selectedPlan.value) return
  selectedPlanOperations.value = allPlanOperationsSelected.value
    ? []
    : selectedPlan.value.operations.map((_, index) => index)
}

function togglePlanOperation(index: number, checked: boolean) {
  if (!selectedPlan.value) return
  selectedPlanOperations.value = checked
    ? selectOperationIndexesWithDependencies(selectedPlan.value.operations, [...selectedPlanOperations.value, index])
    : removeOperationIndexesWithDependents(selectedPlan.value.operations, selectedPlanOperations.value, index)
}

function handlePlanCheckbox(index: number, event: Event) {
  togglePlanOperation(index, (event.target as HTMLInputElement).checked)
}

function formatReviewValue(value: unknown) {
  if (value === undefined) return '未设置'
  if (value === '') return '空字符串'
  if (Array.isArray(value)) return value.length ? value.join('、') : '空数组'
  if (typeof value === 'object' && value !== null) {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

function reviewStatusLabel(status: AgentPlanFieldDiff['status']) {
  return status === 'added' ? '新增' : status === 'changed' ? '修改' : status === 'cleared' ? '清空' : status === 'removed' ? '移除' : '锁定'
}

function perform(action: ConsoleActionInput['action']) {
  if (!selectedJob.value) return
  if (action === 'approve' && !selectedPlanCount.value) return
  emit('action', {
    jobId: selectedJob.value.id,
    action,
    ...(action === 'approve' ? { operationIndexes: [...selectedPlanOperations.value].sort((a, b) => a - b) } : {}),
  })
}

function eventIsRunning(sequence: number) {
  return Boolean(selectedJob.value && ['running', 'saving'].includes(selectedJob.value.status) && currentStep.value?.sequence === sequence)
}

async function copyEndpoint() {
  if (!props.sessionEndpoint) return
  try {
    await navigator.clipboard.writeText(props.sessionEndpoint)
    if (disposed) return
    clipboardStatus.value = '已复制'
  } catch {
    if (disposed) return
    clipboardStatus.value = '复制失败'
  }
  if (clipboardTimer) clearTimeout(clipboardTimer)
  clipboardTimer = setTimeout(() => { clipboardStatus.value = '' }, 2000)
}

onBeforeUnmount(() => {
  disposed = true
  if (clipboardTimer) clearTimeout(clipboardTimer)
})
</script>

<template>
  <section :class="['console-panel', { 'console-panel-dock': props.dock }]">
    <header class="console-panel-header">
      <div class="console-panel-heading"><Terminal :size="17" /><strong>控制台</strong><button v-if="props.busy && props.currentJobId" class="console-current-state" type="button" title="查看当前执行任务" @click="selectJob(props.currentJobId)"><LoaderCircle :size="12" class="spin" />正在执行</button><span v-else-if="props.busy" class="console-current-state"><LoaderCircle :size="12" class="spin" />正在执行</span></div>
      <nav class="console-main-tabs" aria-label="控制台页面">
        <button type="button" :class="{ selected: tab === 'terminal' }" :aria-pressed="tab === 'terminal'" @click="tab = 'terminal'"><Terminal :size="14" />终端</button>
        <button type="button" :class="{ selected: tab === 'tasks' }" :aria-pressed="tab === 'tasks'" @click="tab = 'tasks'"><ClipboardList :size="14" />创作任务<span v-if="activeCount" class="console-count">{{ activeCount }}</span></button>
        <button type="button" :class="{ selected: tab === 'logs' }" :aria-pressed="tab === 'logs'" @click="tab = 'logs'"><FileText :size="14" />运行日志</button>
      </nav>
      <div class="console-panel-window-actions">
        <button v-if="props.dock" class="console-icon-button" type="button" title="打开完整控制台" aria-label="打开完整控制台" @click="emit('maximize')"><Maximize2 :size="14" /></button>
        <button class="console-icon-button" type="button" :title="props.dock ? '收起控制台' : '返回写作'" :aria-label="props.dock ? '收起控制台' : '返回写作'" @click="emit('hide')"><Minus v-if="props.dock" :size="16" /><X v-else :size="16" /></button>
      </div>
    </header>
    <div v-if="props.error" class="console-error" role="alert">{{ props.error }}</div>
    <div class="console-panel-body">
      <TerminalView v-show="tab === 'terminal'" :visible="tab === 'terminal'" />
      <section v-show="tab === 'tasks'" class="console-task-page">
        <div class="console-task-layout">
          <aside class="console-job-sidebar">
            <div class="console-list-toolbar"><span>{{ props.jobs.length }} 个任务</span><select v-model="statusFilter" aria-label="筛选任务状态"><option value="all">全部</option><option value="active">进行中</option><option value="done">已结束</option></select></div>
            <div class="console-job-list">
              <button v-for="job in filteredJobs" :key="job.id" type="button" :class="['console-job-card', { selected: selectedJobId === job.id }]" @click="selectJob(job.id)">
                <div><span :class="['console-status', `console-status-${job.status}`]">{{ statusLabels[job.status] }}</span><small>{{ formatDate(job.createdAt) }}</small></div>
                <strong>{{ jobTitle(job) }}</strong>
                <span>{{ providerLabel(job) }} · {{ job.mode === 'inspiration' ? '灵感' : '写作' }}</span>
                <span class="console-job-target" :title="targetDetails(job)">目标：{{ targetLabel(job) }}</span>
              </button>
              <div v-if="!filteredJobs.length" class="console-empty"><ClipboardList :size="24" /><span>{{ props.jobs.length ? '此筛选下没有任务' : '暂无创作任务' }}</span></div>
            </div>
          </aside>
          <section v-if="selectedJob" class="console-job-detail">
            <header class="console-job-detail-header"><div><span :class="['console-status', `console-status-${selectedJob.status}`]">{{ statusLabels[selectedJob.status] }}</span><small>{{ formatDate(selectedJob.createdAt) }}</small></div><h3>{{ jobTitle(selectedJob) }}</h3><p class="console-job-target" :title="targetDetails(selectedJob)">目标：{{ targetLabel(selectedJob) }}<span v-if="selectedJob.target.chapterId"> · 章节 {{ shortId(selectedJob.target.chapterId) }}</span><span v-if="selectedJob.target.conversationId"> · 对话 {{ shortId(selectedJob.target.conversationId) }}</span></p></header>
            <p v-if="targetMismatch && ['queued', 'paused', 'failed', 'awaiting_approval'].includes(selectedJob.status)" class="console-target-note" role="status">{{ targetMismatch }}</p>
            <p v-if="currentStep && ['running', 'saving'].includes(selectedJob.status)" class="console-current-step"><LoaderCircle class="spin" :size="14" />{{ currentStep.title }}<span v-if="currentStep.detail">{{ currentStep.detail }}</span></p>
            <p v-if="selectedJob.error || selectedJob.result?.error" class="console-error" role="alert">{{ selectedJob.error || selectedJob.result?.error }}</p>
            <p v-if="selectedJob.result?.message" class="console-result-message">{{ selectedJob.result.message }}</p>
            <div v-if="selectedJob.status === 'awaiting_approval' && selectedJob.result?.plan" class="console-plan-preview">
              <div class="console-section-label"><ClipboardList :size="14" /><strong>待确认的修改</strong><span>{{ selectedJob.result.plan.operations.length }} 项操作</span></div>
              <p v-if="selectedJob.result.plan.message">{{ selectedJob.result.plan.message }}</p>
              <div class="console-plan-selection-toolbar">
                <span>选择要执行的操作：{{ selectedPlanCount }} / {{ selectedJob.result.plan.operations.length }}<small>依赖项会自动一并勾选</small></span>
                <button class="console-plan-selection-toggle" type="button" :disabled="props.busy" @click="toggleAllPlanOperations">{{ allPlanOperationsSelected ? '取消全选' : '全选' }}</button>
              </div>
              <div v-if="selectedJob.result.plan.reviews?.length" class="console-plan-reviews">
                <article v-for="review in selectedJob.result.plan.reviews" :key="review.operationIndex" class="console-plan-review">
                  <div class="console-plan-review-head"><label class="console-plan-review-check"><input type="checkbox" :checked="selectedPlanOperations.includes(review.operationIndex)" :disabled="props.busy" @change="togglePlanOperation(review.operationIndex, ($event.target as HTMLInputElement).checked)" /><span class="console-plan-review-kind">{{ review.kind === 'create' ? '创建' : review.kind === 'update' ? '更新' : review.kind === 'delete' ? '删除' : review.kind === 'move' ? '移动' : review.kind === 'append' ? '追加' : '检索' }}</span></label><strong>{{ review.title }}</strong></div>
                  <div v-if="review.target || review.targetPath" class="console-plan-review-target">
                    目标：{{ review.target || '新建' }}
                    <small v-if="review.targetPath">（作品集 {{ review.targetPath.portfolioId || '当前' }} / 作品 {{ review.targetPath.projectId || '当前' }}<template v-if="review.targetPath.collection"> / {{ review.targetPath.collection }}</template>）</small>
                  </div>
                  <ul class="console-plan-diff-list">
                    <li v-for="diff in review.diffs" :key="`${review.operationIndex}-${diff.field}`" :class="[`console-plan-diff-${diff.status}`]">
                      <span class="console-plan-diff-field">{{ diff.field }}</span>
                      <span class="console-plan-diff-status">{{ reviewStatusLabel(diff.status) }}</span>
                      <span class="console-plan-diff-values"><code>{{ formatReviewValue(diff.before) }}</code><span aria-hidden="true">→</span><code>{{ formatReviewValue(diff.after) }}</code></span>
                    </li>
                    <li v-if="!review.diffs.length" class="console-plan-diff-empty">无可展示的字段变化</li>
                  </ul>
                </article>
              </div>
              <ol v-else><li v-for="(description, index) in selectedJob.result.plan.descriptions" :key="index"><label class="console-plan-review-check"><input type="checkbox" :checked="selectedPlanOperations.includes(index)" :disabled="props.busy" @change="handlePlanCheckbox(index, $event)" /><span>{{ description }}</span></label></li></ol>
              <details><summary><ChevronDown :size="12" />查看操作结构</summary><pre>{{ JSON.stringify(selectedJob.result.plan.operations, null, 2) }}</pre></details>
              <p v-if="!selectedPlanCount" class="console-plan-selection-warning" role="status">至少选择一项修改后才能执行。</p>
            </div>
            <ul v-if="selectedJob.result?.changes?.length" class="console-change-list"><li v-for="(change, index) in selectedJob.result.changes" :key="index"><Check :size="13" /><span>{{ change }}</span></li></ul>
            <div class="console-job-action-bar">
              <button v-if="selectedJob.status === 'awaiting_approval'" class="console-button console-primary-button" type="button" :disabled="props.busy || Boolean(targetMismatch) || !selectedPlanCount" :title="targetMismatch || (!selectedPlanCount ? '至少选择一项修改' : '执行已预览的修改计划')" @click="perform('approve')"><Check :size="14" />确认执行{{ selectedPlan && selectedPlanCount < selectedPlan.operations.length ? `（${selectedPlanCount} 项）` : '' }}</button>
              <button v-if="['queued', 'running', 'awaiting_approval'].includes(selectedJob.status)" class="console-button" type="button" @click="perform('pause')"><Pause :size="13" />暂停</button>
              <button v-if="selectedJob.status === 'paused' || selectedJob.status === 'failed'" class="console-button" type="button" :disabled="Boolean(targetMismatch)" :title="targetMismatch || undefined" @click="perform('resume')"><Play :size="13" />{{ selectedJob.status === 'paused' ? '继续' : selectedJob.result?.applied ? '重试保存' : '重试' }}</button>
              <button v-if="!finishedStatuses.includes(selectedJob.status) && selectedJob.status !== 'saving'" class="console-button console-danger-button" type="button" @click="perform('cancel')"><Square :size="12" />取消</button>
            </div>
            <div class="console-section-label"><strong>执行记录</strong></div>
            <ol class="console-event-list">
              <li v-for="event in selectedJob.events" :key="event.sequence" :class="`console-event-${event.state === 'running' && !eventIsRunning(event.sequence) ? 'queued' : event.state}`"><span class="console-event-icon"><LoaderCircle v-if="event.state === 'running' && eventIsRunning(event.sequence)" :size="13" class="spin" /><Check v-else-if="event.state === 'done'" :size="13" /><X v-else-if="event.state === 'error'" :size="13" /><span v-else class="console-event-dot" /></span><div><strong>{{ event.title }}</strong><p v-if="event.detail">{{ event.detail }}</p></div><time>{{ formatTime(event.createdAt) }}</time></li>
            </ol>
            <p v-if="!selectedJob.events.length" class="console-muted">任务尚未开始。</p>
          </section>
          <div v-else class="console-empty"><ClipboardList :size="27" /><strong>选择任务查看执行过程</strong><span>修改计划会在此展示，确认后才写入作品。</span></div>
        </div>
        <form class="console-task-composer" @submit.prevent="submitTask">
          <textarea v-model="prompt" rows="2" :disabled="!props.currentTarget || Boolean(submittingRequestId)" aria-label="创作任务要求" placeholder="输入创作任务，例如：创建三位角色，并为他们安排第一卷的冲突…" @keydown.ctrl.enter.prevent="submitTask" @keydown.meta.enter.prevent="submitTask" />
          <div class="console-composer-footer">
            <label><span>API</span><select v-model="providerId" aria-label="创作任务 API"><option value="">默认 API</option><option v-for="provider in props.providers" :key="provider.id" :value="provider.id">{{ provider.title }}{{ provider.model ? ` · ${provider.model}` : '' }}</option></select></label>
            <label><span>模式</span><select v-model="mode" aria-label="创作任务模式"><option value="writing">写作</option><option value="inspiration">灵感</option></select></label>
            <span class="console-composer-hint">{{ props.currentTarget ? 'Ctrl / Cmd + Enter' : '请先打开作品集和作品' }}</span>
            <button class="console-button console-primary-button" type="submit" :disabled="!canSubmit"><LoaderCircle v-if="submittingRequestId" :size="14" class="spin" /><Send v-else :size="14" />{{ submittingRequestId ? '提交中' : props.busy ? '加入队列' : '提交任务' }}</button>
          </div>
        </form>
      </section>
      <section v-show="tab === 'logs'" class="console-logs-page">
        <header class="console-log-toolbar"><span>任务与保存的执行记录</span><input v-model="logQuery" type="search" aria-label="搜索运行日志" placeholder="搜索记录…" /><small>{{ logs.length }} 条</small></header>
        <div class="console-log-list">
          <button v-for="event in logs" :key="`${event.jobId}-${event.sequence}`" type="button" :class="['console-log-entry', `console-event-${event.state}`]" @click="selectJob(event.jobId)">
            <time>{{ formatDate(event.createdAt) }}</time><span class="console-log-state">{{ event.state === 'error' ? '失败' : event.state === 'done' ? '完成' : event.state === 'running' ? '开始' : '等待' }}</span><div><strong>{{ event.title }}</strong><p v-if="event.detail">{{ event.detail }}</p><small>{{ event.jobTitle }}</small></div>
          </button>
          <div v-if="!logs.length" class="console-empty"><FileText :size="27" /><span>{{ logQuery ? '没有匹配的记录' : '暂无运行记录' }}</span></div>
        </div>
        <footer class="console-log-footer">终端输出仅显示在终端内。</footer>
      </section>
    </div>
    <footer v-if="props.sessionEndpoint && !props.dock" class="console-endpoint"><span>CLI 连接文件</span><code :title="props.sessionEndpoint">{{ props.sessionEndpoint }}</code><button class="console-icon-button" type="button" title="复制 CLI 连接文件路径" aria-label="复制 CLI 连接文件路径" @click="copyEndpoint"><Copy :size="13" /></button><span v-if="clipboardStatus" role="status">{{ clipboardStatus }}</span></footer>
  </section>
</template>
