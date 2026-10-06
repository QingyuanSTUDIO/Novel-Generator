import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { agentPersistedMessageLimit, normalizeAgentMessages } from '../agent/chatHistory.ts'
import { syncAgentConversationMessages } from '../agent/conversationSync.ts'
import type { AgentConversation, AgentMessage } from '../types.ts'

type AgentConversationOptions = {
  welcomeContent: string
  canSwitch: Readonly<Ref<boolean> | ComputedRef<boolean>>
  persist: () => void
  resetView?: () => void
  confirmDelete?: (message: string) => boolean
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return JSON.parse(JSON.stringify(messages)) as AgentMessage[]
}

/**
 * Owns the Agent transcript and conversation list, while the page keeps
 * request execution, activities, plans and history in its own domain.
 *
 * Conversation persistence is deliberately synchronized through the existing
 * conversationSync helper so repeated project snapshots do not create
 * reactive writes for unchanged transcripts.
 */
export function useAgentConversations(options: AgentConversationOptions) {
  const agentMessages = ref<AgentMessage[]>([])
  const agentConversations = ref<AgentConversation[]>([])
  const activeAgentConversationId = ref('')

  function createAgentConversation(title = '新对话', messages?: AgentMessage[], id?: string): AgentConversation {
    const now = Date.now()
    const normalizedMessages = normalizeAgentMessages(messages, agentPersistedMessageLimit)
    return {
      id: id || `agent-conversation-${now}-${Math.random().toString(36).slice(2, 8)}`,
      title: title.trim() || '新对话',
      createdAt: now,
      updatedAt: now,
      messages: normalizedMessages.length
        ? normalizedMessages
        : [{ id: `agent-welcome-${now}`, role: 'assistant', content: options.welcomeContent, createdAt: now }],
    }
  }

  function normalizeAgentConversation(value: unknown, index: number): AgentConversation | null {
    if (!value || typeof value !== 'object') return null
    const item = value as Partial<AgentConversation>
    if (typeof item.id !== 'string' || !item.id.trim()) return null
    const messages = normalizeAgentMessages(item.messages, agentPersistedMessageLimit)
    const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt
    return {
      id: item.id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : (index === 0 ? '历史对话' : '新对话'),
      createdAt,
      updatedAt,
      archived: item.archived === true,
      archivedAt: typeof item.archivedAt === 'number' && Number.isFinite(item.archivedAt) ? item.archivedAt : undefined,
      messages: messages.length
        ? messages
        : [{ id: `agent-welcome-${item.id}`, role: 'assistant', content: options.welcomeContent, createdAt: createdAt || Date.now() }],
    }
  }

  function normalizeAgentConversations(value: unknown, legacyMessages?: unknown): AgentConversation[] {
    const seen = new Set<string>()
    const conversations = Array.isArray(value)
      ? value.map(normalizeAgentConversation).filter((conversation): conversation is AgentConversation => {
        if (!conversation || seen.has(conversation.id)) return false
        seen.add(conversation.id)
        return true
      })
      : []
    if (conversations.length) return conversations
    const legacy = normalizeAgentMessages(legacyMessages, agentPersistedMessageLimit)
    return [createAgentConversation(legacy.length ? '历史对话' : '新对话', legacy)]
  }

  function restoreAgentConversationState(value: unknown, activeId?: unknown, legacyMessages?: unknown) {
    let conversations = normalizeAgentConversations(value, legacyMessages)
    let selected = typeof activeId === 'string'
      ? conversations.find((conversation) => conversation.id === activeId && conversation.archived !== true)
      : undefined
    const firstActive = conversations.find((conversation) => conversation.archived !== true)
    if (!selected) selected = firstActive
    if (!selected) {
      const fresh = createAgentConversation()
      conversations = [fresh, ...conversations]
      selected = fresh
    }
    agentConversations.value = conversations
    activeAgentConversationId.value = selected.id
    agentMessages.value = normalizeAgentMessages(selected.messages, agentPersistedMessageLimit)
    if (!agentMessages.value.length) {
      agentMessages.value = [{ id: `agent-welcome-${Date.now()}`, role: 'assistant', content: options.welcomeContent, createdAt: Date.now() }]
    }
  }

  function syncActiveAgentConversation() {
    if (!agentConversations.value.length || !activeAgentConversationId.value) {
      restoreAgentConversationState(undefined, undefined, agentMessages.value)
      return
    }
    const current = agentConversations.value.find((conversation) => conversation.id === activeAgentConversationId.value)
    if (!current) {
      restoreAgentConversationState(agentConversations.value, undefined, agentMessages.value)
      return
    }
    syncAgentConversationMessages(current, agentMessages.value, agentPersistedMessageLimit)
  }

  function agentConversationTitle(prompt: string) {
    const compact = prompt.replace(/\s+/g, ' ').trim()
    if (!compact) return '新对话'
    return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact
  }

  const agentConversationList = computed(() => [...agentConversations.value]
    .filter((conversation) => conversation.archived !== true)
    .sort((left, right) => right.updatedAt - left.updatedAt))
  const archivedAgentConversationList = computed(() => [...agentConversations.value]
    .filter((conversation) => conversation.archived === true)
    .sort((left, right) => (right.archivedAt ?? right.updatedAt) - (left.archivedAt ?? left.updatedAt)))

  function resetView() {
    options.resetView?.()
  }

  function activateAgentConversation(conversation: AgentConversation) {
    conversation.archived = false
    conversation.archivedAt = undefined
    activeAgentConversationId.value = conversation.id
    agentMessages.value = cloneMessages(normalizeAgentMessages(conversation.messages, agentPersistedMessageLimit))
    if (!agentMessages.value.length) {
      agentMessages.value = [{ id: `agent-welcome-${Date.now()}`, role: 'assistant', content: options.welcomeContent, createdAt: Date.now() }]
    }
    resetView()
  }

  function createNewAgentConversation() {
    if (!options.canSwitch.value) return
    syncActiveAgentConversation()
    const conversation = createAgentConversation()
    agentConversations.value.unshift(conversation)
    activateAgentConversation(conversation)
    options.persist()
  }

  function selectAgentConversation(id: string) {
    if (!options.canSwitch.value || id === activeAgentConversationId.value) return
    const conversation = agentConversations.value.find((item) => item.id === id)
    if (!conversation || conversation.archived) return
    syncActiveAgentConversation()
    activateAgentConversation(conversation)
    options.persist()
  }

  function renameAgentConversation(id: string, nextTitle?: string) {
    if (!options.canSwitch.value) return
    const conversation = agentConversations.value.find((item) => item.id === id && item.archived !== true)
    if (!conversation) return
    const requestedTitle = nextTitle ?? (typeof window !== 'undefined' ? window.prompt('重命名对话', conversation.title) : null)
    const title = requestedTitle?.trim()
    if (!title || title === conversation.title) return
    conversation.title = title.slice(0, 80)
    conversation.updatedAt = Date.now()
    options.persist()
  }

  function archiveAgentConversation(id: string) {
    if (!options.canSwitch.value) return
    const conversation = agentConversations.value.find((item) => item.id === id && item.archived !== true)
    if (!conversation) return
    syncActiveAgentConversation()
    const wasActive = conversation.id === activeAgentConversationId.value
    const archivedAt = Date.now()
    conversation.archived = true
    conversation.archivedAt = archivedAt
    conversation.updatedAt = archivedAt
    if (wasActive) {
      const next = agentConversationList.value[0]
      if (next) activateAgentConversation(next)
      else {
        const fresh = createAgentConversation()
        agentConversations.value.unshift(fresh)
        activateAgentConversation(fresh)
      }
    }
    options.persist()
  }

  function deleteAgentConversation(id: string) {
    if (!options.canSwitch.value) return
    const conversation = agentConversations.value.find((item) => item.id === id && item.archived !== true)
    if (!conversation) return
    const confirm = options.confirmDelete ?? ((message: string) => typeof window !== 'undefined' && window.confirm(message))
    if (!confirm(`确定永久删除对话“${conversation.title}”吗？\n删除后聊天记录无法恢复。`)) return
    syncActiveAgentConversation()
    const wasActive = conversation.id === activeAgentConversationId.value
    agentConversations.value = agentConversations.value.filter((item) => item.id !== id)
    if (wasActive) {
      const next = agentConversationList.value[0]
      if (next) activateAgentConversation(next)
      else {
        const fresh = createAgentConversation()
        agentConversations.value.unshift(fresh)
        activateAgentConversation(fresh)
      }
    }
    options.persist()
  }

  function restoreArchivedAgentConversation(id: string) {
    const conversation = agentConversations.value.find((item) => item.id === id && item.archived === true)
    if (!conversation) return
    conversation.archived = false
    conversation.archivedAt = undefined
    conversation.updatedAt = Date.now()
    options.persist()
  }

  function deleteArchivedAgentConversation(id: string) {
    const conversation = agentConversations.value.find((item) => item.id === id && item.archived === true)
    if (!conversation) return
    const confirm = options.confirmDelete ?? ((message: string) => typeof window !== 'undefined' && window.confirm(message))
    if (!confirm(`确定永久删除已归档对话“${conversation.title}”吗？\n删除后聊天记录无法恢复。`)) return
    agentConversations.value = agentConversations.value.filter((item) => item.id !== id)
    options.persist()
  }

  restoreAgentConversationState(undefined, undefined, agentMessages.value)

  return {
    agentMessages,
    agentConversations,
    activeAgentConversationId,
    agentConversationList,
    archivedAgentConversationList,
    createAgentConversation,
    normalizeAgentConversation,
    normalizeAgentConversations,
    restoreAgentConversationState,
    syncActiveAgentConversation,
    agentConversationTitle,
    activateAgentConversation,
    createNewAgentConversation,
    selectAgentConversation,
    renameAgentConversation,
    archiveAgentConversation,
    deleteAgentConversation,
    restoreArchivedAgentConversation,
    deleteArchivedAgentConversation,
  }
}
