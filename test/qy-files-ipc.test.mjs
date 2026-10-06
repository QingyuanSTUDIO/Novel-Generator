import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createQyFilesService } from '../electron/qy-files.mjs'
import { installQyFilesIpc } from '../electron/qy-files-ipc.mjs'
import { createQySaveManager, qyBackupPrefix } from '../electron/qy-save.mjs'

const directories = {
  saveDirectory: path.resolve('fixture', '保存'),
  backupDirectory: path.resolve('fixture', '备份'),
}
const sourcePath = path.resolve('fixture', '原作品集.qy')
const backupId = 'valid-backup.qy'
const selectedPath = path.resolve('fixture', '恢复副本.qy')
const backup = {
  id: backupId,
  title: '原作品集',
  valid: true,
  path: path.join(directories.backupDirectory, backupId),
  createdAt: 1,
  size: 120,
  projectCount: 1,
}

function fixture(overrides = {}) {
  const registered = new Map()
  const calls = []
  const logs = []
  const webContents = { mainFrame: {} }
  const state = { destroyed: false }
  const ownerWindow = {
    isDestroyed: () => state.destroyed,
    webContents,
  }
  state.currentWindow = ownerWindow
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  const restored = {
    path: selectedPath,
    title: '原作品集',
    document: { format: 'qy', version: 2 },
    revision: 'sha256:fixture-revision',
  }
  const service = {
    directories() { calls.push(['directories']); return directories },
    async prepareDirectories() { calls.push(['prepare-directories']); return directories },
    async listBackups(target) { calls.push(['backups', target]); return { ...directories, entries: [backup] } },
    async restoreBackup(input) { calls.push(['restore', input]); return restored },
    ...overrides.service,
  }
  const dialog = {
    async showSaveDialog(...args) {
      assert.strictEqual(this, dialog)
      calls.push(['picker', ...args])
      return { canceled: false, filePath: selectedPath }
    },
    ...overrides.dialog,
  }
  const shell = {
    async openPath(target) { calls.push(['open-path', target]); return '' },
    ...overrides.shell,
  }
  const bridge = installQyFilesIpc({
    ipcMain: {
      handle(name, handler) { registered.set(name, handler) },
      removeHandler(name) { registered.delete(name) },
    },
    getWindow: () => state.currentWindow,
    service,
    dialog,
    shell,
    async rememberFile(...args) {
      calls.push(['remember', ...args])
      return overrides.rememberFile?.(...args)
    },
    logger: (message, error) => logs.push({ message, error }),
  })
  return {
    bridge, registered, state, ownerWindow, webContents, event,
    calls, logs, service, dialog, shell, restored,
    invoke: (name, input) => registered.get(`qy:${name}`)(event, input),
  }
}

test('backup IPC registers only the intended four methods and removes them on dispose', () => {
  const value = fixture()
  assert.deepEqual([...value.registered.keys()].sort(), [
    'qy:backups', 'qy:directories', 'qy:open-directory', 'qy:restore-backup',
  ])
  value.bridge.dispose()
  assert.equal(value.registered.size, 0)
})

test('backup IPC refuses other windows, subframes, missing owners and destroyed windows before any work', async () => {
  const value = fixture()
  const handlers = [...value.registered.values()]
  for (const handler of handlers) {
    await assert.rejects(handler({ sender: {}, senderFrame: {} }, 'save'), /无权/)
    await assert.rejects(handler({ sender: value.webContents, senderFrame: {} }, 'save'), /无权/)
    await assert.rejects(handler({ sender: {}, senderFrame: value.webContents.mainFrame }, 'save'), /无权/)
  }
  value.state.currentWindow = undefined
  for (const handler of handlers) await assert.rejects(handler(value.event, 'save'), /无权/)
  value.state.currentWindow = value.ownerWindow
  value.state.destroyed = true
  for (const handler of handlers) await assert.rejects(handler(value.event, 'save'), /无权/)
  assert.deepEqual(value.calls, [])
  assert.deepEqual(value.logs, [])
})

test('directory info comes from the service and cannot be replaced by caller-supplied paths', async () => {
  const value = fixture()
  assert.strictEqual(await value.invoke('directories', { saveDirectory: 'attacker' }), directories)
  assert.deepEqual(value.calls, [['prepare-directories']])
})

