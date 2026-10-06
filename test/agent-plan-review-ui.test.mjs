import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

for (const file of ['AgentPanel.vue', 'ConsolePanel.vue']) {
  test(`${file} compiles the structured Agent plan review with legacy fallback`, () => {
    const source = fs.readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8')
    const { descriptor } = parse(source, { filename: file })
    const script = compileScript(descriptor, { id: `agent-plan-review-${file}`, genDefaultAs: '__PlanReview' })
    const template = compileTemplate({
      source: descriptor.template.content,
      filename: file,
      id: `agent-plan-review-${file}`,
      compilerOptions: { bindingMetadata: script.bindings },
    })
    assert.deepEqual(template.errors, [])
    assert.match(source, /pendingPlan\.reviews\?\.length|result\.plan\.reviews\?\.length/u)
    assert.match(source, /before/u)
    assert.match(source, /after/u)
    assert.match(source, /清空/u)
    assert.match(source, /v-else/u)
    assert.match(source, /targetPath/u)
  })
}
