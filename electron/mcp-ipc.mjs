import { mcpConnectionConfig } from './mcp-connection-config.mjs'

export function installMcpIpc({ ipcMain, getWindow, manager, scriptPath, settingsPath, nodeCommand }) {
  const handlers = {
    info: () => manager.info(),
    configure: (configuration) => manager.configure(configuration),
    'regenerate-token': () => manager.regenerateToken(),
    'connection-config': (kind) => mcpConnectionConfig({
      kind, credentials: manager.connectionCredentials(), scriptPath, settingsPath, nodeCommand,
    }),
  }
  for (const [name, handle] of Object.entries(handlers)) {
    ipcMain.handle(`mcp:${name}`, (event, input) => {
      const window = getWindow()
      if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('该窗口无权管理 MCP 连接。')
      }
      return handle(input)
    })
  }
  return {
    dispose() {
      for (const name of Object.keys(handlers)) ipcMain.removeHandler(`mcp:${name}`)
    },
  }
}