test('open-directory accepts only save/backup enums and only opens configured directory paths', async () => {
  const value = fixture()
  assert.deepEqual(await value.invoke('open-directory', 'save'), { ok: true })
  assert.deepEqual(await value.invoke('open-directory', 'backup'), { ok: true })
  assert.deepEqual(value.calls, [
    ['prepare-directories'], ['open-path', directories.saveDirectory],
    ['prepare-directories'], ['open-path', directories.backupDirectory],
  ])
  value.calls.length = 0
  for (const input of [selectedPath, '../../other', 'http://example.test', { path: selectedPath }, null, 'SAVE']) {
    const result = await value.invoke('open-directory', input)
    assert.equal(result.ok, false)
    assert.match(result.error, /保存目录或备份目录/)
  }
  assert.deepEqual(value.calls, [])
})

test('shell failures return classified directory errors rather than reporting success', async () => {
  const value = fixture({ shell: { async openPath() { return 'Access denied: private detail' } } })
  assert.deepEqual(await value.invoke('open-directory', 'backup'), {
    ok: false, error: '无法打开目录，请确认目录存在并有访问权限。',
  })
  value.shell.openPath = async () => { throw new Error('操作系统不能打开此目录') }
  assert.deepEqual(await value.invoke('open-directory', 'save'), {
    ok: false, error: '操作系统不能打开此目录',
  })
  assert.equal(value.logs.at(-1).message, 'Unable to complete .qy open-directory')
})

test('backup list forwards the source path, preserves damaged entries and reports discovery failures', async () => {
  const entry = { id: 'bad.qy', valid: false, error: '不是有效的 JSON' }
  const value = fixture({
    service: {
      async listBackups(actual) {
        assert.equal(actual, sourcePath)
        return { ...directories, entries: [backup, entry] }
      },
    },
  })
  assert.deepEqual(await value.invoke('backups', sourcePath), { ...directories, entries: [backup, entry] })
  value.service.listBackups = async () => { throw new Error('备份目录无法读取') }
  assert.deepEqual(await value.invoke('backups', sourcePath), { canceled: false, error: '备份目录无法读取' })
  assert.equal(value.calls.length, 0)
})

test('missing restore inputs, unknown IDs and damaged copies do not open a file picker', async () => {
  const value = fixture({
    service: {
      async listBackups() {
        return { ...directories, entries: [backup, { id: 'broken.qy', valid: false, error: '备份格式损坏' }] }
      },
    },
  })
  for (const input of [undefined, null, {}, [], { sourcePath }, { backupId }, { sourcePath: 7, backupId }]) {
    assert.match((await value.invoke('restore-backup', input)).error, /请选择/)
  }
  assert.deepEqual(await value.invoke('restore-backup', { sourcePath, backupId: 'unknown.qy' }), {
    canceled: false, error: '没有找到可恢复的备份。',
  })
  assert.deepEqual(await value.invoke('restore-backup', { sourcePath, backupId: 'broken.qy' }), {
    canceled: false, error: '备份格式损坏',
  })
  assert.deepEqual(value.calls, [])
})

test('restore picker is owned, keeps its receiver and proposes a sanitized qy filename', async () => {
  const value = fixture({
    service: {
      async listBackups() {
        return { ...directories, entries: [{ ...backup, title: '原:作品/集?' }] }
      },
    },
  })
  await value.invoke('restore-backup', { sourcePath, backupId })
  const [, actualOwner, options] = value.calls.find(([name]) => name === 'picker')
  assert.strictEqual(actualOwner, value.ownerWindow)
  assert.equal(options.title, '将备份恢复为新作品集')
  assert.equal(options.defaultPath, path.join(directories.saveDirectory, '原_作品_集_-恢复.qy'))
  assert.deepEqual(options.filters, [{ name: '叙事工坊作品集', extensions: ['qy'] }])
})

test('restore picker cancellation and empty selections stay cancellation without writes or recents', async () => {
  const value = fixture()
  for (const result of [{ canceled: true }, { canceled: false }, { canceled: false, filePath: '' }]) {
    value.dialog.showSaveDialog = async () => result
    assert.deepEqual(await value.invoke('restore-backup', { sourcePath, backupId }), { canceled: true })
  }
  assert.ok(value.calls.every(([name]) => name !== 'restore' && name !== 'remember'))
})

