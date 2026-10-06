import assert from 'node:assert/strict'
import nativeFs from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createQyFilesService } from '../electron/qy-files.mjs'
import { createQySaveManager, qyBackupPrefix } from '../electron/qy-save.mjs'

function content(seed) {
  return {
    schemaVersion: 10,
    volumes: [{ id: `volume-${seed}`, title: `分卷${seed}`, collapsed: true }],
    chapters: [{ id: `chapter-${seed}`, volumeId: `volume-${seed}`, title: `章节${seed}`, content: '原始正文' }],
    world: [{ id: `world-${seed}`, title: `世界${seed}`, fields: { content: '完整资料', tags: ['词条'] } }],
    characters: [{ id: `character-${seed}`, title: `角色${seed}`, fields: { gender: '女', appearance: '短发' } }],
    items: [],
    skills: [],
    outline: [{ id: `outline-${seed}`, title: '大纲', fields: { goal: '目标' } }],
    contextBlocks: [{ id: `block-${seed}`, title: '排序', enabled: true }],
    contextGroups: [],
    resourceGroups: { world: [{ id: `group-${seed}`, title: '分组', collapsed: true }], characters: [], items: [], skills: [] },
    worldEngine: { currentTime: '第一天', events: [] },
    customModules: { schemas: [{ id: `schema-${seed}`, title: '势力' }], entries: [] },
    memes: { entries: [], updatedAt: 2 },
  }
}

function portfolio(projectCount = 2) {
  const projects = Array.from({ length: projectCount }, (_, index) => ({
    id: `project-${index}`,
    title: `作品${index}`,
    createdAt: 1,
    updatedAt: 2,
    content: content(String(index)),
  }))
  return {
    format: 'qy',
    version: 2,
    kind: 'portfolio',
    portfolio: {
      id: 'portfolio-original',
      title: '双作品作品集',
      createdAt: 1,
      updatedAt: 2,
      activeProjectId: projects.at(-1)?.id || '',
    },
    sharedContent: {
      styleRules: [{ id: 'style-original', title: '文风', fields: { rule: '自然叙述' }, enabled: true }],
      styleGroups: [{ id: 'style-group', title: '基础规则', collapsed: false }],
    },
    projects,
  }
}

async function fixture(t, saveManagerOverride) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-generator-qy-files-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const saveRoot = path.join(root, '保存')
  const backupRoot = path.join(root, '备份')
  const sourcePath = path.join(root, 'source', '作品集.qy')
  const manager = createQySaveManager({ backupRoot })
  const service = createQyFilesService({
    saveRoot, backupRoot, saveManager: saveManagerOverride || manager,
  })
  await fs.mkdir(backupRoot, { recursive: true })
  async function addBackup(value = portfolio(), source = sourcePath, suffix = '2026-10-06T10-00-00-000Z') {
    const id = `${qyBackupPrefix(source)}-${suffix}.qy`
    const backupPath = path.join(backupRoot, id)
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    await fs.writeFile(backupPath, text, 'utf8')
    return { id, path: backupPath, text, document: value }
  }
  return { root, saveRoot, backupRoot, sourcePath, manager, service, addBackup }
}

test('directory information reports absolute configured locations and listing creates them', async (t) => {
  const { service, saveRoot, backupRoot, sourcePath } = await fixture(t)
  assert.deepEqual(service.directories(), { saveDirectory: saveRoot, backupDirectory: backupRoot })
  const result = await service.listBackups(sourcePath)
  assert.deepEqual(result, { ...service.directories(), entries: [] })
  assert.ok((await fs.stat(saveRoot)).isDirectory())
  assert.ok((await fs.stat(backupRoot)).isDirectory())
})

test('preparing directories creates local save and backup locations without requiring any portfolio', async (t) => {
  const { service, saveRoot, backupRoot } = await fixture(t)
  await fs.rmdir(backupRoot)
  assert.deepEqual(await service.prepareDirectories(), {
    saveDirectory: saveRoot, backupDirectory: backupRoot,
  })
  assert.ok((await fs.stat(saveRoot)).isDirectory())
  assert.ok((await fs.stat(backupRoot)).isDirectory())
  assert.deepEqual(await fs.readdir(saveRoot), [])
  assert.deepEqual(await fs.readdir(backupRoot), [])
  assert.deepEqual(await service.prepareDirectories(), service.directories())
})

