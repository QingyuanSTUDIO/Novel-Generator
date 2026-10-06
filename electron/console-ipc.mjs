import { randomUUID } from 'node:crypto'

/**
 * The loopback broker dispatches into the window which owns the open .qy.
 * Replies are scoped to both that webContents and its main frame. A reload
 * rejects in-flight calls, rather than delivering them to a different editor.
 */
export function createConsoleRendererTransport({ getWindow, ipcMain, timeoutMs = 15 * 60_000, onTimeout = async () => {} }) {
  const pending = new Map()
  const listeners = new Map()

  function windowForRequest() {
    const window = getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) {
      throw new Error('桌面编辑器尚未就绪或正在重新加载，请稍后恢复任务。')
    }
    return window
  }

  function request(channel, payload, duration) {
    let window
    try { window = windowForRequest() } catch (error) { return Promise.reject(error) }
    const sender = window.webContents
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const entry = { sender, resolve, reject, clean: () => {} }
      const fail = () => {
        if (!pending.has(requestId)) return
        entry.clean()
        reject(new Error('桌面窗口已关闭或重新加载，任务已停止；请检查保存断点后再恢复。'))
      }
      const loading = () => {
        if (sender.isLoadingMainFrame()) fail()
      }
      const timer = setTimeout(async () => {
        if (!pending.has(requestId)) return
        // Suspend the broker and send the renderer its cancellation fence
        // before releasing the serial lease. Dropping only the reply would
        // allow an old execution to change the work after the next starts.
        if (channel === 'console:execute' && payload?.action !== 'cancel') {
          try { await onTimeout(payload) } catch { /* still reject the request */ }
        }
        if (!pending.has(requestId)) return
        entry.clean()
        reject(new Error('等待桌面任务响应超时，请在控制台检查任务状态。'))
      }, duration)
      timer.unref?.()
      entry.clean = () => {
        clearTimeout(timer)
        sender.removeListener('destroyed', fail)
        sender.removeListener('render-process-gone', fail)
        sender.removeListener('did-start-loading', loading)
        pending.delete(requestId)
      }
      sender.once('destroyed', fail)
      sender.once('render-process-gone', fail)
      sender.on('did-start-loading', loading)
      pending.set(requestId, entry)
      try { sender.send(channel, requestId, payload) } catch (error) {
        entry.clean()
        reject(error)
      }
    })
  }

  for (const [channel, key] of [['console:execute-complete', 'result'], ['console:inspect-complete', 'value']]) {
    const listener = (event, reply) => {
      const entry = pending.get(reply?.requestId)
      if (!entry || entry.sender !== event.sender || event.senderFrame !== event.sender.mainFrame) return
      entry.clean()
      if (typeof reply.error === 'string' && reply.error) entry.reject(new Error(reply.error))
      else entry.resolve(reply[key])
    }
    listeners.set(channel, listener)
    ipcMain.on(channel, listener)
  }

  return {
    execute: (command) => request('console:execute', command, command.action === 'cancel' ? 20_000 : timeoutMs),
    inspect: (query) => request('console:inspect', query, 15_000),
    dispose() {
      for (const entry of [...pending.values()]) {
        entry.clean()
        entry.reject(new Error('桌面任务服务已关闭。'))
      }
      for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener)
    },
  }
}

export function installConsoleIpc({ ipcMain, getWindow, service, endpointPath, cliPath, startupError = '' }) {
  const names = ['info', 'list', 'submit', 'action', 'report', 'checkpoint', 'suspend']
  function owner(event) {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) throw new Error('该窗口无权操作创作控制台。')
  }
  const handlers = {
    info: () => {
      if (startupError) throw new Error(startupError)
      return { endpointPath, cliPath }
    },
    list: () => service.list(),
    submit: (input) => service.submit(input),
    action: (input) => {
      if (!input || !['approve', 'pause', 'resume', 'cancel'].includes(input.action) || typeof input.jobId !== 'string') {
        throw new Error('任务操作无效。')
      }
      return service[input.action](input.jobId)
    },
    report: (input) => service.report(input?.jobId, input?.event),
    checkpoint: (input) => service.checkpoint(input?.jobId, input?.result),
    suspend: async () => {
      await service.suspend()
      await service.waitForIdle?.({ timeoutMs: 30_000 })
    },
  }
  for (const name of names) ipcMain.handle(`console:${name}`, (event, input) => {
    owner(event)
    if (startupError) throw new Error(startupError)
    return handlers[name](input)
  })
  const unsubscribe = service.subscribe((jobs) => {
    const window = getWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('console:update', jobs)
    }
  })
  return {
    dispose() {
      unsubscribe()
      for (const name of names) ipcMain.removeHandler(`console:${name}`)
    },
  }
}
