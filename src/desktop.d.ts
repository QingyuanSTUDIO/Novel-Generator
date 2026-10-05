export {}

declare global {
  interface Window {
    desktopWindow?: {
      minimize(): void
      toggleMaximize(): void
      close(): void
      isMaximized(): Promise<boolean>
      onMaximizeState(callback: (maximized: boolean) => void): () => void
    }
    desktopStorage?: {
      onFlushRequest(callback: (requestId: number) => void): () => void
      onFlushCancelled(callback: () => void): () => void
      onFlushAbandoned(callback: () => void): () => void
      completeFlush(requestId: number, result: { saved: boolean; error?: string }): void
    }
    desktopFile?: {
      open(): Promise<{ canceled: boolean; path?: string; document?: unknown; error?: string }>
      openPath(path: string): Promise<{ canceled: boolean; path?: string; document?: unknown; error?: string }>
      save(document: unknown, currentPath?: string, options?: { saveAs?: boolean; backupCount?: number }): Promise<{ canceled: boolean; path?: string; title?: string; error?: string }>
      recent(): Promise<{ path: string; title: string; updatedAt: number }[]>
      removeRecent(path: string): Promise<{ ok: boolean }>
    }
  }
}
