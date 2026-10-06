import path from 'node:path'
import { showOwnedQyFileDialog } from './qy-dialogs.mjs'

/** Only the editor's main frame can inspect backups or open a native picker. */
export function installQyFilesIpc({
  ipcMain, getWindow, service, dialog, shell, rememberFile = async () => {}, logger = () => {},
}) {
  function owner(event) {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('该窗口无权管理作品集备份。')
    }
    return window
  }

  const handlers = {
    directories: async () => service.prepareDirectories(),
    backups: async (_event, sourcePath) => service.listBackups(sourcePath),
    'open-directory': async (_event, kind) => {
      if (!['save', 'backup'].includes(kind)) throw new Error('请选择保存目录或备份目录。')
      const directories = await service.prepareDirectories()
      const directory = kind === 'save' ? directories.saveDirectory : directories.backupDirectory
      owner(_event)
      const error = await shell.openPath(directory)
      return error ? { ok: false, error: '无法打开目录，请确认目录存在并有访问权限。' } : { ok: true }
    },
    'restore-backup': async (event, input) => {
      if (!input || typeof input.sourcePath !== 'string' || typeof input.backupId !== 'string') {
        throw new Error('请选择当前作品集的一份备份。')
      }
      const backups = await service.listBackups(input.sourcePath)
      const backup = backups.entries.find((entry) => entry.id === input.backupId)
      if (!backup?.valid) throw new Error(backup?.error || '没有找到可恢复的备份。')
      const base = String(backup.title || path.basename(input.sourcePath, path.extname(input.sourcePath)))
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || '作品集'
      const result = await showOwnedQyFileDialog({
        dialog, ownerWindow: owner(event), mode: 'save',
        options: {
          title: '将备份恢复为新作品集',
          defaultPath: path.join(backups.saveDirectory, `${base}-恢复.qy`),
          filters: [{ name: '叙事工坊作品集', extensions: ['qy'] }],
        },
        logger,
      })
      if (result.error) return result
      if (result.canceled || !result.filePath) return { canceled: true }
      owner(event)
      const destinationPath = result.filePath.toLowerCase().endsWith('.qy')
        ? result.filePath : `${result.filePath}.qy`
      const restored = await service.restoreBackup({
        sourcePath: input.sourcePath, backupId: input.backupId, destinationPath,
      })
      try { await rememberFile(restored.path, restored.title) } catch (error) {
        logger('Unable to remember restored .qy portfolio', error)
      }
      return { canceled: false, ...restored }
    },
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`qy:${name}`, async (event, input) => {
      owner(event)
      try { return await handler(event, input) } catch (error) {
        logger(`Unable to complete .qy ${name}`, error)
        const message = error instanceof Error ? error.message : '作品集文件操作未完成。'
        return name === 'open-directory' ? { ok: false, error: message } : { canceled: false, error: message }
      }
    })
  }
  return { dispose() { for (const name of Object.keys(handlers)) ipcMain.removeHandler(`qy:${name}`) } }
}
