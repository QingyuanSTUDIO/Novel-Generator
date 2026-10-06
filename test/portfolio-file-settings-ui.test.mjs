import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as icons from 'lucide-vue-next'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../src/components/PortfolioFileSettings.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const script = compileScript(descriptor, { id: 'portfolio-file-settings-regression', genDefaultAs: '__PortfolioFileSettings' })
const template = compileTemplate({
  source: descriptor.template.content,
  filename: 'PortfolioFileSettings.vue',
  id: 'portfolio-file-settings-regression',
  compilerOptions: { bindingMetadata: script.bindings },
})
assert.deepEqual(template.errors, [])

// Run the actual SFC's handlers, watchers, async reads, and Vue render function.
// Only DOM mounting and IPC are replaced; no user files or profile are touched.
let activeLifecycle
const runtime = {
  ...Vue,
  onMounted(callback) { activeLifecycle.mounted.push(callback) },
  onBeforeUnmount(callback) { activeLifecycle.unmounted.push(callback) },
}
function evaluate(code) {
  const output = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  const require = (id) => {
    if (id === 'vue') return runtime
    if (id === 'lucide-vue-next') return icons
    if (id.endsWith('.css')) return {}
    throw new Error(`Unexpected component import: ${id}`)
  }
  new Function('require', 'module', 'exports', output)(require, module, module.exports)
  return module.exports
}
const component = evaluate(`${script.content}\nexports.component = __PortfolioFileSettings;`).component
const render = evaluate(template.code).render

const directoryMetadata = { saveDirectory: 'E:\\Fixture\\保存', backupDirectory: 'E:\\Fixture\\备份' }
function backup(id, overrides = {}) {
  return {
    id, path: `E:\\Fixture\\备份\\${id}.qy`, title: `作品集 ${id}`,
    createdAt: Date.UTC(2026, 9, 6, 12), size: 2048, valid: true, projectCount: 2,
    ...overrides,
  }
}
function result(entries) {
  return { ...directoryMetadata, entries }
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() {
  await Vue.nextTick()
  await new Promise((resolve) => setImmediate(resolve))
}
function findNodes(node, matches, found = []) {
  if (!node || typeof node !== 'object') return found
  if (matches(node)) found.push(node)
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (Array.isArray(child)) child.forEach((entry) => findNodes(entry, matches, found))
    else findNodes(child, matches, found)
  }
  return found
}
function textContent(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node && typeof node === 'object') return textContent(node.children)
  return ''
}
function harness({ bridge, filePath = 'E:\\Fixture\\collection.qy', backupCount = 5 } = {}) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { desktopFile: bridge } })
  const lifecycle = { mounted: [], unmounted: [] }
  activeLifecycle = lifecycle
  const props = Vue.reactive({ filePath, backupCount, restoring: false, restoreError: '', restoreMessage: '', restoredPath: '' })
  const emitted = []
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup(props, {
    expose() {},
    emit(event, ...args) { emitted.push([event, ...args]) },
  }))
  lifecycle.mounted.forEach((callback) => callback())
  const tree = () => render({}, [], props, Vue.proxyRefs(state), {}, {})
  return {
    props, state, emitted, tree,
    nodes(matches) { return findNodes(tree(), matches) },
    button(label) {
      const node = findNodes(tree(), (entry) => entry.type === 'button' && (entry.props?.['aria-label'] === label || textContent(entry).includes(label)))[0]
      assert.ok(node, `the rendered "${label}" button must exist`)
      return node
    },
    close() {
      lifecycle.unmounted.forEach((callback) => callback())
      scope.stop()
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete globalThis.window
    },
  }
}

test('backup settings render disk metadata, disable damaged backups, and emit only valid restore requests', async () => {
  const view = harness({
    bridge: {
      directories: async () => directoryMetadata,
      backups: async () => result([
        backup('older', { createdAt: Date.UTC(2026, 9, 5) }),
        backup('damaged', { valid: false, error: '文件校验失败', createdAt: Date.UTC(2026, 9, 6, 16) }),
        backup('newer'),
      ]),
      openDirectory: async () => ({ ok: true }),
    },
  })
  try {
    await settle()
    assert.equal(view.state.loading.value, false)
    assert.deepEqual(view.state.backups.value.map((entry) => entry.id), ['damaged', 'newer', 'older'])
    const text = textContent(view.tree())
    assert.ok(text.includes(directoryMetadata.saveDirectory))
    assert.ok(text.includes(directoryMetadata.backupDirectory))
    assert.ok(text.includes(view.props.filePath))
    assert.ok(text.includes('2.0 KB'))
    assert.ok(text.includes('2 部作品'))
    assert.ok(text.includes('文件校验失败'))
    const damaged = view.button('将作品集 damaged恢复为新作品集')
    assert.equal(damaged.props.disabled, true)
    // The guard remains effective even if a disabled button's handler is called.
    damaged.props.onClick()
    assert.deepEqual(view.emitted, [])
    view.button('将作品集 newer恢复为新作品集').props.onClick()
    assert.deepEqual(view.emitted, [['restoreBackup', 'newer']])
    view.props.restoring = true
    view.button('将作品集 older恢复为新作品集').props.onClick()
    assert.deepEqual(view.emitted, [['restoreBackup', 'newer']])
  } finally { view.close() }
})

