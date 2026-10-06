import type { AgentPlan, AgentMode } from '../types'
import type { AgentResponse } from '../agent/schema'

export type ConsoleJobStatus = 'queued' | 'running' | 'awaiting_approval' | 'saving' | 'completed' | 'failed' | 'paused' | 'canceled'
export type ConsoleEvent = {
  sequence: number
  createdAt: number
  title: string
  detail?: string
  state: 'queued' | 'running' | 'done' | 'error'
}
export type ConsoleResult = {
  status: 'awaiting_approval' | 'completed' | 'failed'
  message?: string
  plan?: AgentPlan
  changes?: string[]
  error?: string
  applied?: boolean
  afterFingerprint?: string
  /** Preset resolved when a default-API task first runs, without credentials. */
  providerId?: string
}
export type ConsoleJob = {
  id: string
  kind: 'agent' | 'plan' | 'save'
  target: { portfolioId: string; projectId: string; chapterId?: string; conversationId?: string }
  prompt: string
  providerId?: string
  mode: AgentMode
  response?: AgentResponse
  requestId?: string
  status: ConsoleJobStatus
  createdAt: number
  updatedAt: number
  events: ConsoleEvent[]
  result?: ConsoleResult
  error?: string
}
export type ConsoleSubmission = {
  kind: ConsoleJob['kind']
  portfolioId: string
  projectId: string
  chapterId?: string
  conversationId?: string
  prompt?: string
  providerId?: string
  mode?: AgentMode
  response?: AgentResponse
  requestId?: string
}
export type ConsoleCommand = {
  action: 'run' | 'approve' | 'cancel'
  job: ConsoleJob
  /** Optional renderer-side operation selection for an approval. */
  operationIndexes?: number[]
}
export type ConsoleActionInput = {
  jobId: string
  action: 'approve' | 'pause' | 'resume' | 'cancel'
  /** Only used by the renderer to select operations before approval. */
  operationIndexes?: number[]
}
export type ConsoleInspectQuery = {
  kind: 'status' | 'workspace' | 'context' | 'providers' | 'schema'
  projectId?: string
  collection?: string
  query?: string
}
export type TerminalSession = {
  id: string
  title: string
  shell: 'powershell' | 'cmd' | 'codex'
  cwd: string
  status: 'starting' | 'running' | 'exited' | 'error'
  createdAt: number
  exitCode?: number
  error?: string
}
export type TerminalEvent = {
  sessionId: string
  type: 'data' | 'exit' | 'status'
  status?: TerminalSession['status']
  sequence?: number
  data?: string
  exitCode?: number
  error?: string
}
export type TerminalSnapshot = {
  session: TerminalSession
  output: string
  sequence: number
}
