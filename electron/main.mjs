import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLocalApiServer } from '../server/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = process.env.NOVEL_PROJECT_ROOT || path.resolve(__dirname, '..')
const appUrl = process.env.ELECTRON_APP_URL || ''
let proxyServer

// Chromium can otherwise leave a stale cache lock behind after an interrupted
// launch. Keep the cache in the app's writable data directory and disable the
// two caches that are not useful for this local, file-based editor.
const userDataPath = app.getPath('userData')
const sessionDataPath = path.join(userDataPath, 'session-data')
const cachePath = path.join(sessionDataPath, 'cache')
const startupLogPath = path.join(userDataPath, 'startup.log')
const qyWorksPath = path.join(userDataPath, '保存')
const qyBackupsPath = path.join(userDataPath, '备份')
const qyRecentPath = path.join(userDataPath, 'qy-recent.json')
// A detached launch can outlive the terminal that spawned it. In that case
// inherited stdout/stderr may be closed while Electron is still starting;
// writing a diagnostic with console.error would raise an uncaught EPIPE and
// show a misleading "JavaScript error in the main process" dialog.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', () => {})
}
function logStartup(message, error) {
  const detail = error instanceof Error ? `${message}: ${error.stack || error.message}` : `${message}${error ? `: ${String(error)}` : ''}`
  const line = `[${new Date().toISOString()}] ${detail}\n`
  try {
    fs.appendFileSync(startupLogPath, line, 'utf8')
  } catch {
    // The terminal inherited from start.bat remains the fallback diagnostic.
  }
  try { console.error(detail) } catch { /* the parent console may be closed */ }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function readQyRecent() {
  try {
    const raw = await fs.promises.readFile(qyRecentPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => isPlainObject(item)
      && typeof item.path === 'string'
      && typeof item.title === 'string'
      && Number.isFinite(item.updatedAt))
      .slice(0, 30)
  } catch {
    return []
  }
}

async function writeQyRecent(items) {
  await fs.promises.mkdir(path.dirname(qyRecentPath), { recursive: true })
  await fs.promises.writeFile(qyRecentPath, JSON.stringify(items.slice(0, 30), null, 2), 'utf8')
}

async function rememberQyFile(filePath, title) {
  const recent = await readQyRecent()
  const next = [
    { path: filePath, title: String(title || path.basename(filePath, path.extname(filePath))), updatedAt: Date.now() },
    ...recent.filter((item) => item.path !== filePath),
  ]
  await writeQyRecent(next)
}

function ensureQyExtension(filePath) {
  return filePath.toLowerCase().endsWith('.qy') ? filePath : `${filePath}.qy`
}

async function rotateQyBackups(filePath, backupCount) {
  try {
    if (!fs.existsSync(filePath)) return
    await fs.promises.mkdir(qyBackupsPath, { recursive: true })
    const base = path.basename(filePath, path.extname(filePath)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = path.join(qyBackupsPath, `${base}-${stamp}.qy`)
    await fs.promises.copyFile(filePath, backupPath)
    const limit = Math.max(0, Math.min(100, Number(backupCount) || 10))
    const names = (await fs.promises.readdir(qyBackupsPath))
      .filter((name) => name.startsWith(`${base}-`) && name.toLowerCase().endsWith('.qy'))
    const details = await Promise.all(names.map(async (name) => {
      const target = path.join(qyBackupsPath, name)
      const stat = await fs.promises.stat(target)
      return { target, mtime: stat.mtimeMs }
    }))
    details.sort((a, b) => b.mtime - a.mtime)
    await Promise.all(details.slice(limit).map(({ target }) => fs.promises.unlink(target).catch(() => {})))
  } catch (error) {
    // A failed backup must not prevent the actual save. Keep a diagnostic for
    // troubleshooting while the user's work remains writable.
    logStartup('Unable to rotate .qy backup', error)
  }
}

async function readQyDocument(filePath) {
  const raw = await fs.promises.readFile(filePath, 'utf8')
  const document = JSON.parse(raw)
  if (!isPlainObject(document) || document.format !== 'qy' || document.version !== 1 || !isPlainObject(document.content)) {
    throw new Error('文件格式或版本不受支持')
  }
  if (!Array.isArray(document.content.chapters) || !Array.isArray(document.content.volumes)) {
    throw new Error('作品文件缺少章节或分卷数据')
  }
  return document
}

async function openQyAtPath(filePath) {
  const document = await readQyDocument(filePath)
  await rememberQyFile(filePath, document.title)
  return { canceled: false, path: filePath, document }
}
try {
  fs.mkdirSync(sessionDataPath, { recursive: true })
  fs.mkdirSync(cachePath, { recursive: true })
  app.setPath('sessionData', sessionDataPath)
} catch (error) {
  logStartup('Unable to prepare Electron cache directory', error)
}
app.commandLine.appendSwitch('disk-cache-dir', cachePath)
app.commandLine.appendSwitch('disable-http-cache')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

const hasSingleInstanceLock = app.requestSingleInstanceLock()
let startupComplete = false
let pendingFocusRequest = false

if (!hasSingleInstanceLock) {
  logStartup('Another Novel Generator instance already owns the single-instance lock; requesting it to show its window')
  app.quit()
} else {
  app.on('second-instance', () => {
    // A second launch can arrive while the first instance is still starting
    // its local storage server. Remember the request and replay it after the
    // first window has finished loading instead of silently dropping it.
    pendingFocusRequest = true
    if (startupComplete) void focusOrCreateWindow()
  })
}

async function startProxy() {
  const storagePath = path.join(app.getPath('userData'), 'novel-generator-state.json')
  logStartup(`Starting local storage service (${storagePath})`)
  proxyServer = await startLocalApiServer({
    host: '127.0.0.1',
    port: 0,
    storagePath,
  })
  const address = proxyServer.address()
  if (!address || typeof address === 'string') throw new Error('无法确定本机存储服务端口')
  logStartup(`Local storage service listening on ${address.port}`)
  return address.port
}

function stopProxy() {
  logStartup('Stopping local storage service')
  if (proxyServer) proxyServer.close()
  proxyServer = undefined
}

function windowFromIpcEvent(event) {
  return BrowserWindow.fromWebContents(event.sender)
}

function sendMaximizeState(window) {
  if (!window || window.isDestroyed()) return
  window.webContents.send('desktop-window:maximized', window.isMaximized())
}

ipcMain.handle('qy:open', async () => {
  const result = await dialog.showOpenDialog({
    title: '打开作品文件',
    defaultPath: qyWorksPath,
    properties: ['openFile'],
    filters: [{ name: '叙事工坊作品', extensions: ['qy'] }],
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  try {
    return await openQyAtPath(result.filePaths[0])
  } catch (error) {
    return { canceled: false, error: error instanceof Error ? error.message : '读取作品文件失败' }
  }
})

ipcMain.handle('qy:open-path', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath.trim()) return { canceled: false, error: '作品文件路径无效' }
  try {
    return await openQyAtPath(filePath)
  } catch (error) {
    return { canceled: false, error: error instanceof Error ? error.message : '读取作品文件失败' }
  }
})

ipcMain.handle('qy:save', async (_event, input = {}) => {
  const document = input?.document
  if (!isPlainObject(document) || document.format !== 'qy' || document.version !== 1 || !isPlainObject(document.content)) {
    return { canceled: false, error: '作品文件内容无效' }
  }
  let filePath = typeof input.currentPath === 'string' && input.currentPath.trim() && input.saveAs !== true
    ? input.currentPath
    : ''
  if (!filePath) {
    const result = await dialog.showSaveDialog({
      title: '保存作品文件',
      defaultPath: path.join(qyWorksPath, `${String(document.title || '未命名作品').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.qy`),
      filters: [{ name: '叙事工坊作品', extensions: ['qy'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    filePath = result.filePath
  }
  filePath = ensureQyExtension(filePath)
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await rotateQyBackups(filePath, input.backupCount)
    const tempPath = `${filePath}.tmp`
    await fs.promises.writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await fs.promises.rename(tempPath, filePath)
    await rememberQyFile(filePath, document.title)
    return { canceled: false, path: filePath, title: document.title }
  } catch (error) {
    return { canceled: false, error: error instanceof Error ? error.message : '保存作品文件失败' }
  }
})

ipcMain.handle('qy:recent', async () => {
  const recent = await readQyRecent()
  const existing = []
  for (const item of recent) {
    try {
      await fs.promises.access(item.path)
      existing.push(item)
    } catch {
      // Remove files that no longer exist from the displayed history.
    }
  }
  if (existing.length !== recent.length) await writeQyRecent(existing)
  return existing
})

ipcMain.handle('qy:remove-recent', async (_event, filePath) => {
  if (typeof filePath !== 'string') return { ok: false }
  const recent = await readQyRecent()
  await writeQyRecent(recent.filter((item) => item.path !== filePath))
  return { ok: true }
})

async function focusOrCreateWindow() {
  const window = BrowserWindow.getAllWindows()[0]
  if (window && !window.isDestroyed()) {
    pendingFocusRequest = false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return
  }

  const address = proxyServer?.address()
  if (!address || typeof address === 'string') {
    pendingFocusRequest = true
    return
  }
  try {
    await createWindow(address.port)
    pendingFocusRequest = false
  } catch (error) {
    logStartup('Unable to reopen application window', error)
    dialog.showErrorBox('叙事工坊无法打开', '本机存储服务不可用，请重新启动应用。')
  }
}

ipcMain.on('desktop-window:minimize', (event) => {
  windowFromIpcEvent(event)?.minimize()
})

ipcMain.on('desktop-window:toggle-maximize', (event) => {
  const window = windowFromIpcEvent(event)
  if (!window) return
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
})

ipcMain.on('desktop-window:close', (event) => {
  windowFromIpcEvent(event)?.close()
})

ipcMain.handle('desktop-window:is-maximized', (event) => windowFromIpcEvent(event)?.isMaximized() ?? false)

async function createWindow(apiPort) {
  logStartup(`Creating desktop window with API port ${apiPort}`)
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    frame: false,
    // Show the native window immediately. Waiting for ready-to-show can leave
    // the app invisible when Chromium is cold-starting or the renderer has a
    // transient load failure; the page can paint into the already visible
    // window once loadURL/loadFile completes.
    show: true,
    backgroundColor: '#f7f8f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      // Electron's renderer sandbox requires an ALL APPLICATION PACKAGES ACL
      // on the Electron installation directory. Portable checkouts on a
      // secondary drive commonly lack that ACL and the renderer exits before
      // the hidden window can emit ready-to-show.
      sandbox: false,
    },
  })

  window.on('maximize', () => sendMaximizeState(window))
  window.on('unmaximize', () => sendMaximizeState(window))
  let shown = false
  let showFallbackTimer
  const showWindow = () => {
    if (shown || window.isDestroyed()) return
    shown = true
    clearTimeout(showFallbackTimer)
    window.show()
    window.focus()
    sendMaximizeState(window)
    logStartup('Desktop window shown')
  }
  window.once('ready-to-show', showWindow)
  window.webContents.once('did-finish-load', () => {
    // Keep startup deterministic if Chromium emits ready-to-show before the
    // renderer load promise resolves on a cold launch.
    setTimeout(showWindow, 250)
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      logStartup(`Desktop page failed to load (${errorCode} ${errorDescription}) ${validatedURL}`)
      showWindow()
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logStartup(`Desktop renderer exited (${details?.reason || 'unknown'}) ${details?.exitCode ?? ''}`)
    showWindow()
  })
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) logStartup(`Renderer console error ${sourceId}:${line}: ${message}`)
  })
  // A renderer failure must not leave the application running as an invisible
  // process with the single-instance lock held.
  showFallbackTimer = setTimeout(showWindow, 5000)
  window.once('closed', () => clearTimeout(showFallbackTimer))

  let allowClose = false
  let closePending = false
  let flushRequestId = 0
  window.on('close', (event) => {
    if (allowClose) return
    event.preventDefault()
    if (closePending) return

    closePending = true
    const requestId = ++flushRequestId
    let settled = false
    const finish = async (saved, error = '') => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener('desktop:flush-complete', onComplete)

      if (saved) {
        allowClose = true
        window.close()
        return
      }

      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        closePending = false
        return
      }
      let choice
      try {
        choice = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '保存失败',
          message: '作品还没有确认写入本机文件。',
          detail: error || '本机存储服务没有完成保存。',
          buttons: ['返回应用', '放弃保存并退出'],
          defaultId: 0,
          cancelId: 0,
        })
      } catch (dialogError) {
        console.error('Unable to show save failure dialog:', dialogError)
        closePending = false
        return
      }
      closePending = false
      if (choice.response === 1) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('desktop:flush-abandoned')
        }
        allowClose = true
        window.close()
      } else if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('desktop:flush-cancelled')
      }
    }
    const onComplete = (ipcEvent, result) => {
      if (ipcEvent.sender !== window.webContents || result?.requestId !== requestId) return
      void finish(result.saved === true, typeof result.error === 'string' ? result.error : '')
    }
    const timeout = setTimeout(() => {
      void finish(false, '等待本机存储服务响应超时。')
    }, 60000)

    ipcMain.on('desktop:flush-complete', onComplete)
    window.webContents.send('desktop:flush-request', requestId)
  })

  if (appUrl) {
    const target = new URL(appUrl)
    target.searchParams.set('desktopApiPort', String(apiPort))
    logStartup(`Loading desktop URL ${target.href}`)
    try {
      await window.loadURL(target.href)
    } catch (error) {
      // A preview server can disappear after the health check (for example
      // when a previous start.bat process is still shutting down). The
      // packaged renderer is already built, so fall back to it instead of
      // showing a misleading "storage service failed" dialog.
      logStartup('Desktop preview URL failed; falling back to local dist', error)
      await window.loadFile(path.join(projectRoot, 'dist', 'index.html'), { query: { desktopApiPort: String(apiPort) } })
    }
  } else {
    logStartup('Loading local dist/index.html')
    await window.loadFile(path.join(projectRoot, 'dist', 'index.html'), { query: { desktopApiPort: String(apiPort) } })
  }
  logStartup('Desktop page load request completed')
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    logStartup('Electron app is ready')
    try {
      // Renderer requests to the local storage server must never be routed
      // through the user's system/browser proxy. Upstream model and web
      // requests are made by the local server and keep their own proxy
      // settings, so this only protects the desktop IPC transport.
      await session.defaultSession.setProxy({ mode: 'direct' })
      const apiPort = await startProxy()
      await createWindow(apiPort)
      startupComplete = true
      if (pendingFocusRequest) void focusOrCreateWindow()
    } catch (error) {
      logStartup('Unable to start local storage service', error)
      const detail = error instanceof Error ? error.message : '未知错误'
      dialog.showErrorBox('叙事工坊无法启动', `启动本机服务或加载界面失败：${detail}\n\n为避免默认内容覆盖已有作品，应用已停止启动。`)
      app.quit()
      return
    }
    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        try {
          const apiPort = proxyServer?.address()
          if (!apiPort || typeof apiPort === 'string') throw new Error('本机存储服务不可用')
          await createWindow(apiPort.port)
        } catch (error) {
          logStartup('Unable to restore application window', error)
          dialog.showErrorBox('叙事工坊无法打开', '本机存储服务不可用，请重新启动应用。')
        }
      }
    })
  })
}

// Keep the storage server alive through the renderer's close/flush handshake.
// `before-quit` can fire before BrowserWindow's close handler has completed,
// which would make the final write fail against an already closed port.
app.on('will-quit', stopProxy)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
