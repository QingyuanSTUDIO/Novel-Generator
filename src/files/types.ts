export type PortfolioDirectories = {
  saveDirectory: string
  backupDirectory: string
  error?: string
}

/** Metadata only. Backup content stays in the desktop file service. */
export type PortfolioBackup = {
  id: string
  path: string
  title: string
  createdAt: number
  size: number
  valid: boolean
  error?: string
  projectCount?: number
}

export type PortfolioBackupsResult = PortfolioDirectories & {
  entries: PortfolioBackup[]
}

/** A changed disk revision must be resolved before overwriting the file. */
export type FileRevisionConflict = {
  path: string
  expectedRevision: string | null
  actualRevision: string | null
  kind: 'modified' | 'missing' | 'created'
}

export type DesktopQyOpenResult = {
  canceled: boolean
  path?: string
  title?: string
  document?: unknown
  /** Content-addressed character image payloads from the adjacent .assets directory. */
  attachments?: Array<{
    ref: { assetId: string; mimeType: string; byteLength: number; sha256?: string }
    payloadBase64: string
  }>
  revision?: string
  error?: string
}

export type DesktopQySaveResult = {
  canceled: boolean
  path?: string
  title?: string
  revision?: string
  conflict?: FileRevisionConflict
  error?: string
}

export type DesktopQySaveOptions = {
  saveAs?: boolean
  backupCount?: number
  expectedRevision?: string | null
  /** New image bytes are persisted beside the .qy before the document write. */
  attachments?: Array<{
    ref: { assetId: string; mimeType: string; byteLength: number; sha256?: string }
    payloadBase64: string
  }>
}

/** The settings page uses metadata and folder actions, never file contents. */
export type DesktopPortfolioFileSettingsBridge = {
  directories(): Promise<PortfolioDirectories>
  backups(filePath: string): Promise<PortfolioBackupsResult>
  openDirectory(kind: 'save' | 'backup'): Promise<{ ok: boolean; error?: string }>
}
