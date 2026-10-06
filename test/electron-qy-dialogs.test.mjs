import assert from 'node:assert/strict'
import { test } from 'node:test'
import { showOwnedQyFileDialog } from '../electron/qy-dialogs.mjs'

for (const mode of ['open', 'save']) {
  test(`${mode} file picker keeps its Electron receiver and is owned by the requesting window`, async () => {
    const ownerWindow = { isDestroyed: () => false }
    const options = { title: '选择作品集', filters: [{ name: '作品集', extensions: ['qy'] }] }
    const expected = mode === 'open' ? { canceled: false, filePaths: ['E:\\作品集.qy'] } : { canceled: false, filePath: 'E:\\作品集.qy' }
    const dialog = {
      async [mode === 'open' ? 'showOpenDialog' : 'showSaveDialog'](owner, actualOptions) {
        assert.strictEqual(this, dialog)
        assert.strictEqual(owner, ownerWindow)
        assert.strictEqual(actualOptions, options)
        return expected
      },
    }
    assert.strictEqual(await showOwnedQyFileDialog({ dialog, ownerWindow, mode, options }), expected)
  })

  test(`${mode} picker cancellation remains cancellation and a native exception returns its concrete error`, async () => {
    const ownerWindow = { isDestroyed: () => false }
    const logs = []
    const method = mode === 'open' ? 'showOpenDialog' : 'showSaveDialog'
    const canceled = { canceled: true }
    const dialog = { async [method]() { return canceled } }
    assert.strictEqual(await showOwnedQyFileDialog({ dialog, ownerWindow, mode, options: {} }), canceled)

    const failure = new Error('原生文件选择框启动失败。')
    dialog[method] = async function () { throw failure }
    const result = await showOwnedQyFileDialog({
      dialog, ownerWindow, mode, options: {},
      logger: (message, error) => logs.push({ message, error }),
    })
    assert.deepEqual(result, { canceled: false, error: failure.message })
    assert.strictEqual(logs[0].error, failure)
  })
}

test('a destroyed owner uses Electron options-only overload rather than passing a stale window', async () => {
  const options = { title: '保存作品集' }
  const result = await showOwnedQyFileDialog({
    dialog: {
      async showSaveDialog(...args) {
        assert.equal(args.length, 1)
        assert.strictEqual(args[0], options)
        return { canceled: true }
      },
    },
    ownerWindow: { isDestroyed: () => true },
    mode: 'save',
    options,
  })
  assert.deepEqual(result, { canceled: true })
})