test('backup discovery isolates the complete source path and returns valid metadata', async (t) => {
  const { root, service, sourcePath, addBackup } = await fixture(t)
  const included = await addBackup()
  await addBackup(portfolio(), path.join(root, 'other', '作品集.qy'))
  await fs.writeFile(path.join(root, '备份', 'unrelated.qy'), '{}')
  const { entries } = await service.listBackups(sourcePath)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, included.id)
  assert.equal(entries[0].path, included.path)
  assert.equal(entries[0].title, '双作品作品集')
  assert.equal(entries[0].projectCount, 2)
  assert.equal(entries[0].valid, true)
  assert.ok(entries[0].createdAt > 0)
  assert.equal(entries[0].size, Buffer.byteLength(included.text))
  assert.equal('error' in entries[0], false)
})

test('malformed JSON and invalid portfolio envelopes remain visible with errors', async (t) => {
  const { service, sourcePath, addBackup } = await fixture(t)
  await addBackup('{"broken":', sourcePath, 'broken-json')
  await addBackup({ format: 'qy', version: 1 }, sourcePath, 'legacy')
  const invalid = portfolio()
  invalid.projects[0].content.providers = [{ key: 'secret' }]
  await addBackup(invalid, sourcePath, 'settings-leak')
  const { entries } = await service.listBackups(sourcePath)
  assert.equal(entries.length, 3)
  assert.ok(entries.every((entry) => entry.valid === false && typeof entry.error === 'string'))
  assert.ok(entries.find((entry) => entry.id.includes('broken-json')).error.includes('JSON'))
  assert.ok(entries.find((entry) => entry.id.includes('legacy')).error.includes('version'))
  assert.ok(entries.find((entry) => entry.id.includes('settings-leak')).error.includes('providers'))
  assert.ok(entries.every((entry) => !('document' in entry)))
})