test('switching portfolio ignores delayed success and failure from the old backup pool', async () => {
  const oldRead = deferred()
  const newRead = deferred()
  const calls = []
  const view = harness({
    filePath: 'E:\\Fixture\\old.qy',
    bridge: {
      directories: async () => directoryMetadata,
      backups: (path) => { calls.push(path); return path.endsWith('old.qy') ? oldRead.promise : newRead.promise },
      openDirectory: async () => ({ ok: true }),
    },
  })
  try {
    await settle()
    assert.equal(view.state.loading.value, true)
    view.props.filePath = 'E:\\Fixture\\new.qy'
    await settle()
    newRead.resolve(result([backup('belongs-to-new')]))
    await settle()
    assert.equal(view.state.loading.value, false)
    assert.deepEqual(view.state.backups.value.map((entry) => entry.id), ['belongs-to-new'])
    oldRead.reject(new Error('旧作品集读取失败'))
    await settle()
    assert.equal(view.state.backupsError.value, '')
    assert.deepEqual(view.state.backups.value.map((entry) => entry.id), ['belongs-to-new'])
    assert.deepEqual(calls, ['E:\\Fixture\\old.qy', 'E:\\Fixture\\new.qy'])
    assert.ok(!textContent(view.tree()).includes('旧作品集读取失败'))
  } finally { view.close() }
})

test('a newer refresh wins over an older successful read and late replies after unmount', async () => {
  const first = deferred()
  const second = deferred()
  const third = deferred()
  let count = 0
  const view = harness({
    bridge: {
      directories: async () => directoryMetadata,
      backups: () => { count += 1; return [first, second, third][count - 1].promise },
      openDirectory: async () => ({ ok: true }),
    },
  })
  await settle()
  const next = view.state.refresh()
  await settle()
  second.resolve(result([backup('fresh')]))
  await next
  first.resolve(result([backup('stale')]))
  await settle()
  assert.deepEqual(view.state.backups.value.map((entry) => entry.id), ['fresh'])
  const afterClose = view.state.refresh()
  await settle()
  view.close()
  const oldState = view.state.backups.value
  third.resolve(result([backup('arrived-after-close')]))
  await afterClose
  assert.equal(view.state.backups.value, oldState, 'late replies must not change unmounted state')
  await view.state.refresh()
  assert.equal(view.state.backups.value, oldState, 'unmounted settings must not change state or make new reads')
  assert.equal(count, 3)
})

test('backup count, directory failures, and restored-file opening use their actual rendered handlers', async () => {
  const opened = []
  const view = harness({
    bridge: {
      directories: async () => directoryMetadata,
      backups: async () => result([]),
      openDirectory: async (kind) => { opened.push(kind); return { ok: false, error: '目录不能打开' } },
    },
  })
  try {
    await settle()
    const select = view.nodes((node) => node.type === 'select' && node.props?.['aria-label'] === '保留备份数量')[0]
    assert.ok(select)
    select.props.onChange({ target: { value: '0' } })
    select.props.onChange({ target: { value: '50' } })
    select.props.onChange({ target: { value: '99' } })
    assert.deepEqual(view.emitted, [['updateBackupCount', 0], ['updateBackupCount', 50]])
    assert.equal(view.props.backupCount, 5, 'the component never directly mutates saved settings')
    await view.button('打开保存目录').props.onClick()
    assert.deepEqual(opened, ['save'])
    assert.equal(view.state.actionError.value, '目录不能打开')
    assert.ok(textContent(view.tree()).includes('目录不能打开'))
    view.props.restoreMessage = '已恢复为新文件'
    view.props.restoredPath = 'E:\\Fixture\\recovered.qy'
    view.button('打开恢复的作品集').props.onClick()
    assert.deepEqual(view.emitted.at(-1), ['openRestoredBackup', 'E:\\Fixture\\recovered.qy'])
    view.props.restoring = true
    view.button('打开恢复的作品集').props.onClick()
    assert.equal(view.emitted.filter(([event]) => event === 'openRestoredBackup').length, 1)
  } finally { view.close() }
})

test('an unsaved portfolio reads directories only and handles absent desktop capability', async () => {
  let backupReads = 0
  const view = harness({
    filePath: '',
    bridge: {
      directories: async () => directoryMetadata,
      backups: async () => { backupReads += 1; return result([]) },
      openDirectory: async () => ({ ok: true }),
    },
  })
  try {
    await settle()
    assert.equal(backupReads, 0)
    assert.ok(textContent(view.tree()).includes('当前作品集尚未保存'))
    assert.ok(textContent(view.tree()).includes(directoryMetadata.backupDirectory))
  } finally { view.close() }
  const unavailable = harness()
  try {
    assert.equal(unavailable.state.loading.value, false)
    assert.ok(textContent(unavailable.tree()).includes('作品文件管理需要桌面环境'))
    assert.equal(unavailable.nodes((node) => node.type === 'select').length, 0)
  } finally { unavailable.close() }
})

test('sync IPC errors and malformed backup times display safely without keeping a loading screen', async () => {
  const view = harness({
    bridge: {
      directories() { throw new Error('目录读取失败') },
      backups: async () => result([backup('metadata-time-invalid', { createdAt: 1e20 })]),
      openDirectory: async () => ({ ok: true }),
    },
  })
  try {
    await settle()
    assert.equal(view.state.loading.value, false)
    assert.equal(view.state.directoriesError.value, '目录读取失败')
    assert.deepEqual(view.state.directories.value, directoryMetadata)
    assert.doesNotThrow(() => view.tree())
    assert.ok(textContent(view.tree()).includes('时间未知'))
  } finally { view.close() }
})
