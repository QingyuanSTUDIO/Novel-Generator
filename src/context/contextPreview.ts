import { estimateMessageTokens, estimateTextTokens, type ContextBudgetReport } from '../api/contextBudget.ts'
import type { ChatMessage } from '../api/chat.ts'
import type { RetrievalMatch, RetrievalSkip } from './retrieval.ts'

export type ContextPreviewPurpose = 'writing' | 'agent' | 'worldEngine'

export type ContextPreviewResource = {
  collection: string
  id: string
  title: string
  depth: number
  matchType: 'direct' | 'recursive'
  matchedKeys: string[]
  estimatedTokens: number
  injectionOrder?: number
}

export type ContextPreviewSkipped = {
  collection: string
  id: string
  title: string
  depth: number
  matchedKeys: string[]
  matchType: 'direct' | 'recursive'
  reason: string
  estimatedTokens: number
}

export type ContextPreviewSkippedInput = RetrievalSkip | ContextPreviewSkipped

export type ContextPreviewPart = {
  collection: string
  label: string
  rank: number
  estimatedTokens: number
  text?: string
}

export type ContextPreviewMessage = {
  role: ChatMessage['role']
  estimatedTokens: number
  preview: string
}

export type ContextPreviewSnapshot = {
  purpose: ContextPreviewPurpose
  query?: string
  resources: ContextPreviewResource[]
  skipped: ContextPreviewSkipped[]
  parts: ContextPreviewPart[]
  messages: ContextPreviewMessage[]
  retrievalTokens: number
  estimatedInputTokens: number
  text?: string
  budget?: ContextBudgetReport | null
}

function previewText(value: string, limit = 240) {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

export function estimatePreviewPartTokens(text: string) {
  return Math.max(0, estimateTextTokens(text))
}

export function createContextPreviewSnapshot(options: {
  purpose: ContextPreviewPurpose
  query?: string
  matches: readonly RetrievalMatch[]
  skipped?: readonly ContextPreviewSkippedInput[]
  parts: readonly ContextPreviewPart[]
  messages: readonly ChatMessage[]
  text?: string
  budget?: ContextBudgetReport | null
}): ContextPreviewSnapshot {
  const resources = options.matches.map((match) => ({
    collection: match.collection,
    id: match.resource.id,
    title: match.resource.title,
    depth: match.depth,
    matchType: match.matchType,
    matchedKeys: [...match.matchedKeys],
    estimatedTokens: match.estimatedTokens ?? estimatePreviewPartTokens(match.resource.summary),
    ...(typeof (match.resource.retrieval?.injectionOrder ?? match.resource.injectionOrder) === 'number'
      ? { injectionOrder: match.resource.retrieval?.injectionOrder ?? match.resource.injectionOrder }
      : {}),
  }))
  const skipped = (options.skipped ?? []).map((entry) => ({
    collection: entry.collection,
    id: 'resource' in entry ? entry.resource.id : entry.id,
    title: 'resource' in entry ? entry.resource.title : entry.title,
    depth: entry.depth,
    matchedKeys: [...entry.matchedKeys],
    matchType: entry.matchType,
    reason: entry.reason,
    estimatedTokens: entry.estimatedTokens,
  }))
  const messages = options.messages.map((message) => ({
    role: message.role,
    estimatedTokens: estimateTextTokens(message.content) + 6,
    preview: previewText(message.content),
  }))
  return {
    purpose: options.purpose,
    ...(options.query ? { query: options.query } : {}),
    resources,
    skipped,
    parts: options.parts.map((part) => ({ ...part, ...(part.text ? { text: part.text } : {}) })),
    messages,
    retrievalTokens: resources.reduce((sum, resource) => sum + resource.estimatedTokens, 0),
    estimatedInputTokens: estimateMessageTokens(options.messages),
    ...(options.text ? { text: options.text } : {}),
    budget: options.budget ?? null,
  }
}

export function withContextPreviewMessages(snapshot: ContextPreviewSnapshot, messages: readonly ChatMessage[], budget?: ContextBudgetReport | null) {
  return createContextPreviewSnapshot({
    ...snapshot,
    matches: snapshot.resources.map((resource) => ({
      collection: resource.collection as RetrievalMatch['collection'],
      resource: { id: resource.id, title: resource.title, tag: '', summary: '', fields: {} },
      sourceIndex: 0,
      depth: resource.depth,
      matchedKeys: resource.matchedKeys,
      matchType: resource.matchType,
      estimatedTokens: resource.estimatedTokens,
    })),
    skipped: snapshot.skipped,
    parts: snapshot.parts,
    messages,
    budget,
    text: snapshot.text,
  })
}
