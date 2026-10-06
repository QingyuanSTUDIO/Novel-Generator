import { reactive } from 'vue'
import type { AgentMode } from '../types'
import type { TerminalSession } from './types'

// The full page and writing dock are two views of the same console. Keep only
// their transient UI state here; processes and queued tasks belong to main.
// Nothing in this module is written to disk or included in a .qy file.
export const consolePanelUi = reactive({
  tab: 'terminal' as 'terminal' | 'tasks' | 'logs',
  selectedJobId: '',
  statusFilter: 'all' as 'all' | 'active' | 'done',
  logQuery: '',
  lastSubmissionTargetKey: '',
})

export const terminalUi = reactive({
  activeId: '',
  selectedShell: 'powershell' as TerminalSession['shell'],
})

export type ConsoleDraft = {
  prompt: string
  providerId: string
  mode: AgentMode
  pendingRequestId: string
  submittedPrompt: string
}

export const consoleDrafts = reactive(new Map<string, ConsoleDraft>())

export function getConsoleDraft(targetKey: string): ConsoleDraft {
  if (!consoleDrafts.has(targetKey)) {
    consoleDrafts.set(targetKey, {
      prompt: '', providerId: '', mode: 'writing',
      pendingRequestId: '', submittedPrompt: '',
    })
  }
  return consoleDrafts.get(targetKey)!
}