test('restore creates a new file through the save manager and preserves all contents', async (t) => {
  const { service, saveRoot, sourcePath, addBackup } = await fixture(t)
  const original = portfolio()
  const backup = await addBackup(original)
  const result = await service.restoreBackup({ sourcePath, backupId: backup.id })
  assert.equal(result.path, path.join(saveRoot, '双作品作品集-恢复.qy'))
  assert.equal(result.title, original.portfolio.title)
  assert.match(result.revision, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(JSON.parse(await fs.readFile(result.path, 'utf8')), result.document)
  assert.notEqual(result.document.portfolio.id, original.portfolio.id)
  assert.ok(result.document.projects.every((project) => !original.projects.some((old) => old.id === project.id)))
  assert.equal(new Set(result.document.projects.map((project) => project.id)).size, 2)
  assert.equal(result.document.portfolio.activeProjectId, result.document.projects[1].id)
  assert.deepEqual(result.document.sharedContent, original.sharedContent)
  for (const [index, project] of result.document.projects.entries()) {
    assert.deepEqual(project.content, original.projects[index].content)
    assert.equal(project.createdAt, original.projects[index].createdAt)
    assert.equal(project.updatedAt, original.projects[index].updatedAt)
  }
  assert.equal(await fs.readFile(backup.path, 'utf8'), backup.text)
  assert.deepEqual((await fs.readdir(saveRoot)).filter((name) => name.endsWith('.tmp')), [])
})

test('restoring an empty portfolio keeps an empty active project', async (t) => {
  const { service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup(portfolio(0))
  const { document } = await service.restoreBackup({ sourcePath, backupId: backup.id })
  assert.notEqual(document.portfolio.id, 'portfolio-original')
  assert.equal(document.portfolio.activeProjectId, '')
  assert.deepEqual(document.projects, [])
})

test('repeated restoration uses independent portfolio/project identities', async (t) => {
  const { root, service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup()
  const first = await service.restoreBackup({ sourcePath, backupId: backup.id, destinationPath: path.join(root, 'first.qy') })
  const second = await service.restoreBackup({ sourcePath, backupId: backup.id, destinationPath: path.join(root, 'second.qy') })
  assert.notEqual(first.document.portfolio.id, second.document.portfolio.id)
  assert.ok(second.document.projects.every((project) => !first.document.projects.some((old) => old.id === project.id)))
})

test('a custom destination creates missing directories and appends the qy extension', async (t) => {
  const { root, service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup()
  const destination = path.join(root, 'new-directory', '自选恢复')
  const result = await service.restoreBackup({ sourcePath, backupId: backup.id, destinationPath: destination })
  assert.equal(result.path, `${destination}.qy`)
  assert.deepEqual(JSON.parse(await fs.readFile(result.path, 'utf8')), result.document)
})

test('restore refuses the source path without changing its bytes', async (t) => {
  const { service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup()
  await fs.mkdir(path.dirname(sourcePath), { recursive: true })
  await fs.writeFile(sourcePath, 'current live source')
  await assert.rejects(
    service.restoreBackup({ sourcePath, backupId: backup.id, destinationPath: sourcePath }),
    { code: 'QY_RESTORE_TARGET_INVALID' },
  )
  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'current live source')
})

test('restore never overwrites a preexisting target or default restored file', async (t) => {
  const { root, service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup()
  const destinationPath = path.join(root, 'existing.qy')
  await fs.writeFile(destinationPath, 'existing file')
  await assert.rejects(service.restoreBackup({ sourcePath, backupId: backup.id, destinationPath }), {
    code: 'QY_RESTORE_TARGET_EXISTS',
  })
  assert.equal(await fs.readFile(destinationPath, 'utf8'), 'existing file')
  const first = await service.restoreBackup({ sourcePath, backupId: backup.id })
  const firstBytes = await fs.readFile(first.path, 'utf8')
  await assert.rejects(service.restoreBackup({ sourcePath, backupId: backup.id }), { code: 'QY_RESTORE_TARGET_EXISTS' })
  assert.equal(await fs.readFile(first.path, 'utf8'), firstBytes)
})

test('the atomic create-only pipeline rejects a target created during restoration', async (t) => {
  let manager
  const override = {
    async write(filePath, text, count, options) {
      assert.deepEqual(options, { createOnly: true })
      assert.equal(count, 0)
      await fs.writeFile(filePath, 'another writer won')
      return manager.write(filePath, text, count, options)
    },
  }
  const context = await fixture(t, override)
  manager = context.manager
  const backup = await context.addBackup()
  const destinationPath = path.join(context.root, 'concurrent.qy')
  await assert.rejects(context.service.restoreBackup({
    sourcePath: context.sourcePath, backupId: backup.id, destinationPath,
  }), { code: 'QY_FILE_CONFLICT' })
  assert.equal(await fs.readFile(destinationPath, 'utf8'), 'another writer won')
  assert.equal(await fs.readFile(backup.path, 'utf8'), backup.text)
})

test('a restore target inside the backup directory is refused, including normalized traversal', async (t) => {
  const { backupRoot, service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup()
  for (const destinationPath of [
    path.join(backupRoot, 'restored.qy'),
    path.join(backupRoot, 'nested', 'restored.qy'),
    path.join(backupRoot, '..', path.basename(backupRoot), 'restored.qy'),
  ]) {
    await assert.rejects(service.restoreBackup({ sourcePath, backupId: backup.id, destinationPath }), {
      code: 'QY_RESTORE_TARGET_INVALID',
    })
  }
  assert.deepEqual(await fs.readdir(backupRoot), [backup.id])
})

test('unsafe IDs and backups belonging to another pool cannot be restored', async (t) => {
  const { root, service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup()
  const other = await addBackup(portfolio(), path.join(root, 'other.qy'))
  for (const backupId of [
    `../${backup.id}`,
    `..\\${backup.id}`,
    backup.path,
    other.id,
    `${qyBackupPrefix(sourcePath)}-/escape.qy`,
    `${qyBackupPrefix(sourcePath)}-stream:secret.qy`,
    `${qyBackupPrefix(sourcePath)}-\0.qy`,
    undefined,
  ]) {
    await assert.rejects(service.restoreBackup({ sourcePath, backupId }), { code: 'QY_BACKUP_ID_INVALID' })
  }
})

test('a matching directory is visible as invalid and cannot be restored', async (t) => {
  const { backupRoot, service, sourcePath } = await fixture(t)
  const id = `${qyBackupPrefix(sourcePath)}-directory.qy`
  await fs.mkdir(path.join(backupRoot, id))
  const { entries } = await service.listBackups(sourcePath)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].valid, false)
  assert.ok(entries[0].error.includes('普通文件'))
  await assert.rejects(service.restoreBackup({ sourcePath, backupId: id }), { code: 'QY_BACKUP_INVALID' })
})

test('invalid portfolios cannot be restored and never publish a destination', async (t) => {
  const { saveRoot, service, sourcePath, addBackup } = await fixture(t)
  const invalid = portfolio()
  invalid.portfolio.activeProjectId = 'unknown'
  const backup = await addBackup(invalid)
  await assert.rejects(service.restoreBackup({ sourcePath, backupId: backup.id }), {
    name: 'QyPortfolioValidationError',
  })
  assert.deepEqual(await fs.readdir(saveRoot), [])
})

async function createDirectoryLink(t, target, linkedPath) {
  try {
    await fs.symlink(target, linkedPath, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Directory links unavailable: ${error.code}`)
      return false
    }
    throw error
  }
}

test('backup-directory junctions cannot expose a different directory', async (t) => {
  const { root, saveRoot, backupRoot, sourcePath, manager } = await fixture(t)
  const realRoot = path.join(root, 'real-backups')
  await fs.rename(backupRoot, realRoot)
  if (!await createDirectoryLink(t, realRoot, backupRoot)) return
  const service = createQyFilesService({ saveRoot, backupRoot, saveManager: manager })
  await assert.rejects(service.listBackups(sourcePath), { code: 'QY_BACKUP_PATH_UNSAFE' })
})

test('restore cannot follow a linked destination directory', async (t) => {
  const { root, service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup()
  const outside = path.join(root, 'actual-destination')
  await fs.mkdir(outside)
  const link = path.join(root, 'linked-destination')
  if (!await createDirectoryLink(t, outside, link)) return
  await assert.rejects(service.restoreBackup({
    sourcePath, backupId: backup.id, destinationPath: path.join(link, 'restored.qy'),
  }), { code: 'QY_BACKUP_PATH_UNSAFE' })
  assert.deepEqual(await fs.readdir(outside), [])
})

test('a linked backup entry stays invalid and its target is never read', async (t) => {
  const { root, backupRoot, service, sourcePath } = await fixture(t)
  const actual = path.join(root, 'outside.qy')
  await fs.writeFile(actual, JSON.stringify(portfolio()))
  const id = `${qyBackupPrefix(sourcePath)}-linked.qy`
  try {
    await fs.symlink(actual, path.join(backupRoot, id), 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`File symlinks unavailable: ${error.code}`)
      return
    }
    throw error
  }
  const { entries } = await service.listBackups(sourcePath)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].valid, false)
  assert.ok(entries[0].error.includes('符号链接'))
  await assert.rejects(service.restoreBackup({ sourcePath, backupId: id }), { code: 'QY_BACKUP_PATH_UNSAFE' })
  assert.equal(await fs.readFile(actual, 'utf8'), JSON.stringify(portfolio()))
})

test('symlink detection rejects reading and restoring even without OS link-creation privileges', async (t) => {
  const { saveRoot, backupRoot, sourcePath, manager, addBackup } = await fixture(t)
  const backup = await addBackup()
  let reads = 0
  const fsImpl = {
    constants: nativeFs.constants,
    promises: {
      ...nativeFs.promises,
      async lstat(target, ...args) {
        const stat = await fs.lstat(target, ...args)
        if (target === backup.path) stat.isSymbolicLink = () => true
        return stat
      },
      async open(...args) {
        reads += 1
        return fs.open(...args)
      },
    },
  }
  const service = createQyFilesService({ saveRoot, backupRoot, saveManager: manager, fsImpl })
  const { entries } = await service.listBackups(sourcePath)
  assert.equal(entries[0].valid, false)
  assert.ok(entries[0].error.includes('符号链接'))
  await assert.rejects(service.restoreBackup({ sourcePath, backupId: backup.id }), {
    code: 'QY_BACKUP_PATH_UNSAFE',
  })
  assert.equal(reads, 0)
  assert.equal(await fs.readFile(backup.path, 'utf8'), backup.text)
  assert.deepEqual(await fs.readdir(saveRoot), [])
})

test('backup replacement while opening is detected before its data is accepted', async (t) => {
  const { saveRoot, backupRoot, sourcePath, manager, addBackup } = await fixture(t)
  const backup = await addBackup()
  const replacement = `${backup.path}.replacement`
  await fs.writeFile(replacement, JSON.stringify(portfolio(0)))
  let swapped = false
  const fsImpl = {
    constants: nativeFs.constants,
    promises: {
      ...nativeFs.promises,
      async open(target, ...args) {
        if (target === backup.path && !swapped) {
          swapped = true
          await fs.rename(target, `${target}.original`)
          await fs.rename(replacement, target)
        }
        return fs.open(target, ...args)
      },
    },
  }
  const service = createQyFilesService({ saveRoot, backupRoot, saveManager: manager, fsImpl })
  await assert.rejects(service.restoreBackup({ sourcePath, backupId: backup.id }), {
    code: 'QY_BACKUP_PATH_UNSAFE',
  })
  assert.deepEqual(await fs.readdir(saveRoot), [])
})

test('relative restore destinations are refused instead of using the process directory', async (t) => {
  const { service, sourcePath, addBackup } = await fixture(t)
  const backup = await addBackup()
  await assert.rejects(service.restoreBackup({
    sourcePath, backupId: backup.id, destinationPath: 'relative.qy',
  }), { code: 'QY_RESTORE_TARGET_INVALID' })
})

test('default restored filenames sanitize characters while preserving portfolio title', async (t) => {
  const { service, sourcePath, addBackup } = await fixture(t)
  const original = portfolio()
  original.portfolio.title = '奇怪:标题/目录?'
  const backup = await addBackup(original)
  const result = await service.restoreBackup({ sourcePath, backupId: backup.id })
  assert.equal(path.basename(result.path), '奇怪_标题_目录_-恢复.qy')
  assert.equal(result.document.portfolio.title, original.portfolio.title)
})
