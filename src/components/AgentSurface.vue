<script setup lang="ts">
import AgentPanel from './AgentPanel.vue'
import type {
  AgentActivityEvent,
  AgentConversation,
  AgentHistoryEntry,
  AgentLiveResponse,
  AgentMessage,
  AgentMode,
  AgentPlan,
  AgentQuickAction,
  AgentTask,
  Resource,
} from '../types'
import type { ContextBudgetReport } from '../api/contextBudget'
import type { ChatUsage } from '../api/chatUsage'
import type { ContextPreviewSnapshot } from '../context/contextPreview'

const props = defineProps<{
  messages: AgentMessage[]
  conversations: AgentConversation[]
  activeConversationId: string
  canSwitchConversation: boolean
  tasks: AgentTask[]
  activities?: AgentActivityEvent[]
  liveResponse?: AgentLiveResponse | null
  budget?: ContextBudgetReport | null
  usage?: ChatUsage | null
  metricsStatus?: 'preview' | 'running' | 'done' | 'error'
  contextBudgetLabel?: string
  contextBudgetError?: string
  contextPreview?: ContextPreviewSnapshot | null
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
  approvePlan: [operationIndexes: number[]]
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
</script>

<template>
  <AgentPanel
    v-bind="props"
    @send="emit('send', $event)"
    @quick="emit('quick', $event)"
    @close="emit('close')"
    @approve-plan="emit('approvePlan', $event)"
    @reject-plan="emit('rejectPlan')"
    @undo-history="emit('undoHistory', $event)"
    @reset-tasks="emit('resetTasks')"
    @select-provider="emit('selectProvider', $event)"
    @select-mode="emit('selectMode', $event)"
    @new-conversation="emit('newConversation')"
    @select-conversation="emit('selectConversation', $event)"
    @rename-conversation="emit('renameConversation', $event)"
    @archive-conversation="emit('archiveConversation', $event)"
    @delete-conversation="emit('deleteConversation', $event)"
    @draft-changed="emit('draftChanged', $event)"
  />
</template>
