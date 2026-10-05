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
    ipcRenderer.send('desktop:flush-complete', { requestId, ...result })
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
