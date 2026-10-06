export type McpStatus = 'disabled' | 'starting' | 'running' | 'error'

/** Public service metadata. Authentication secrets never appear in this shape. */
export type McpInfo = {
  enabled: boolean
  port: number
  url: string
  status: McpStatus
  error?: string
  tokenConfigured: boolean
  /** Recent authenticated MCP activity, independent of service enablement. */
  connected: boolean
  connectionCount: number
  lastSeenAt: number | null
  connectionLeaseMs: number
}

export type McpConfiguration = {
  enabled: boolean
  port: number
}

/**
 * These exports require an explicit user copy action. A token export's
 * text is the raw token; callers must not retain it in reactive state.
 */
export type McpConnectionConfigKind = 'generic' | 'stdio' | 'codex' | 'claude' | 'dsh' | 'zcode' | 'token'
export type McpConnectionConfig = {
  text: string
  /** Public environment-variable name referenced by a client configuration. */
  envVar?: string
}

export type DesktopMcpBridge = {
  info(): Promise<McpInfo>
  configure(configuration: McpConfiguration): Promise<McpInfo>
  regenerateToken(): Promise<McpInfo>
  connectionConfig(kind: McpConnectionConfigKind): Promise<McpConnectionConfig>
  onUpdate(callback: (info: McpInfo) => void): () => void
}
