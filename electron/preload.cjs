const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopStorage', {
  onFlushRequest(callback) {
    const listener = (_event, requestId) => callback(requestId)
    ipcRenderer.on('desktop:flush-request', listener)
    return () => ipcRenderer.removeListener('desktop:flush-request', listener)
  },
  onFlushCancelled(callback) {
    const listener = () => callback()
    ipcRenderer.on('desktop:flush-cancelled', listener)
    return () => ipcRenderer.removeListener('desktop:flush-cancelled', listener)
  },
  onFlushAbandoned(callback) {
    const listener = () => callback()
    ipcRenderer.on('desktop:flush-abandoned', listener)
    return () => ipcRenderer.removeListener('desktop:flush-abandoned', listener)
  },
  completeFlush(requestId, result) {
    ipcRenderer.send('desktop:flush-complete', {
      requestId,
      saved: result?.saved === true,
      canceled: result?.canceled === true,
      ...(typeof result?.error === 'string' ? { error: result.error } : {}),
    })
  },
})

contextBridge.exposeInMainWorld('desktopFile', {
  open() {
    return ipcRenderer.invoke('qy:open')
  },
  openPath(filePath) {
    return ipcRenderer.invoke('qy:open-path', filePath)
  },
  save(document, currentPath, options = {}) {
    return ipcRenderer.invoke('qy:save', { document, currentPath, ...options })
  },
  recent() {
    return ipcRenderer.invoke('qy:recent')
  },
  removeRecent(filePath) {
    return ipcRenderer.invoke('qy:remove-recent', filePath)
  },
  directories: () => ipcRenderer.invoke('qy:directories'),
  backups: (filePath) => ipcRenderer.invoke('qy:backups', filePath),
  openDirectory: (kind) => ipcRenderer.invoke('qy:open-directory', kind),
  restoreBackup: (input) => ipcRenderer.invoke('qy:restore-backup', input),
})

contextBridge.exposeInMainWorld('desktopWindow', {
  minimize() {
    ipcRenderer.send('desktop-window:minimize')
  },
  toggleMaximize() {
    ipcRenderer.send('desktop-window:toggle-maximize')
  },
  close() {
    ipcRenderer.send('desktop-window:close')
  },
  isMaximized() {
    return ipcRenderer.invoke('desktop-window:is-maximized')
  },
  onMaximizeState(callback) {
    const listener = (_event, maximized) => callback(maximized === true)
    ipcRenderer.on('desktop-window:maximized', listener)
    return () => ipcRenderer.removeListener('desktop-window:maximized', listener)
  },
})

// Keep terminal and task transport narrow. The page receives neither Node.js
// access nor the local HTTP service's capability token.
contextBridge.exposeInMainWorld('desktopConsole', {
  info: () => ipcRenderer.invoke('console:info'),
  list: () => ipcRenderer.invoke('console:list'),
  submit: (input) => ipcRenderer.invoke('console:submit', input),
  action: (input) => ipcRenderer.invoke('console:action', input),
  report: (jobId, event) => ipcRenderer.invoke('console:report', { jobId, event }),
  checkpoint: (jobId, result) => ipcRenderer.invoke('console:checkpoint', { jobId, result }),
  suspend: () => ipcRenderer.invoke('console:suspend'),
  onUpdate(callback) {
    const listener = (_event, jobs) => callback(jobs)
    ipcRenderer.on('console:update', listener)
    return () => ipcRenderer.removeListener('console:update', listener)
  },
  onCommand(callback) {
    const listener = (_event, requestId, command) => callback(requestId, command)
    ipcRenderer.on('console:execute', listener)
    return () => ipcRenderer.removeListener('console:execute', listener)
  },
  completeCommand: (requestId, reply) => ipcRenderer.send('console:execute-complete', { requestId, ...reply }),
  onInspect(callback) {
    const listener = (_event, requestId, query) => callback(requestId, query)
    ipcRenderer.on('console:inspect', listener)
    return () => ipcRenderer.removeListener('console:inspect', listener)
  },
  completeInspect: (requestId, reply) => ipcRenderer.send('console:inspect-complete', { requestId, ...reply }),
})

contextBridge.exposeInMainWorld('desktopTerminal', {
  list: () => ipcRenderer.invoke('terminal:list'),
  create: (input) => ipcRenderer.invoke('terminal:create', input),
  snapshot: (sessionId) => ipcRenderer.invoke('terminal:snapshot', { sessionId }),
  write: (input) => ipcRenderer.invoke('terminal:input', input),
  resize: (input) => ipcRenderer.invoke('terminal:resize', input),
  stop: (sessionId) => ipcRenderer.invoke('terminal:stop', { sessionId }),
  ack: (input) => ipcRenderer.invoke('terminal:ack', input),
  onEvent(callback) {
    const listener = (_event, event) => callback(event)
    ipcRenderer.on('terminal:event', listener)
    return () => ipcRenderer.removeListener('terminal:event', listener)
  },
})

contextBridge.exposeInMainWorld('desktopMcp', {
  info: () => ipcRenderer.invoke('mcp:info'),
  configure: (configuration) => ipcRenderer.invoke('mcp:configure', configuration),
  regenerateToken: () => ipcRenderer.invoke('mcp:regenerate-token'),
  connectionConfig: (kind) => ipcRenderer.invoke('mcp:connection-config', kind),
  onUpdate(callback) {
    const listener = (_event, info) => callback(info)
    ipcRenderer.on('mcp:update', listener)
    return () => ipcRenderer.removeListener('mcp:update', listener)
  },
})
