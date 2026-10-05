import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const viteBinary = isWindows
  ? process.execPath
  : path.join(root, 'node_modules', '.bin', 'vite')
const viteArgs = isWindows
  ? [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')]
  : []
const electronBinary = isWindows
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(root, 'node_modules', '.bin', 'electron')
const children = []
let shuttingDown = false

function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') reject(error)
      else resolve(findAvailablePort(startPort + 1))
    })
    server.listen(startPort, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    windowsHide: true,
  })
  child.once('error', (error) => {
    if (shuttingDown) return
    console.error(`无法启动 ${path.basename(command)}：${error instanceof Error ? error.message : error}`)
    shuttingDown = true
    for (const running of children) {
      if (!running.killed) running.kill()
    }
    process.exitCode = 1
  })
  children.push(child)
  return child
}

async function waitForUrl(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Preview server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`预览服务器未能启动：${url}`)
}

function cleanup() {
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

try {
  const port = await findAvailablePort(4173)
  const appUrl = `http://127.0.0.1:${port}/`
  const preview = start(viteBinary, [...viteArgs, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'])
  preview.once('exit', (code) => {
    if (shuttingDown) return
    console.error(`预览服务器意外退出（退出码 ${code ?? 'unknown'}）`)
    cleanup()
    process.exitCode = code || 1
  })
  await waitForUrl(appUrl)
  // Electron's Chromium sandbox requires an ALL APPLICATION PACKAGES ACL on
  // the installation directory. Project workspaces on a secondary drive
  // often do not have that ACL, so the renderer can die before a window is
  // created. The editor runs as a local desktop process with an isolated
  // preload bridge; disable Chromium's process sandbox on Windows so startup
  // is reliable for portable checkouts.
  const electronArgs = isWindows ? ['--no-sandbox', '.'] : ['.']
  const electron = start(electronBinary, electronArgs, {
    ELECTRON_APP_URL: appUrl,
    NOVEL_NODE_BINARY: process.execPath,
    NOVEL_PROJECT_ROOT: root,
  })
  electron.on('exit', (code) => {
    cleanup()
    process.exit(code ?? 0)
  })
  await new Promise(() => {})
} catch (error) {
  cleanup()
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

