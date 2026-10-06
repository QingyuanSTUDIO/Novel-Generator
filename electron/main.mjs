import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLocalApiServer } from '../server/index.mjs'
import { parseQyPortfolio, qyPortfolioTitle } from './qy.mjs'
import { canonicalQyPath, createQySaveManager, qyFileRevision, readQyFileRevision } from './qy-save.mjs'
import { createQyFilesService } from './qy-files.mjs'
import { createQyAttachmentStore } from './qy-assets.mjs'
import { installQyFilesIpc } from './qy-files-ipc.mjs'
import { installDesktopCloseHandshake } from './close-handshake.mjs'
import { showOwnedQyFileDialog } from './qy-dialogs.mjs'
import { createConsoleService } from './console-service.mjs'
import { createConsoleRendererTransport, installConsoleIpc } from './console-ipc.mjs'
import { installDesktopTerminal, resolveSystemNode } from './terminal.mjs'
import { createMcpServer } from './mcp-server.mjs'
import { createMcpSettingsManager } from './mcp-settings.mjs'
import { installMcpIpc } from './mcp-ipc.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = process.env.NOVEL_PROJECT_ROOT || path.resolve(__dirname, '..')
const appUrl = process.env.ELECTRON_APP_URL || ''
let proxyServer
let mainWindow
let consoleService
let consoleIpc
let terminalManager
let consoleTransport
let mcpManager
let mcpIpc
let qyFilesIpc
let removeProfileAuthHeader
let profileAuthToken = ''
let quitRequested = false

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
const consoleEndpointPath = path.join(userDataPath, 'console-endpoint.json')
const mcpSettingsPath = path.join(userDataPath, 'mcp-settings.json')
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

// Recent-file metadata is application state too.  Serialize its read/modify/
// write cycle so two saves finishing together cannot lose one another's entry.
let qyRecentQueue = Promise.resolve()
function enqueueQyRecent(operation) {
  const run = qyRecentQueue.catch(() => {}).then(operation)
  qyRecentQueue = run.catch(() => {})
  return run
}

function rememberQyFile(filePath, title) {
  return enqueueQyRecent(async () => {
    const recent = await readQyRecent()
    const next = [
      { path: filePath, title: String(title || path.basename(filePath, path.extname(filePath))), updatedAt: Date.now() },
      ...recent.filter((item) => item.path !== filePath),
    ]
    await writeQyRecent(next)
  })
}

function ensureQyExtension(filePath) {
  return filePath.toLowerCase().endsWith('.qy') ? filePath : `${filePath}.qy`
}

const qySaveManager = createQySaveManager({
  backupRoot: qyBackupsPath,
  logger: logStartup,
})
const qyAttachmentStore = createQyAttachmentStore({ logger: logStartup })
const qyFilesService = createQyFilesService({
  saveRoot: qyWorksPath, backupRoot: qyBackupsPath, saveManager: qySaveManager,
  attachmentStore: qyAttachmentStore, logger: logStartup,
})

async function readQyDocument(filePath) {
  const raw = await fs.promises.readFile(filePath)
  let document
  try {
    document = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('作品集文件不是有效的 JSON')
  }
  return { document: parseQyPortfolio(document), revision: qyFileRevision(raw) }
}

