import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../src/components/McpConnectionIndicator.vue', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../src/mcp/indicator.css', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const script = compileScript(descriptor, { id: 'mcp-indicator-regression', genDefaultAs: '__Indicator' })
const template = compileTemplate({
  source: descriptor.template.content, filename: 'McpConnectionIndicator.vue',
  id: 'mcp-indicator-regression', compilerOptions: { bindingMetadata: script.bindings },
})
assert.deepEqual(template.errors, [])

const mounted = []
const unmounted = []
const runtime = {
  ...Vue,
  onMounted: (handler) => mounted.push(handler),
  onBeforeUnmount: (handler) => unmounted.push(handler),
}
function evaluate(code) {
  const compiled = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)((id) => {
    if (id === 'vue') return runtime
    if (id.endsWith('.css')) return {}
    throw new Error(`Unexpected component dependency: ${id}`)
  }, module, module.exports)
  return module.exports
}
const component = evaluate(`${script.content}\nexports.component = __Indicator;`).component
const render = evaluate(template.code).render
const metadata = (overrides = {}) => ({
  enabled: true, port: 43127, url: 'http://127.0.0.1:43127/mcp', status: 'running',
  tokenConfigured: true, connected: false, connectionCount: 0, lastSeenAt: null,
  connectionLeaseMs: 90000, ...overrides,
})

function harness(t, bridge) {
  const previousWindow = globalThis.window
  globalThis.window = { desktopMcp: bridge }
  mounted.length = 0
  unmounted.length = 0
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup({}, { expose() {} }))
  const tree = () => render({}, [], {}, Vue.proxyRefs(state), {}, {})
  let stopped = false
  function close() {
    if (stopped) return
    stopped = true
    unmounted.forEach((handler) => handler())
    scope.stop()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  t.after(close)
  return { state, tree, mount: () => mounted[0](), close }
}

test('compiled title indicator distinguishes a running server from real client activity', async (t) => {
  let publish
  const view = harness(t, {
    info: async () => metadata(),
    onUpdate(callback) { publish = callback; return () => {} },
  })
  await view.mount()
  assert.equal(view.tree().props['aria-label'], 'MCP 未连接')
  assert.match(view.tree().props.title, /服务已启动/)
  assert.equal(view.state.connected.value, false)
  publish(metadata({ connected: true, connectionCount: 2, lastSeenAt: 1000 }))
  assert.equal(view.tree().props['aria-label'], 'MCP 已连接')
  assert.match(view.tree().props.class, /\bconnected\b/u)
  assert.match(view.tree().props.title, /2 个活跃连接组/u)
  publish(metadata({ connected: false, connectionCount: 0 }))
  assert.equal(view.tree().props['aria-label'], 'MCP 未连接')
  assert.match(view.tree().props.title, /90 秒/u)
  assert.match(view.tree().props.title, /直接 HTTP/u)
})

test('a stale IPC snapshot cannot overwrite a newer connection event and unmount disposes the subscription', async (t) => {
  let publish
  let resolveInfo
  let disposals = 0
  const view = harness(t, {
    info: () => new Promise((resolve) => { resolveInfo = resolve }),
    onUpdate(callback) { publish = callback; return () => { disposals += 1 } },
  })
  const loading = view.mount()
  publish(metadata({ connected: true, connectionCount: 1 }))
  resolveInfo(metadata())
  await loading
  assert.equal(view.state.connected.value, true)
  view.close()
  assert.equal(disposals, 1)
  publish(metadata({ connected: false, connectionCount: 0 }))
  assert.equal(view.state.connected.value, true)
})

test('indicator colors use the custom font/success/danger palette and it precedes saved state', () => {
  assert.match(css, /color:\s*var\(--theme-font\)/u)
  assert.match(css, /background:\s*var\(--theme-danger\)/u)
  assert.match(css, /connected[\s\S]*background:\s*var\(--theme-success\)/u)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu)
  const titleBar = fs.readFileSync(new URL('../src/components/DesktopTitleBar.vue', import.meta.url), 'utf8')
  assert.ok(titleBar.indexOf('<McpConnectionIndicator') < titleBar.indexOf('class="desktop-titlebar-save-icon"'))
})

test('unavailable or rejected metadata remains disconnected without crashing the title bar', async (t) => {
  const view = harness(t, {
    info: async () => { throw new Error('synthetic IPC unavailable') },
    onUpdate() { return () => {} },
  })
  await view.mount()
  assert.equal(view.tree().props['aria-label'], 'MCP 未连接')
  assert.match(view.tree().props.title, /当前不可用/u)
})
