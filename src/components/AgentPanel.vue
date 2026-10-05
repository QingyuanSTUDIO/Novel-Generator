<script setup lang="ts">
import { Archive, Check, Circle, ClipboardCheck, Feather, History, Lightbulb, LoaderCircle, MessageSquare, MoreVertical, PenLine, Plus, RotateCcw, Send, Sparkles, Terminal, Trash2, X } from 'lucide-vue-next'
import { computed, nextTick, ref, watch } from 'vue'
import AgentActivityLog from './AgentActivityLog.vue'
import ContextUsageIndicator from './ContextUsageIndicator.vue'
import type { ContextBudgetReport } from '../api/contextBudget'
import type { ChatUsage } from '../api/chatUsage'
import type { AgentActivityEvent, AgentConversation, AgentHistoryEntry, AgentLiveResponse, AgentMessage, AgentMode, AgentPlan, AgentQuickAction, AgentTask, Resource } from '../types'

const props = defineProps<{
  messages: AgentMessage[]
  conversations: AgentConversation[]
  activeConversationId: string
  canSwitchConversation: boolean
  tasks: AgentTask[]
  /** Recent human-readable events, newest first. */
  activities?: AgentActivityEvent[]
  liveResponse?: AgentLiveResponse | null
  budget?: ContextBudgetReport | null
  usage?: ChatUsage | null
  metricsStatus?: 'preview' | 'running' | 'done' | 'error'
  contextBudgetLabel?: string
  contextBudgetError?: string
  quickActions: AgentQuickAction[]
  busy: boolean
  modelLabel: string
  mode: AgentMode
  providers: Resource[]
  selectedProviderId?: string
  standalone?: boolean
  pendingPlan?: AgentPlan | null
  history: AgentHistoryEntry[]
  undoableHistoryId?: string
}>()

const emit = defineEmits<{
  send: [prompt: string]
  quick: [prompt: string]
  close: []
  approvePlan: []
  rejectPlan: []
  undoHistory: [id: string]
  resetTasks: []
  selectProvider: [id: string]
  selectMode: [mode: AgentMode]
  newConversation: []
  selectConversation: [id: string]
  renameConversation: [id: string]
  archiveConversation: [id: string]
  deleteConversation: [id: string]
  draftChanged: [value: string]
}>()

const draft = ref('')
watch(draft, (value) => emit('draftChanged', value), { immediate: true })
const openConversationMenuId = ref<string | null>(null)
const messagesElement = ref<HTMLElement | null>(null)
const followLatestMessage = ref(true)
const hasLiveResponse = computed(() => Boolean(props.liveResponse && (props.liveResponse.streaming || props.liveResponse.message)))
const executionLabel = computed(() => {
  if (props.busy) return '执行中'
  if (props.tasks.some((task) => task.state === 'error')) return '出错'
  if (props.pendingPlan) return '待确认'
  return props.tasks.some((task) => task.id !== 'agent-ready') ? '已完成' : '已就绪'
})

function handleMessageScroll() {
  const element = messagesElement.value
  if (!element) return
  followLatestMessage.value = element.scrollHeight - element.scrollTop - element.clientHeight < 80
}

watch(() => [
  props.messages.length,
  props.messages[props.messages.length - 1]?.content,
  props.liveResponse?.message,
  props.liveResponse?.receivedChars,
  props.activities?.length,
  props.pendingPlan?.id,
], async () => {
  if (!followLatestMessage.value) return
  await nextTick()
  if (!followLatestMessage.value) return
  const element = messagesElement.value
  if (element) element.scrollTop = element.scrollHeight
})

watch(() => props.activeConversationId, async () => {
  followLatestMessage.value = true
  await nextTick()
  const element = messagesElement.value
  if (element) element.scrollTop = element.scrollHeight
}, { immediate: true })

function submit() {
  const prompt = draft.value.trim()
  if (!prompt || props.busy || props.pendingPlan) return
  draft.value = ''
  emit('send', prompt)
}

