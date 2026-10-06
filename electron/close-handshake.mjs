/**
 * Keep the desktop window alive until the renderer confirms its final save.
 * Dependencies are injected so cancellation and IPC ordering can be exercised
 * without creating an Electron window or writing an author's files.
 */
export function installDesktopCloseHandshake(window, {
  ipcMain,
  dialog,
  waitForPendingWrites = async () => {},
  logger = () => {},
  timeoutMs = 60000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let allowClose = false
  let closePending = false
  let flushRequestId = 0
  let cleanupRequest = () => {}

  const isAlive = () => !window.isDestroyed() && !window.webContents.isDestroyed()
  const cancelClose = () => {
    closePending = false
    if (isAlive()) window.webContents.send('desktop:flush-cancelled')
  }

  const onClose = (event) => {
    if (allowClose) return
    event.preventDefault()
    if (closePending) return

    closePending = true
    const requestId = ++flushRequestId
    let settled = false
    let timeout
    const cleanup = () => {
      clearTimer(timeout)
      ipcMain.removeListener('desktop:flush-complete', onComplete)
    }
    cleanupRequest = cleanup

    const finish = async (result) => {
      if (settled) return
      settled = true
      cleanup()

      // Canceling the first-save file picker is an ordinary user decision.
      // Keep the app open and allow the next close request to try again.
      if (result?.canceled === true) {
        cancelClose()
        return
      }

      let saved = result?.saved === true
      let error = typeof result?.error === 'string' ? result.error : ''
      try {
        // An automatic save may have been queued immediately before the
        // renderer's final flush. Do not tear down its writer early.
        await waitForPendingWrites()
      } catch (writeError) {
        saved = false
        error = writeError instanceof Error ? writeError.message : '等待作品集写入失败。'
      }

      if (!isAlive()) {
        closePending = false
        return
      }
      if (saved) {
        allowClose = true
        window.close()
        return
      }

      const detail = error || '保存尚未完成，请返回应用重试。'
      logger('Desktop close save failed', new Error(detail))
      let choice
      try {
        choice = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '保存失败',
          message: '作品集还没有确认写入 .qy 文件。',
          detail,
          buttons: ['返回应用', '放弃保存并退出'],
          defaultId: 0,
          cancelId: 0,
        })
      } catch (dialogError) {
        logger('Unable to show save failure dialog', dialogError)
        cancelClose()
        return
      }
      closePending = false
      if (choice.response === 1) {
        if (isAlive()) window.webContents.send('desktop:flush-abandoned')
        allowClose = true
        if (!window.isDestroyed()) window.close()
      } else if (isAlive()) {
        window.webContents.send('desktop:flush-cancelled')
      }
    }
    const onComplete = (ipcEvent, result) => {
      if (ipcEvent.sender !== window.webContents || result?.requestId !== requestId) return
      void finish(result)
    }
    timeout = setTimer(() => {
      void finish({ saved: false, error: '等待作品集保存完成超时。' })
    }, timeoutMs)
    ipcMain.on('desktop:flush-complete', onComplete)
    window.webContents.send('desktop:flush-request', requestId)
  }

  window.on('close', onClose)
  window.once('closed', () => cleanupRequest())
}
