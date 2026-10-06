import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as icons from 'lucide-vue-next'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../src/components/McpSettings.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const script = compileScript(descriptor, { id: 'mcp-ui-regression', genDefaultAs: '__McpSettings' })
const template = compileTemplate({
  source: descriptor.template.content,
  filename: 'McpSettings.vue',
  id: 'mcp-ui-regression',
  compilerOptions: { bindingMetadata: script.bindings },
})
assert.deepEqual(template.errors, [])

// Compile the actual SFC and its actual event handler. Lifecycle hooks and the
// unrelated checkbox directive are omitted so this test never touches IPC,
// the DOM, or user settings; refs/computed/rendering are the real Vue runtime.
const runtime = {
  ...Vue,
  onMounted() {},
  onBeforeUnmount() {},
  withDirectives: (vnode) => vnode,
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

const component = evaluate(`${script.content}\nexports.component = __McpSettings;`).component
const render = evaluate(template.code).render

function findNode(node, matches) {
  if (!node || typeof node !== 'object') return undefined
  if (matches(node)) return node
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = Array.isArray(child)
      ? child.map((entry) => findNode(entry, matches)).find(Boolean)
      : findNode(child, matches)
    if (found) return found
  }
}

function harness() {
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup({}, { expose() {} }))
  state.receiveInfo({
    enabled: false, port: 43127, url: 'http://127.0.0.1:43127/mcp',
    status: 'disabled', tokenConfigured: true,
    connected: false, connectionCount: 0, lastSeenAt: null, connectionLeaseMs: 90000,
  })
  state.available.value = true
  state.loading.value = false
  const tree = () => render({}, [], {}, Vue.proxyRefs(state), {}, {})
  return {
    state,
    input(value) {
      const field = findNode(tree(), (node) => node.type === 'input' && node.props?.['aria-label'] === 'MCP 本机端口')
      assert.ok(field, 'the rendered MCP port field must exist')
      const handlers = Array.isArray(field.props.onInput) ? field.props.onInput : [field.props.onInput]
      for (const handler of handlers) handler({ target: { value } })
      return tree()
    },
    close() { scope.stop() },
  }
}

test('editing the numeric MCP port keeps the actual compiled input draft as text', () => {
  const view = harness()
  try {
    view.state.savedFeedback.value = 'old success'
    view.input('54321')
    assert.equal(view.state.draftPort.value, '54321')
    assert.equal(typeof view.state.draftPort.value, 'string')
    assert.equal(view.state.savedFeedback.value, '')
    assert.equal(view.state.validPort.value, true)
    assert.equal(view.state.canApply.value, true)
    assert.equal(view.state.live.value.port, 43127, 'typing must not alter applied service settings')
  } finally { view.close() }
})

test('blank, invalid, and boundary port edits remain renderable and validate consistently', () => {
  const view = harness()
  try {
    for (const [value, valid] of [
      ['', false], ['1023', false], ['1024', true], ['65535', true],
      ['65536', false], ['43127.5', false], ['5e4', true],
    ]) {
      assert.doesNotThrow(() => view.input(value), `rendering port "${value}" must not crash`)
      assert.equal(view.state.draftPort.value, value)
      assert.equal(typeof view.state.draftPort.value, 'string')
      assert.equal(view.state.validPort.value, valid, value)
      assert.equal(view.state.canApply.value, valid, value)
    }
  } finally { view.close() }
})
