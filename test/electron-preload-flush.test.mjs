import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

test('the actual preload bridge sends cancellation and errors with the original request ID', () => {
  const exposed = new Map()
  const sent = []
  const ipcRenderer = new EventEmitter()
  ipcRenderer.send = (channel, payload) => sent.push({ channel, payload })
  vm.runInNewContext(fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    require(module) {
      assert.equal(module, 'electron')
      return {
        ipcRenderer,
        contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
      }
    },
  })
  const storage = exposed.get('desktopStorage')
  storage.completeFlush(42, { saved: false, canceled: true, error: '用户取消了保存。', requestId: 99 })
  assert.equal(sent[0].channel, 'desktop:flush-complete')
  assert.equal(sent[0].payload.requestId, 42)
  assert.equal(sent[0].payload.saved, false)
  assert.equal(sent[0].payload.canceled, true)
  assert.equal(sent[0].payload.error, '用户取消了保存。')

  storage.completeFlush(43, { saved: true })
  assert.equal(sent[1].payload.saved, true)
  assert.equal(sent[1].payload.canceled, false)
  assert.equal(Object.hasOwn(sent[1].payload, 'error'), false)
})