function useQuickAction(prompt: string) {
  if (props.busy || props.pendingPlan) return
  emit('quick', prompt)
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatConversationTime(timestamp: number) {
  return new Date(timestamp).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + formatTime(timestamp)
}

function conversationPreview(conversation: AgentConversation) {
  const latest = [...conversation.messages].reverse().find((message) => message.role === 'user' && message.content.trim())
  return latest?.content.replace(/\s+/g, ' ').trim().slice(0, 34) || '尚未发送消息'
}

function toggleConversationMenu(id: string) {
  if (!props.canSwitchConversation) return
  openConversationMenuId.value = openConversationMenuId.value === id ? null : id
}

function emitConversationAction(event: 'renameConversation' | 'archiveConversation' | 'deleteConversation', id: string) {
  openConversationMenuId.value = null
  if (event === 'renameConversation') emit('renameConversation', id)
  else if (event === 'archiveConversation') emit('archiveConversation', id)
  else emit('deleteConversation', id)
}

</script>

<template>
  <section :class="['agent-surface', { 'agent-surface-standalone': props.standalone }]" @click="openConversationMenuId = null">
    <header class="agent-head">
      <div class="agent-heading"><span class="eyebrow">AI Agent</span><h2>叙事代理</h2><p>{{ props.modelLabel }}</p></div>
      <div class="agent-head-actions">
        <div class="agent-mode-picker" role="group" aria-label="Agent 模式">
          <button type="button" :class="['agent-mode-option', { selected: props.mode === 'writing' }]" :aria-pressed="props.mode === 'writing'" title="回复和创作内容遵循启用的文风规则" @click="emit('selectMode', 'writing')"><Feather :size="13" />写作</button>
          <button type="button" :class="['agent-mode-option', { selected: props.mode === 'inspiration' }]" :aria-pressed="props.mode === 'inspiration'" title="自由讨论剧情，不注入文风规则；仍检索作品资料" @click="emit('selectMode', 'inspiration')"><Lightbulb :size="13" />灵感</button>
        </div>
        <label class="agent-provider-select"><span>API 配置</span><select :value="props.selectedProviderId ?? ''" aria-label="选择 Agent API 配置" @change="emit('selectProvider', ($event.target as HTMLSelectElement).value)"><option v-if="!props.providers.length" value="">未配置 API</option><option v-for="provider in props.providers" :key="provider.id" :value="provider.id">{{ provider.title }}{{ provider.fields['模型'] ? ` · ${provider.fields['模型']}` : '' }}</option></select></label>
        <button class="icon-button" type="button" :title="props.standalone ? '返回写作' : '关闭 Agent'" :aria-label="props.standalone ? '返回写作' : '关闭 Agent'" @click="emit('close')"><X :size="18" /></button>
      </div>
    </header>

    <div class="agent-layout">
      <aside class="agent-conversations-panel">
        <div class="agent-conversations-head">
          <div class="agent-panel-label"><MessageSquare :size="15" /><span>对话</span></div>
          <button class="agent-new-conversation" type="button" :disabled="!props.canSwitchConversation" title="新建对话" aria-label="新建对话" @click="emit('newConversation')"><Plus :size="14" /><span>新建</span></button>
        </div>
        <div class="agent-conversation-list">
          <article
            v-for="conversation in props.conversations"
            :key="conversation.id"
            :class="['agent-conversation-item', { selected: conversation.id === props.activeConversationId }]"
            @pointerleave="openConversationMenuId === conversation.id && (openConversationMenuId = null)"
          >
            <button class="agent-conversation-select" type="button" :disabled="!props.canSwitchConversation" @click="openConversationMenuId = null; emit('selectConversation', conversation.id)">
              <strong>{{ conversation.title }}</strong>
              <small>{{ formatConversationTime(conversation.updatedAt) }} · {{ conversation.messages.length }} 条消息</small>
              <span>{{ conversationPreview(conversation) }}</span>
            </button>
            <button class="agent-conversation-menu-trigger" type="button" :disabled="!props.canSwitchConversation" title="对话操作" :aria-label="`管理对话：${conversation.title}`" @click.stop="toggleConversationMenu(conversation.id)"><MoreVertical :size="15" /></button>
            <div v-if="openConversationMenuId === conversation.id" class="agent-conversation-menu" role="menu" @click.stop>
              <button type="button" role="menuitem" @click="emitConversationAction('renameConversation', conversation.id)"><PenLine :size="13" />重命名</button>
              <button type="button" role="menuitem" @click="emitConversationAction('archiveConversation', conversation.id)"><Archive :size="13" />归档对话</button>
              <button class="danger" type="button" role="menuitem" @click="emitConversationAction('deleteConversation', conversation.id)"><Trash2 :size="13" />删除对话</button>
            </div>
          </article>
          <div v-if="!props.conversations.length" class="agent-conversations-empty">暂无对话</div>
        </div>
        <div class="agent-conversation-note">每个作品的对话会独立保存。新建对话后，当前上下文资料仍会按作品设置读取。</div>
      </aside>

      <section class="agent-chat-panel">
        <div ref="messagesElement" class="agent-messages" aria-live="polite" @scroll="handleMessageScroll">
          <article v-for="message in props.messages" :key="message.id" :class="['agent-message', `agent-message-${message.role}`]">
            <div class="agent-message-meta">{{ message.role === 'user' ? '你' : message.role === 'system' ? '系统' : 'Agent' }}</div>
            <p>{{ message.content }}</p>
            <AgentActivityLog v-if="message.activities?.length" :activities="message.activities" title="本次活动" />
          </article>
          <article v-if="hasLiveResponse && props.liveResponse" class="agent-message agent-message-assistant agent-message-live">
            <div class="agent-message-live-meta"><span><Sparkles :size="12" />Agent {{ props.liveResponse.streaming ? '正在回复' : '正在整理回复' }}</span><small v-if="props.liveResponse.receivedChars">{{ props.liveResponse.receivedChars.toLocaleString() }} 字符已收到</small></div>
            <p v-if="props.liveResponse.message" class="agent-live-response">{{ props.liveResponse.message }}<span v-if="props.liveResponse.streaming" class="agent-typing-cursor" aria-hidden="true"></span></p>
            <div v-else class="agent-stream-wait"><LoaderCircle class="spin" :size="13" /><span>{{ props.liveResponse.receivedChars ? '已收到响应，正在整理操作计划…' : '正在等待模型回复…' }}</span></div>
            <AgentActivityLog v-if="props.activities?.length" :activities="props.activities" title="正在进行的活动" />
          </article>
          <AgentActivityLog v-else-if="props.busy && props.activities?.length" :activities="props.activities" title="正在进行的活动" />
          <article v-if="props.pendingPlan" class="agent-plan-card">
            <div class="agent-plan-head"><div class="agent-panel-label"><ClipboardCheck :size="15" /><span>待确认修改</span></div><strong>尚未写入作品</strong></div>
            <p class="agent-plan-message">{{ props.pendingPlan.message }}</p>
            <ul class="agent-plan-list"><li v-for="(description, index) in props.pendingPlan.descriptions" :key="index">{{ description }}</li></ul>
            <div class="agent-plan-actions"><button class="button secondary" type="button" :disabled="props.busy" @click="emit('rejectPlan')"><X :size="14" />取消修改</button><button class="button primary" type="button" :disabled="props.busy" @click="emit('approvePlan')"><Check :size="14" />确认执行</button></div>
          </article>
          <div v-if="props.busy && !hasLiveResponse" class="agent-thinking"><LoaderCircle class="spin" :size="15" /><span>{{ props.tasks.find((task) => task.state === 'running')?.detail || 'Agent 正在执行当前任务…' }}</span></div>
        </div>
        <form class="agent-composer" @submit.prevent="submit">
          <div class="agent-quick-toolbar">
            <div class="agent-panel-label"><Sparkles :size="14" /><span>快捷操作</span></div>
            <div class="agent-quick-actions">
              <button v-for="action in props.quickActions" :key="action.id" class="agent-quick-action" type="button" :disabled="props.busy || Boolean(props.pendingPlan)" @click="useQuickAction(action.prompt)">{{ action.label }}</button>
            </div>
          </div>
          <textarea v-model="draft" rows="3" :disabled="props.busy || Boolean(props.pendingPlan)" placeholder="告诉 Agent 要创建、修改或整理什么…" @keydown.ctrl.enter.prevent="submit" @keydown.meta.enter.prevent="submit" />
          <div class="agent-composer-footer">
            <div class="agent-composer-meta">
              <span>{{ props.pendingPlan ? '请先确认或取消当前修改' : 'Ctrl / Cmd + Enter 发送' }}</span>
              <ContextUsageIndicator v-if="props.budget !== undefined || props.usage !== undefined" :budget="props.budget ?? null" :usage="props.usage" :status="props.metricsStatus" :budget-label="props.contextBudgetLabel" />
              <span v-if="props.contextBudgetError" class="agent-context-error" role="status">{{ props.contextBudgetError }}</span>
            </div>
            <button class="button primary" type="submit" :disabled="props.busy || Boolean(props.pendingPlan) || !draft.trim()"><Send :size="15" />发送</button>
          </div>
        </form>
      </section>

      <aside class="agent-activity-panel">
        <div class="agent-activity-head"><div class="agent-panel-label"><Circle :size="13" /><span>执行状态</span></div><div class="agent-activity-actions"><strong>{{ executionLabel }}</strong><button v-if="!props.busy && props.tasks.some((task) => task.state === 'error')" class="icon-button agent-reset-tasks" type="button" title="清除本次执行状态" aria-label="清除本次执行状态" @click="emit('resetTasks')"><RotateCcw :size="14" /></button></div></div>
        <ol class="agent-task-list">
          <li v-for="task in props.tasks" :key="task.id" :class="[`agent-task-${task.state}`]">
            <span class="agent-task-icon"><LoaderCircle v-if="task.state === 'running'" class="spin" :size="14" /><Check v-else-if="task.state === 'done'" :size="14" /><X v-else-if="task.state === 'error'" :size="14" /><Circle v-else :size="12" /></span>
            <span><strong>{{ task.label }}</strong><small v-if="task.detail">{{ task.detail }}</small></span>
          </li>
        </ol>
        <div class="agent-activity-log">
          <div class="agent-activity-log-head">
            <div class="agent-panel-label"><Terminal :size="14" /><span>AI 刚刚做了什么</span></div>
            <button v-if="props.activities?.length && !props.busy && !props.pendingPlan" class="agent-activity-clear" type="button" title="清除本次活动记录" aria-label="清除本次活动记录" @click="emit('resetTasks')"><RotateCcw :size="12" /></button>
          </div>
          <div v-if="!props.activities?.length" class="agent-activity-empty">等待 Agent 开始工作</div>
          <AgentActivityLog v-else :activities="props.activities || []" :collapsed="false" compact title="活动记录" />
        </div>
        <div class="agent-history">
          <div class="agent-panel-label"><History :size="14" /><span>修改记录</span></div>
          <div v-if="!props.history.length" class="agent-history-empty">暂无 Agent 修改</div>
          <article v-for="entry in props.history" :key="entry.id" class="agent-history-item">
            <strong>{{ entry.summary }}</strong>
            <small>{{ formatTime(entry.createdAt) }} · {{ entry.status === 'undone' ? '已撤销' : '已执行' }}</small>
            <ul class="agent-history-changes"><li v-for="change in entry.changes" :key="change">{{ change }}</li></ul>
            <button v-if="entry.status === 'applied'" class="agent-history-undo" type="button" :disabled="props.busy || entry.id !== props.undoableHistoryId" :title="entry.id === props.undoableHistoryId ? '撤销这次 Agent 修改' : '只能撤销最近一次未撤销修改'" @click="emit('undoHistory', entry.id)"><RotateCcw :size="12" />撤销</button>
          </article>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.agent-composer-meta { min-width: 0; flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 3px 8px; }
.agent-composer-meta > span { min-width: 0; line-height: 1.5; }
.agent-composer-meta > .agent-context-error { flex-basis: 100%; color: var(--theme-danger); font-size: 10px; }
.agent-composer-footer > .button { flex: 0 0 auto; }
.agent-message-live { max-width: 100%; border-color: color-mix(in srgb, var(--theme-button) 38%, var(--theme-border)); }
.agent-message-live-meta { display: flex; align-items: center; justify-content: space-between; gap: 9px; margin-bottom: 7px; color: var(--theme-muted); font-size: 10px; }
.agent-message-live-meta > span { display: inline-flex; align-items: center; gap: 5px; }
.agent-message-live-meta > span svg { color: var(--theme-button); }
.agent-message-live-meta small { color: var(--theme-muted); font-size: 9px; font-variant-numeric: tabular-nums; }
.agent-live-response { color: var(--theme-font); overflow-wrap: anywhere; white-space: pre-wrap; }
.agent-typing-cursor { display: inline-block; width: 2px; height: 1.05em; margin-left: 3px; color: var(--theme-button); background: currentColor; vertical-align: -.13em; animation: agent-cursor-blink 1s step-end infinite; }
.agent-stream-wait { display: flex; align-items: center; gap: 6px; padding: 3px 0; color: var(--theme-muted); font-size: 11px; }
.agent-stream-wait svg { color: var(--theme-button); }
.agent-surface .agent-panel-label { color: var(--theme-font); }
.agent-surface .agent-panel-label svg { color: var(--theme-button); }
.agent-surface .agent-task-done .agent-task-icon { color: var(--theme-success, var(--theme-button)); }
.agent-surface .agent-new-conversation, .agent-surface .agent-history-undo { color: var(--theme-button); }
@keyframes agent-cursor-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .agent-typing-cursor { animation: none; }
}
</style>
