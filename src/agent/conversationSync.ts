import type { AgentActivityEvent, AgentConversation, AgentMessage } from '../types'
import { agentPersistedMessageLimit, normalizeAgentMessages } from './chatHistory.ts'

function sameActivities(left: AgentActivityEvent[] | undefined, right: AgentActivityEvent[] | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every((event, index) => {
    const other = right[index]
    return event.id === other.id
      && event.title === other.title
      && event.detail === other.detail
      && event.createdAt === other.createdAt
      && event.state === other.state
      && event.kind === other.kind
  })
}

function sameMessages(left: AgentMessage[], right: AgentMessage[]): boolean {
  if (left.length !== right.length) return false
  return left.every((message, index) => {
    const other = right[index]
    return message.id === other.id
      && message.role === other.role
      && message.content === other.content
      && message.createdAt === other.createdAt
      && sameActivities(message.activities, other.activities)
  })
}

/**
 * Synchronize the persisted conversation without creating a new reactive
 * mutation for an unchanged transcript. Save/close snapshot builders call this
 * repeatedly; replacing an equal message array would trigger the deep dirty
 * watcher and make a completed save appear to contain newer unsaved changes.
 *
 * Normalization creates independent message/activity records for real updates.
 * An empty transcript retains its timestamp rather than advancing on every
 * snapshot; only recorded message and activity times can advance it here.
 */
export function syncAgentConversationMessages(
  conversation: Pick<AgentConversation, 'messages' | 'updatedAt'>,
  messages: unknown,
  limit = agentPersistedMessageLimit,
): boolean {
  const normalized = normalizeAgentMessages(messages, limit)
  let updatedAt = conversation.updatedAt
  for (const message of normalized) {
    updatedAt = Math.max(updatedAt, message.createdAt)
    for (const activity of message.activities ?? []) {
      updatedAt = Math.max(updatedAt, activity.createdAt)
    }
  }

  let changed = false
  if (!sameMessages(conversation.messages, normalized)) {
    conversation.messages = normalized
    changed = true
  }
  if (conversation.updatedAt !== updatedAt) {
    conversation.updatedAt = updatedAt
    changed = true
  }
  return changed
}
