import type {
  ConsoleCommand, ConsoleEvent, ConsoleInspectQuery, ConsoleJob, ConsoleResult,
  ConsoleSubmission, TerminalEvent, TerminalSession, TerminalSnapshot,
} from './console/types'
import type { DesktopMcpBridge } from './mcp/types'
import type {
  DesktopPortfolioFileSettingsBridge, DesktopQyOpenResult, DesktopQySaveOptions, DesktopQySaveResult,
} from './files/types'

export {}

declare global {
  interface Window {
    desktopMcp?: DesktopMcpBridge
    desktopWindow?: {
      minimize(): void
      toggleMaximize(): void
      close(): void
      isMaximized(): Promise<boolean>
      onMaximizeState(callback: (maximized: boolean) => void): () => void
    }
    desktopConsole?: {
      info(): Promise<{ endpointPath: string; cliPath: string }>
      list(): Promise<ConsoleJob[]>
      submit(input: ConsoleSubmission): Promise<ConsoleJob>
      action(input: { jobId: string; action: 'approve' | 'pause' | 'resume' | 'cancel' }): Promise<ConsoleJob>
      report(jobId: string, event: Omit<ConsoleEvent, 'sequence' | 'createdAt'>): Promise<void>
      checkpoint(jobId: string, result: ConsoleResult): Promise<void>
      suspend(): Promise<void>
      onUpdate(callback: (jobs: ConsoleJob[]) => void): () => void
      onCommand(callback: (requestId: string, command: ConsoleCommand) => void): () => void
      completeCommand(requestId: string, reply: { result?: ConsoleResult; error?: string }): void
      onInspect(callback: (requestId: string, query: ConsoleInspectQuery) => void): () => void
      completeInspect(requestId: string, reply: { value?: unknown; error?: string }): void
    }
    desktopTerminal?: {
      list(): Promise<TerminalSession[]>
      create(input: { shell: TerminalSession['shell']; cwd?: string; cols?: number; rows?: number }): Promise<TerminalSession>
      snapshot(sessionId: string): Promise<TerminalSnapshot>
      write(input: { sessionId: string; data: string; binary?: boolean }): Promise<void>
      resize(input: { sessionId: string; cols: number; rows: number }): Promise<void>
      stop(sessionId: string): Promise<void>
      ack(input: { sessionId: string; sequence: number }): Promise<void>
      onEvent(callback: (event: TerminalEvent) => void): () => void
    }
    desktopStorage?: {
      onFlushRequest(callback: (requestId: number) => void): () => void
      onFlushCancelled(callback: () => void): () => void
      onFlushAbandoned(callback: () => void): () => void
      completeFlush(requestId: number, result: { saved: boolean; canceled?: boolean; error?: string }): void
    }
    desktopFile?: DesktopPortfolioFileSettingsBridge & {
      open(): Promise<DesktopQyOpenResult>
      openPath(path: string): Promise<DesktopQyOpenResult>
      save(document: unknown, currentPath?: string, options?: DesktopQySaveOptions): Promise<DesktopQySaveResult>
      restoreBackup(input: { sourcePath: string; backupId: string }): Promise<DesktopQyOpenResult>
      recent(): Promise<{ path: string; title: string; updatedAt: number }[]>
      removeRecent(path: string): Promise<{ ok: boolean }>
    }
  }
}