async function openQyAtPath(filePath) {
  const { document, revision } = await readQyDocument(filePath)
  const title = qyPortfolioTitle(document)
  const attachments = await qyAttachmentStore.read(filePath, document)
  await rememberQyFile(filePath, title)
  return { canceled: false, path: filePath, title, document, attachments, revision }
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
  const profileAllowedOrigins = []
  if (appUrl) {
    try { profileAllowedOrigins.push(new URL(appUrl).origin) } catch { /* invalid preview URL falls back to local file */ }
  }
  // Chromium's file:// renderer may report either the literal file origin or
  // an opaque "null" origin. Both are local, and neither is exposed to an
  // arbitrary web page because the service still requires the per-launch
  // bearer token below.
  profileAllowedOrigins.push('file://', 'null')
  proxyServer = await startLocalApiServer({
    host: '127.0.0.1',
    port: 0,
    storagePath,
    requireProfileAuth: true,
    profileAllowedOrigins,
  })
  const address = proxyServer.address()
  if (!address || typeof address === 'string') throw new Error('无法确定本机存储服务端口')
  profileAuthToken = proxyServer.profileAuthToken
  if (typeof profileAuthToken !== 'string' || !profileAuthToken) throw new Error('无法初始化本机 profile 服务令牌')
  const requestFilter = {
    urls: [`http://127.0.0.1:${address.port}/api/storage*`],
  }
  session.defaultSession.webRequest.onBeforeSendHeaders(requestFilter, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders }
    if (profileAuthToken) requestHeaders.Authorization = `Bearer ${profileAuthToken}`
    callback({ requestHeaders })
  })
  removeProfileAuthHeader = () => {
    // Electron's webRequest API does not expose a per-listener remover. A
    // single handler lives for this app process; clear its captured secret so
    // a shutdown cannot retain it in a long-lived callback.
    profileAuthToken = ''
    removeProfileAuthHeader = undefined
  }
  logStartup(`Local storage service listening on ${address.port}`)
  return address.port
}

function stopProxy() {
  logStartup('Stopping local storage service')
  removeProfileAuthHeader?.()
  removeProfileAuthHeader = undefined
  profileAuthToken = ''
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

ipcMain.handle('qy:open', async (event) => {
  const result = await showOwnedQyFileDialog({
    dialog,
    ownerWindow: windowFromIpcEvent(event),
    mode: 'open',
    options: {
      title: '打开作品集文件',
      defaultPath: qyWorksPath,
      properties: ['openFile'],
      filters: [{ name: '叙事工坊作品', extensions: ['qy'] }],
    },
    logger: logStartup,
  })
  if (result.error) return result
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  try {
    return await openQyAtPath(result.filePaths[0])
  } catch (error) {
    logStartup('Unable to open .qy portfolio', error)
    return { canceled: false, error: error instanceof Error ? error.message : '读取作品文件失败' }
  }
})

ipcMain.handle('qy:open-path', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath.trim()) return { canceled: false, error: '作品文件路径无效' }
  try {
    return await openQyAtPath(filePath)
  } catch (error) {
    logStartup('Unable to open recent .qy portfolio', error)
    return { canceled: false, error: error instanceof Error ? error.message : '读取作品文件失败' }
  }
})

ipcMain.handle('qy:save', async (event, input = {}) => {
  const document = input?.document
  let portableDocument
  try {
    portableDocument = parseQyPortfolio(document)
  } catch (error) {
    return { canceled: false, error: error instanceof Error ? error.message : '作品集文件内容无效' }
  }
  const title = qyPortfolioTitle(portableDocument)
  let filePath = typeof input.currentPath === 'string' && input.currentPath.trim() && input.saveAs !== true
    ? input.currentPath
    : ''
  if (!filePath) {
    const result = await showOwnedQyFileDialog({
      dialog,
      ownerWindow: windowFromIpcEvent(event),
      mode: 'save',
      options: {
        title: '保存作品集文件',
        defaultPath: path.join(qyWorksPath, `${String(title || '未命名作品集').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.qy`),
        filters: [{ name: '叙事工坊作品', extensions: ['qy'] }],
      },
      logger: logStartup,
    })
    if (result.error) return result
    if (result.canceled || !result.filePath) return { canceled: true }
    filePath = result.filePath
  }
  filePath = ensureQyExtension(filePath)
  try {
    const sameAsLoaded = typeof input.currentPath === 'string' && input.currentPath.trim()
      && canonicalQyPath(input.currentPath) === canonicalQyPath(filePath)
    if (sameAsLoaded && input.expectedRevision !== null
      && (typeof input.expectedRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.expectedRevision))) {
      return { canceled: false, error: '保存版本信息缺失，请重新打开作品集后再保存。当前编辑仍保留在内存中。' }
    }
    // A newly selected destination may be overwritten only after the native
    // picker confirms it. Selecting the loaded path retains its old revision
    // so Save As cannot silently bypass an existing conflict.
    const expectedRevision = sameAsLoaded ? input.expectedRevision : await readQyFileRevision(filePath)
    // Write new content-addressed image bytes before publishing the document.
    // Existing bytes are never replaced; a conflicting asset aborts this
    // save before the old .qy can be touched.
    await qyAttachmentStore.write(filePath, input.attachments || [])
    const written = await qySaveManager.write(
      filePath,
      `${JSON.stringify(portableDocument, null, 2)}\n`,
      input.backupCount,
      { expectedRevision },
    )
    if (written.backupPath) {
      try {
        await qyAttachmentStore.copy(filePath, written.backupPath)
      } catch (error) {
        // The .qy backup remains usable for text and metadata. Report the
        // missing sidecar only in the startup log so a transient attachment
        // copy failure cannot turn a confirmed document save into a false
        // failure.
        logStartup('Unable to copy character image attachments into .qy backup', error)
      }
    }
    // The document is already safely on disk if recent-file bookkeeping
    // fails.  Keep the successful save result and leave a diagnostic instead
    // of presenting a false "作品保存失败" message.
    try {
      await rememberQyFile(filePath, title)
    } catch (error) {
      logStartup('Unable to update recent .qy files', error)
    }
    return { canceled: false, path: filePath, title, revision: written.revision }
  } catch (error) {
    logStartup('Unable to save .qy portfolio', error)
    if (error?.code === 'QY_FILE_CONFLICT') {
      return {
        canceled: false, conflict: error.conflict,
        error: '作品集文件已在外部发生变化，自动写入已暂停。请选择重新加载、另存为或取消。',
      }
    }
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
  if (existing.length !== recent.length) {
    await enqueueQyRecent(() => writeQyRecent(existing))
  }
  return existing
})

