import type { AgentActivityEvent, AgentMessage } from '../types'
import type { ChatMessage } from '../api/chat.ts'
import { prepareContextBudget, type ContextBudgetSettings } from '../api/contextBudget.ts'
import { defaultModelSettings } from '../api/modelSettings.ts'

/**
 * The Agent UI can contain status/error messages that are useful to the
 * author, but they are not part of the model conversation. Keep those out of
 * the API request while retaining them in the persisted transcript.
 */
/** Legacy explicit message-count limit; new calls use the selected model budget. */
export const agentConversationMessageLimit = 24
/**
 * Persistence stores the author's transcript, not just the model's memory.
 * Request token trimming must never become permanent deletion on save/reload.
 */
export const agentPersistedMessageLimit = Number.POSITIVE_INFINITY
export const agentActivityEventLimit = 80

export function normalizeAgentActivities(value: unknown, limit = agentActivityEventLimit): AgentActivityEvent[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is AgentActivityEvent => Boolean(
      entry && typeof entry === 'object'
      && typeof entry.id === 'string'
      && typeof entry.title === 'string'
      && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
      && ['running', 'done', 'error'].includes(entry.state),
    ))
    .slice(0, Math.max(0, limit))
    .map((entry) => ({
      id: entry.id,
      title: entry.title.slice(0, 300),
      ...(typeof entry.detail === 'string' ? { detail: entry.detail.slice(0, 2000) } : {}),
      createdAt: entry.createdAt,
      state: entry.state,
      ...(entry.kind && ['status', 'model', 'tool', 'stream', 'result', 'error'].includes(entry.kind) ? { kind: entry.kind } : {}),
    }))
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<AgentMessage>
  return (
    typeof message.id === 'string'
    && (message.role === 'user' || message.role === 'assistant' || message.role === 'system')
    && typeof message.content === 'string'
    && typeof message.createdAt === 'number'
    && Number.isFinite(message.createdAt)
  )
}

export function normalizeAgentMessages(value: unknown, limit = agentPersistedMessageLimit): AgentMessage[] {
  if (!Array.isArray(value)) return []
  const safeLimit = limit === Number.POSITIVE_INFINITY
    ? limit
    : Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  if (safeLimit === 0) return []
  const normalized = value
    .filter(isAgentMessage)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(Array.isArray(message.activities) ? { activities: normalizeAgentActivities(message.activities) } : {}),
    }))
  return safeLimit === Number.POSITIVE_INFINITY ? normalized : normalized.slice(-safeLimit)
}

/**
 * Collect raw role/content messages for an eventual combined context budget.
 * System messages are UI
 * status entries, so only user/assistant turns are included. The current
 * prompt is already pushed to the UI before requestAgentResponse runs; append
 * it only when a caller invokes this helper without doing that first.
 *
 * No history is trimmed here. Combine this result with protocol/world-book
 * system messages before prepareContextBudget so the UI reports every removed
 * history message accurately and systems get their share of the same budget.
 */
export function collectAgentConversation(
  messages: AgentMessage[],
  currentPrompt: string,
): ChatMessage[] {
  const turns = normalizeAgentMessages(messages)
    .filter((message) => message.role !== 'system' && message.content.trim())
  // The UI starts with an assistant welcome message, which is useful on
  // screen but has no value in the model context. Remove leading assistant
  // turns before applying the history budget so the budget remains stable.
  while (turns[0]?.role === 'assistant') turns.shift()
  const history: ChatMessage[] = turns
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }))

  const prompt = currentPrompt
  const last = history[history.length - 1]
  if (prompt.trim() && (!last || last.role !== 'user' || last.content !== prompt)) {
    history.push({ role: 'user', content: prompt })
  }
  return history
}

/**
 * Convenience wrapper for callers budgeting only a standalone conversation.
 * Combined Agent requests should collectAgentConversation first and budget the
 * entire request once. Numeric limits remain available for legacy callers.
 */
export function buildAgentConversation(
  messages: AgentMessage[],
  currentPrompt: string,
  limitOrSettings: number | ContextBudgetSettings = defaultModelSettings,
): ChatMessage[] {
  const history = collectAgentConversation(messages, currentPrompt)
  if (typeof limitOrSettings === 'number') {
    const safeLimit = Number.isFinite(limitOrSettings) ? Math.max(0, Math.floor(limitOrSettings)) : 0
    return safeLimit > 0 ? history.slice(-safeLimit) : []
  }
  return prepareContextBudget(history, limitOrSettings).messages
}