test('a native restore picker exception is returned accurately and does not execute restoration', async () => {
  const failure = new Error('文件选择框初始化失败')
  const value = fixture({
    dialog: { async showSaveDialog() { throw failure } },
  })
  assert.deepEqual(await value.invoke('restore-backup', { sourcePath, backupId }), {
    canceled: false, error: failure.message,
  })
  assert.ok(value.calls.every(([name]) => name !== 'restore' && name !== 'remember'))
  assert.strictEqual(value.logs[0].error, failure)
})

test('successful restoration uses the chosen path, returns its revision and remembers the new file', async () => {
  const value = fixture()
  const result = await value.invoke('restore-backup', {
    sourcePath, backupId, destinationPath: 'ignored-caller-destination',
  })
  assert.deepEqual(result, { canceled: false, ...value.restored })
  assert.deepEqual(value.calls.find(([name]) => name === 'restore'), [
    'restore', { sourcePath, backupId, destinationPath: selectedPath },
  ])
  assert.deepEqual(value.calls.at(-1), ['remember', selectedPath, value.restored.title])
})

test('a missing qy extension is appended to the actual picker selection', async () => {
  const filePath = path.resolve('fixture', '恢复副本')
  const value = fixture({ dialog: { async showSaveDialog() { return { canceled: false, filePath } } } })
  await value.invoke('restore-backup', { sourcePath, backupId })
  assert.deepEqual(value.calls.find(([name]) => name === 'restore'), [
    'restore', { sourcePath, backupId, destinationPath: `${filePath}.qy` },
  ])
})

test('recent-file bookkeeping failure cannot turn a successfully restored file into a save failure', async () => {
  const failure = new Error('最近作品集索引无法写入')
  const value = fixture({ async rememberFile() { throw failure } })
  assert.deepEqual(await value.invoke('restore-backup', { sourcePath, backupId }), {
    canceled: false, ...value.restored,
  })
  assert.strictEqual(value.logs.at(-1).error, failure)
  assert.equal(value.logs.at(-1).message, 'Unable to remember restored .qy portfolio')
})

test('restoration failures are reported and do not add an unsuccessful file to recents', async () => {
  const value = fixture({
    service: { async restoreBackup() { throw new Error('恢复目标已存在') } },
  })
  assert.deepEqual(await value.invoke('restore-backup', { sourcePath, backupId }), {
    canceled: false, error: '恢复目标已存在',
  })
  assert.ok(value.calls.every(([name]) => name !== 'remember'))
})

test('ownership is rechecked after backup discovery and before opening the native picker', async () => {
  const value = fixture()
  value.service.listBackups = async () => {
    value.state.destroyed = true
    return { ...directories, entries: [backup] }
  }
  const result = await value.invoke('restore-backup', { sourcePath, backupId })
  assert.equal(result.canceled, false)
  assert.match(result.error, /无权/)
  assert.deepEqual(value.calls, [])
})

for (const change of ['destroyed', 'replaced', 'main-frame']) {
  test(`ownership is rechecked after the restore picker resolves (${change}) before any write`, async () => {
    const value = fixture()
    value.dialog.showSaveDialog = async () => {
      if (change === 'destroyed') value.state.destroyed = true
      if (change === 'replaced') value.state.currentWindow = {
        isDestroyed: () => false, webContents: { mainFrame: {} },
      }
      if (change === 'main-frame') value.webContents.mainFrame = {}
      return { canceled: false, filePath: selectedPath }
    }
    const result = await value.invoke('restore-backup', { sourcePath, backupId })
    assert.equal(result.canceled, false)
    assert.match(result.error, /无权/)
    assert.ok(value.calls.every(([name]) => name !== 'restore' && name !== 'remember'))
  })
}

test('open-directory rechecks ownership after awaited directory discovery before invoking the shell', async () => {
  const value = fixture()
  value.service.prepareDirectories = async () => {
    value.state.destroyed = true
    return directories
  }
  const result = await value.invoke('open-directory', 'save')
  assert.equal(result.ok, false)
  assert.match(result.error, /无权/)
  assert.ok(value.calls.every(([name]) => name !== 'open-path'))
})