ipcMain.handle('qy:remove-recent', async (_event, filePath) => {
  if (typeof filePath !== 'string') return { ok: false }
  await enqueueQyRecent(async () => {
    const recent = await readQyRecent()
    await writeQyRecent(recent.filter((item) => item.path !== filePath))
  })
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
  mainWindow = window
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined
    // A renderer failure must stop its jobs even when a window is recreated.
    void consoleService?.suspend().catch((error) => logStartup('Unable to pause console jobs', error))
    if (quitRequested && BrowserWindow.getAllWindows().length === 0) app.quit()
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
  let rendererHasLoaded = false
  window.webContents.on('did-finish-load', () => { rendererHasLoaded = true })
  window.webContents.on('did-start-loading', () => {
    if (rendererHasLoaded && window.webContents.isLoadingMainFrame()) {
      void consoleService?.suspend().catch((error) => logStartup('Unable to pause jobs for renderer reload', error))
    }
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      logStartup(`Desktop page failed to load (${errorCode} ${errorDescription}) ${validatedURL}`)
      showWindow()
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logStartup(`Desktop renderer exited (${details?.reason || 'unknown'}) ${details?.exitCode ?? ''}`)
    void consoleService?.suspend().catch((error) => logStartup('Unable to pause jobs after renderer failure', error))
    showWindow()
  })
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) logStartup(`Renderer console error ${sourceId}:${line}: ${message}`)
  })
  // A renderer failure must not leave the application running as an invisible
  // process with the single-instance lock held.
  showFallbackTimer = setTimeout(showWindow, 5000)
  window.once('closed', () => clearTimeout(showFallbackTimer))

  installDesktopCloseHandshake(window, {
    ipcMain,
    dialog,
    waitForPendingWrites: () => qySaveManager.waitForPendingWrites(),
    logger: logStartup,
  })

  if (appUrl) {
    const target = new URL(appUrl)
    target.searchParams.set('desktopApiPort', String(apiPort))
    // A desktop session may reuse Chromium's HTTP cache while the preview
    // server has been rebuilt.  Make each launch request a fresh document so
    // an older index cannot reference a deleted hashed chunk.
    target.searchParams.set('desktopBoot', String(Date.now()))
    logStartup(`Loading desktop URL ${target.href}`)
    try {
      await window.loadURL(target.href)
    } catch (error) {
      // A preview server can disappear after the health check (for example
      // when a previous start.bat process is still shutting down). The
      // packaged renderer is already built, so fall back to it instead of
      // showing a misleading "storage service failed" dialog.
      logStartup('Desktop preview URL failed; falling back to local dist', error)
      await window.loadFile(path.join(projectRoot, 'dist', 'index.html'), {
        query: { desktopApiPort: String(apiPort), desktopBoot: String(Date.now()) },
      })
    }
  } else {
    logStartup('Loading local dist/index.html')
    await window.loadFile(path.join(projectRoot, 'dist', 'index.html'), {
      query: { desktopApiPort: String(apiPort), desktopBoot: String(Date.now()) },
    })
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
      if (appUrl) {
        // A preview restart can rebuild `dist` while Chromium still has the
        // previous hashed index/chunks cached. Clear only HTTP cache here;
        // localStorage and the profile service are unaffected.
        await session.defaultSession.clearCache()
      }
      const apiPort = await startProxy()
      qyFilesIpc = installQyFilesIpc({
        ipcMain, getWindow: () => mainWindow, service: qyFilesService, dialog,
        shell, rememberFile: rememberQyFile, logger: logStartup,
      })
      consoleTransport = createConsoleRendererTransport({
        getWindow: () => mainWindow, ipcMain,
        onTimeout: async () => { await consoleService?.suspend() },
      })
      consoleService = createConsoleService({
        storagePath: path.join(userDataPath, 'console-jobs.json'),
        endpointPath: consoleEndpointPath,
        execute: consoleTransport.execute,
        inspect: consoleTransport.inspect,
        logger: logStartup,
      })
      let consoleStartupError = ''
      try { await consoleService.start() } catch (error) {
        // A damaged task history must not prevent opening the author's .qy.
        // Preserve the file and disable only the console's task transport.
        consoleStartupError = `创作任务服务不可用：${error instanceof Error ? error.message : '读取任务记录失败'}`
        logStartup(consoleStartupError, error)
      }
      consoleIpc = installConsoleIpc({
        ipcMain, getWindow: () => mainWindow, service: consoleService,
        endpointPath: consoleEndpointPath, cliPath: path.join(projectRoot, 'scripts', 'qy-cli.mjs'),
        startupError: consoleStartupError,
      })
      terminalManager = installDesktopTerminal({
        ipcMain, BrowserWindow, projectRoot, userDataPath,
        endpointPath: consoleEndpointPath, logger: logStartup,
      })
      mcpManager = createMcpSettingsManager({
        settingsPath: mcpSettingsPath,
        service: consoleService,
        createServer: (options) => {
          if (consoleStartupError) throw new Error(consoleStartupError)
          return createMcpServer(options)
        },
        logger: logStartup,
        onUpdate: (info) => {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('mcp:update', info)
          }
        },
      })
      let mcpNodeCommand = 'node'
      try { mcpNodeCommand = resolveSystemNode() } catch { /* clients can resolve Node on their own PATH */ }
      mcpIpc = installMcpIpc({
        ipcMain, getWindow: () => mainWindow, manager: mcpManager,
        scriptPath: path.join(projectRoot, 'scripts', 'qy-mcp.mjs'),
        settingsPath: mcpSettingsPath, nodeCommand: mcpNodeCommand,
      })
      // A port conflict or damaged MCP preference must not block the editor.
      try { await mcpManager.start() } catch (error) {
        logStartup('Unable to initialize MCP preferences', error)
      }
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
// Keep native PTY helpers alive until their process trees have closed. The
// renderer close handshake already suspended jobs and flushed the .qy writer.
let servicesDisposed = false
let serviceShutdown
app.on('before-quit', (event) => {
  if (servicesDisposed || !hasSingleInstanceLock) return
  event.preventDefault()
  if (BrowserWindow.getAllWindows().length > 0) {
    quitRequested = true
    for (const window of BrowserWindow.getAllWindows()) window.close()
    return
  }
  serviceShutdown ??= Promise.resolve().then(async () => {
    await mcpManager?.close().catch((error) => logStartup('Unable to close MCP service', error))
    mcpIpc?.dispose()
    qyFilesIpc?.dispose()
    await consoleService?.close().catch((error) => logStartup('Unable to close console jobs', error))
    await terminalManager?.dispose().catch((error) => logStartup('Unable to close desktop terminals', error))
    consoleIpc?.dispose()
    consoleTransport?.dispose()
    servicesDisposed = true
    app.quit()
  }).catch((error) => {
    logStartup('Desktop console shutdown failed', error)
    servicesDisposed = true
    app.quit()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