function portfolio() {
  return {
    format: 'qy',
    version: 2,
    kind: 'portfolio',
    portfolio: {
      id: 'original-portfolio',
      title: '测试作品集',
      createdAt: 1,
      updatedAt: 2,
      activeProjectId: 'original-project',
    },
    sharedContent: { styleRules: [], styleGroups: [] },
    projects: [{
      id: 'original-project',
      title: '测试作品',
      createdAt: 1,
      updatedAt: 2,
      content: {
        schemaVersion: 10, volumes: [], chapters: [], world: [], characters: [], items: [], skills: [],
        outline: [], contextBlocks: [], contextGroups: [],
        resourceGroups: { world: [], characters: [], items: [], skills: [] },
        worldEngine: {}, customModules: { schemas: [], entries: [] }, memes: { entries: [] },
      },
    }],
  }
}

async function realFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-generator-qy-files-ipc-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const saveRoot = path.join(root, '保存')
  const backupRoot = path.join(root, '备份')
  const source = path.join(root, 'source.qy')
  await fs.mkdir(backupRoot)
  const document = portfolio()
  await fs.writeFile(source, JSON.stringify(document))
  const id = `${qyBackupPrefix(source)}-2026-10-06T12-00-00-000Z.qy`
  const backupPath = path.join(backupRoot, id)
  await fs.writeFile(backupPath, JSON.stringify(document))
  const saveManager = createQySaveManager({ backupRoot })
  const service = createQyFilesService({ saveRoot, backupRoot, saveManager })
  const value = fixture({ service })
  return { ...value, root, saveRoot, backupRoot, source, id, backupPath, document }
}

test('real handler/service restoration saves a complete new portfolio with extension, revision and recents', async (t) => {
  const value = await realFixture(t)
  const chosen = path.join(value.root, '自选恢复')
  value.dialog.showSaveDialog = async (owner) => {
    assert.strictEqual(owner, value.ownerWindow)
    return { canceled: false, filePath: chosen }
  }
  const result = await value.invoke('restore-backup', { sourcePath: value.source, backupId: value.id })
  assert.equal(result.canceled, false)
  assert.equal(result.path, `${chosen}.qy`)
  assert.match(result.revision, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(result.document.portfolio.id, value.document.portfolio.id)
  assert.notEqual(result.document.projects[0].id, value.document.projects[0].id)
  assert.equal(result.document.portfolio.activeProjectId, result.document.projects[0].id)
  assert.deepEqual(JSON.parse(await fs.readFile(result.path, 'utf8')), result.document)
  assert.equal(await fs.readFile(value.source, 'utf8'), JSON.stringify(value.document))
  assert.equal(await fs.readFile(value.backupPath, 'utf8'), JSON.stringify(value.document))
  assert.deepEqual(value.calls.at(-1), ['remember', result.path, result.title])
})

test('real handler/service refuses source and preexisting targets selected in the native picker', async (t) => {
  const value = await realFixture(t)
  const existing = path.join(value.root, 'existing.qy')
  await fs.writeFile(existing, 'existing content')
  for (const filePath of [value.source, existing, path.join(value.backupRoot, 'new-backup.qy')]) {
    value.dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    const result = await value.invoke('restore-backup', { sourcePath: value.source, backupId: value.id })
    assert.equal(result.canceled, false)
    assert.ok(result.error)
  }
  assert.equal(await fs.readFile(value.source, 'utf8'), JSON.stringify(value.document))
  assert.equal(await fs.readFile(existing, 'utf8'), 'existing content')
  assert.equal(await fs.readFile(value.backupPath, 'utf8'), JSON.stringify(value.document))
  assert.ok(value.calls.every(([name]) => name !== 'remember'))
})

test('real malformed backups and unknown IDs are rejected before the native picker', async (t) => {
  const value = await realFixture(t)
  await fs.writeFile(value.backupPath, '{"invalid":')
  for (const id of [value.id, `${qyBackupPrefix(value.source)}-unknown.qy`]) {
    const result = await value.invoke('restore-backup', { sourcePath: value.source, backupId: id })
    assert.equal(result.canceled, false)
    assert.ok(result.error)
  }
  assert.ok(value.calls.every(([name]) => name !== 'picker' && name !== 'remember'))
  assert.equal(await fs.readFile(value.source, 'utf8'), JSON.stringify(value.document))
})
