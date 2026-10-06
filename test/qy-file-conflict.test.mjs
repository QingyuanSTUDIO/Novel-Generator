import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope } from 'vue'
import { useQyFileConflict } from '../src/composables/useQyFileConflict.ts'

const oldRevision = `sha256:${'a'.repeat(64)}`
const newRevision = `sha256:${'b'.repeat(64)}`
const conflictPath = 'E:\\Fixture\\disk.qy'
function conflict(overrides = {}) {
  return { path: conflictPath, expectedRevision: oldRevision, actualRevision: newRevision, kind: 'modified', ...overrides }
}
function file(overrides = {}) {
  return {
    canceled: false, path: conflictPath, title: '磁盘作品集', revision: newRevision,
    document: { id: 'disk-portfolio' }, ...overrides,
  }
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}
function fixture(overrides = {}) {
  const target = { path: 'E:\\Fixture\\source.qy', portfolioId: 'source-portfolio', generation: 3 }
  const calls = { stopped: 0, before: 0, read: [], applied: [], saves: 0 }
  let editable = '作者未保存内容'
  const scope = effectScope()
  const controller = scope.run(() => useQyFileConflict({
    getTarget: () => target,
    stopAutoSave() { calls.stopped += 1 },
    beforeReload: async () => { calls.before += 1 },
    readFile: async (path) => { calls.read.push(path); return file() },
    applyFile: async (result) => { calls.applied.push(result); editable = '磁盘内容' },
    saveAs: async () => { calls.saves += 1; return { saved: true } },
    ...overrides,
  }))
  return { controller, scope, target, calls, content: () => editable }
}

test('report suspends auto-save, dismiss retains the conflict, and explicit reload applies the conflicting disk path', async () => {
  const f = fixture()
  try {
    const initial = conflict()
    f.controller.report(initial)
    initial.path = 'E:\\Fixture\\mutated-input.qy'
    assert.equal(f.calls.stopped, 1)
    assert.equal(f.controller.open.value, true)
    assert.equal(f.controller.conflict.value.path, conflictPath, 'reports capture an independent conflict value')
    f.controller.dismiss()
    assert.equal(f.controller.open.value, false)
    assert.notEqual(f.controller.conflict.value, null)
    f.controller.reopen()
    assert.equal(f.controller.open.value, true)
    assert.equal(await f.controller.reload(), true)
    assert.equal(f.calls.before, 1)
    assert.deepEqual(f.calls.read, [conflictPath], 'reload reads the target of the conflict, which may be a Save As destination')
    assert.equal(f.calls.applied.length, 1)
    assert.equal(f.content(), '磁盘内容')
    assert.equal(f.controller.conflict.value, null)
    assert.equal(f.controller.open.value, false)
    assert.equal(f.controller.busy.value, false)
    assert.equal(f.controller.error.value, '')
  } finally { f.scope.stop() }
})

test('missing files cannot be reloaded and keep the current edits and conflict available', async () => {
  const f = fixture()
  try {
    f.controller.report(conflict({ kind: 'missing', actualRevision: null }))
    assert.equal(await f.controller.reload(), false)
    assert.equal(f.calls.before, 0)
    assert.equal(f.calls.read.length, 0)
    assert.equal(f.calls.applied.length, 0)
    assert.equal(f.content(), '作者未保存内容')
    assert.match(f.controller.error.value, /不存在/)
    assert.notEqual(f.controller.conflict.value, null)
    assert.equal(f.controller.open.value, true)
    assert.equal(f.controller.busy.value, false)
  } finally { f.scope.stop() }
})

test('reload keeps edits when preparing, reading, validating, or applying fails', async (t) => {
  for (const [name, overrides, pattern] of [
    ['preparation', { beforeReload: async () => { throw new Error('保存队列未能排空') } }, /保存队列/],
    ['read rejection', { readFile: async () => { throw new Error('磁盘不可读') } }, /磁盘不可读/],
    ['read error result', { readFile: async () => file({ error: '文件校验失败' }) }, /文件校验失败/],
    ['absent revision', { readFile: async () => file({ revision: undefined }) }, /文件版本/],
    ['invalid revision', { readFile: async () => file({ revision: 'opaque-version' }) }, /文件版本/],
    ['absent document', { readFile: async () => file({ document: undefined }) }, /作品集内容/],
    ['strict parse', { applyFile: async () => { throw new Error('不是合法的 v2 作品集') } }, /合法/],
  ]) {
    await t.test(name, async () => {
      const f = fixture(overrides)
      try {
        f.controller.report(conflict())
        assert.equal(await f.controller.reload(), false)
        assert.equal(f.content(), '作者未保存内容')
        assert.match(f.controller.error.value, pattern)
        assert.notEqual(f.controller.conflict.value, null)
        assert.equal(f.controller.open.value, true)
        assert.equal(f.controller.busy.value, false)
      } finally { f.scope.stop() }
    })
  }
})

test('a canceled read does not apply or clear the conflict', async () => {
  const f = fixture({ readFile: async () => ({ canceled: true }) })
  try {
    f.controller.report(conflict())
    assert.equal(await f.controller.reload(), false)
    assert.equal(f.calls.applied.length, 0)
    assert.equal(f.controller.error.value, '')
    assert.notEqual(f.controller.conflict.value, null)
  } finally { f.scope.stop() }
})

test('edits, path changes, and portfolio switches across either await refuse to replace current state', async (t) => {
  for (const boundary of ['beforeReload', 'readFile']) {
    for (const field of ['generation', 'path', 'portfolioId']) {
      await t.test(`${field} during ${boundary}`, async () => {
        const waiting = deferred()
        const overrides = boundary === 'beforeReload'
          ? { beforeReload: () => waiting.promise }
          : { readFile: () => waiting.promise }
        const f = fixture(overrides)
        try {
          f.controller.report(conflict())
          const reloading = f.controller.reload()
          await settle()
          f.target[field] = field === 'generation' ? f.target.generation + 1 : `${f.target[field]}-changed`
          waiting.resolve(boundary === 'beforeReload' ? undefined : file())
          assert.equal(await reloading, false)
          assert.equal(f.calls.applied.length, 0)
          assert.equal(f.content(), '作者未保存内容')
          assert.match(f.controller.error.value, /发生了变化/)
          assert.notEqual(f.controller.conflict.value, null)
          assert.equal(f.controller.open.value, true)
          if (boundary === 'beforeReload') assert.equal(f.calls.read.length, 0)
        } finally { f.scope.stop() }
      })
    }
  }
})

test('a fresh explicit reload can discard edits made after dismissing the reported conflict', async () => {
  const f = fixture()
  try {
    f.controller.report(conflict())
    f.controller.dismiss()
    f.target.generation += 1
    f.controller.reopen()
    assert.equal(await f.controller.reload(), true)
    assert.equal(f.calls.before, 1)
    assert.equal(f.calls.applied.length, 1)
    assert.equal(f.controller.error.value, '')
    assert.equal(f.controller.conflict.value, null)
    assert.equal(f.content(), '磁盘内容')
  } finally { f.scope.stop() }
})

test('switching source paths or portfolios since report refuses either resolution action before invoking callbacks', async (t) => {
  for (const field of ['path', 'portfolioId']) {
    for (const action of ['reload', 'saveAs']) {
      await t.test(`${field} before ${action}`, async () => {
        const f = fixture()
        try {
          f.controller.report(conflict())
          f.controller.dismiss()
          f.target[field] = `${f.target[field]}-changed`
          f.controller.reopen()
          assert.equal(await f.controller[action](), false)
          assert.equal(f.calls.before, 0)
          assert.equal(f.calls.read.length, 0)
          assert.equal(f.calls.applied.length, 0)
          assert.equal(f.calls.saves, 0)
          assert.equal(f.controller.busy.value, false)
          assert.match(f.controller.error.value, /发生了变化/)
          assert.notEqual(f.controller.conflict.value, null)
          assert.equal(f.content(), '作者未保存内容')
        } finally { f.scope.stop() }
      })
    }
  }
})

test('Save As success clears the conflict; cancellation and failure preserve it', async (t) => {
  for (const [name, saveAs, succeeded, errorPattern] of [
    ['saved', async () => ({ saved: true }), true, /^$/],
    ['canceled', async () => ({ saved: false, canceled: true }), false, /^$/],
    ['failed', async () => ({ saved: false, error: '另存为目标不可写' }), false, /目标不可写/],
    ['incomplete', async () => ({ saved: false }), false, /未完成/],
    ['throw', async () => { throw new Error('另存为失败') }, false, /另存为失败/],
  ]) {
    await t.test(name, async () => {
      const f = fixture({ saveAs })
      try {
        f.controller.report(conflict())
        assert.equal(await f.controller.saveAs(), succeeded)
        assert.equal(f.content(), '作者未保存内容', 'Save As uses the shared saver and does not reload disk content')
        assert.equal(f.controller.conflict.value === null, succeeded)
        assert.equal(f.controller.open.value, !succeeded)
        assert.equal(f.controller.busy.value, false)
        assert.match(f.controller.error.value, errorPattern)
      } finally { f.scope.stop() }
    })
  }
})

test('a confirmed file copy releases the disk conflict while Save As keeps ownership until the queue finishes', async () => {
  const waiting = deferred()
  const f = fixture({ saveAs: () => waiting.promise })
  try {
    f.controller.report(conflict())
    const saving = f.controller.saveAs()
    const write = f.controller.captureFileWrite()
    f.target.path = 'E:\\Fixture\\confirmed-copy.qy'
    f.controller.confirmFileWrite(write, f.target.path)
    assert.equal(f.controller.conflict.value, null)
    assert.equal(f.controller.open.value, false)
    assert.equal(f.controller.busy.value, true, 'newer edits and local records still belong to the running save')
    assert.equal(await f.controller.saveAs(), false, 'the action lock is retained')
    f.target.generation += 1
    f.controller.confirmFileWrite(f.controller.captureFileWrite(), f.target.path)
    waiting.resolve({ saved: true })
    assert.equal(await saving, true)
    assert.equal(f.controller.busy.value, false)
  } finally { f.scope.stop() }
})

test('a confirmed file copy cannot leave an obsolete conflict after a later save step fails', async () => {
  const waiting = deferred()
  const f = fixture({ saveAs: () => waiting.promise })
  try {
    f.controller.report(conflict())
    const saving = f.controller.saveAs()
    const write = f.controller.captureFileWrite()
    f.target.path = 'E:\\Fixture\\confirmed-copy.qy'
    f.controller.confirmFileWrite(write, f.target.path)
    waiting.resolve({ saved: false, error: '副本已保存，最新编辑保存失败' })
    assert.equal(await saving, false)
    assert.equal(f.controller.conflict.value, null)
    assert.equal(f.controller.open.value, false)
    assert.equal(f.controller.error.value, '', 'the shared save queue owns the subsequent failure')
    assert.equal(f.controller.busy.value, false)
  } finally { f.scope.stop() }
})

test('a later report, clear, disposal or target switch invalidates an old confirmed Save As reply', async (t) => {
  for (const change of ['report', 'clear', 'dispose', 'path', 'portfolioId']) {
    await t.test(change, async () => {
      const waiting = deferred()
      const f = fixture({ saveAs: () => waiting.promise })
      try {
        f.controller.report(conflict())
        const saving = f.controller.saveAs()
        const write = f.controller.captureFileWrite()
        f.target.path = 'E:\\Fixture\\confirmed-copy.qy'
        f.controller.confirmFileWrite(write, f.target.path)
        if (change === 'report') f.controller.report(conflict({ path: f.target.path }))
        else if (change === 'clear') f.controller.clear()
        else if (change === 'dispose') f.scope.stop()
        else f.target[change] = `${f.target[change]}-changed`
        waiting.resolve({ saved: true })
        assert.equal(await saving, false)
        assert.equal(f.controller.busy.value, false)
        if (change === 'report') assert.equal(f.controller.conflict.value.path, f.target.path)
      } finally { f.scope.stop() }
    })
  }
})

test('a file write receipt accepts new edits but refuses a changed source or newer conflict state', async (t) => {
  for (const change of ['generation', 'path', 'portfolioId', 'report', 'clear', 'dispose']) {
    await t.test(change, () => {
      const f = fixture()
      try {
        f.controller.report(conflict())
        const write = f.controller.captureFileWrite()
        assert.equal(f.controller.acceptsFileWrite(write), true)
        if (change === 'report') f.controller.report(conflict({ path: 'E:\\Fixture\\latest.qy' }))
        else if (change === 'clear') f.controller.clear()
        else if (change === 'dispose') f.scope.stop()
        else if (change === 'generation') f.target.generation += 1
        else f.target[change] = `${f.target[change]}-changed`
        assert.equal(f.controller.acceptsFileWrite(write), change === 'generation')
      } finally { f.scope.stop() }
    })
  }
})

test('an invalidated Save As write cannot clear a newer conflict before confirming its disk response', async (t) => {
  for (const change of ['report', 'path', 'portfolioId', 'clear', 'dispose']) {
    await t.test(change, async () => {
      const waiting = deferred()
      const f = fixture({ saveAs: () => waiting.promise })
      try {
        f.controller.report(conflict())
        const saving = f.controller.saveAs()
        const write = f.controller.captureFileWrite()
        const savedPath = 'E:\\Fixture\\confirmed-copy.qy'
        if (change === 'report') {
          f.controller.report(conflict({ path: 'E:\\Fixture\\latest.qy' }))
          f.target.path = savedPath
        } else if (change === 'clear') f.controller.clear()
        else if (change === 'dispose') f.scope.stop()
        else f.target[change] = `${f.target[change]}-changed`
        f.controller.confirmFileWrite(write, savedPath)
        const expectedPath = change === 'report' ? 'E:\\Fixture\\latest.qy' : conflictPath
        if (change !== 'clear') assert.equal(f.controller.conflict.value.path, expectedPath)
        waiting.resolve({ saved: true })
        assert.equal(await saving, false)
        if (change !== 'clear') assert.equal(f.controller.conflict.value.path, expectedPath)
      } finally { f.scope.stop() }
    })
  }
})

test('a ticket captured after the pending Save As action was invalidated cannot revive that action', async () => {
  const waiting = deferred()
  const f = fixture({ saveAs: () => waiting.promise })
  try {
    f.controller.report(conflict())
    const saving = f.controller.saveAs()
    const latestPath = 'E:\\Fixture\\latest.qy'
    f.controller.report(conflict({ path: latestPath }))
    const write = f.controller.captureFileWrite()
    assert.equal(f.controller.acceptsFileWrite(write), false)
    f.target.path = 'E:\\Fixture\\old-action-copy.qy'
    f.controller.confirmFileWrite(write, f.target.path)
    assert.equal(f.controller.conflict.value.path, latestPath)
    waiting.resolve({ saved: true })
    assert.equal(await saving, false)
    assert.equal(f.controller.conflict.value.path, latestPath)
  } finally { f.scope.stop() }
})

test('only one action runs at once, including after clear while an old read is pending', async () => {
  const waiting = deferred()
  const f = fixture({ readFile: () => waiting.promise })
  try {
    f.controller.report(conflict())
    const reloading = f.controller.reload()
    await settle()
    assert.equal(f.controller.busy.value, true)
    assert.equal(await f.controller.reload(), false)
    assert.equal(await f.controller.saveAs(), false)
    assert.equal(f.calls.saves, 0)
    f.controller.clear()
    assert.equal(f.controller.busy.value, true, 'clear must not release another action’s lock')
    f.controller.report(conflict({ path: 'E:\\Fixture\\new-conflict.qy' }))
    assert.equal(await f.controller.saveAs(), false)
    waiting.resolve(file())
    assert.equal(await reloading, false)
    assert.equal(f.calls.applied.length, 0)
    assert.equal(f.controller.conflict.value.path, 'E:\\Fixture\\new-conflict.qy')
    assert.equal(f.controller.open.value, true)
    assert.equal(f.controller.busy.value, false)
    assert.equal(await f.controller.saveAs(), true)
    assert.equal(f.calls.saves, 1)
  } finally { f.scope.stop() }
})

test('old failed reads and successful Save As replies cannot replace or clear a newly reported conflict', async (t) => {
  for (const action of ['reload', 'saveAs']) {
    await t.test(action, async () => {
      const waiting = deferred()
      const f = fixture(action === 'reload' ? { readFile: () => waiting.promise } : { saveAs: () => waiting.promise })
      try {
        f.controller.report(conflict())
        const running = f.controller[action]()
        await settle()
        f.controller.report(conflict({ path: 'E:\\Fixture\\latest.qy' }))
        f.controller.dismiss()
        if (action === 'reload') waiting.reject(new Error('旧读失败'))
        else waiting.resolve({ saved: true })
        assert.equal(await running, false)
        assert.equal(f.controller.conflict.value.path, 'E:\\Fixture\\latest.qy')
        assert.equal(f.controller.open.value, false, 'old callbacks cannot reopen a dismissed new conflict')
        assert.equal(f.controller.error.value, '')
        assert.equal(f.controller.busy.value, false)
        assert.equal(f.calls.applied.length, 0)
      } finally { f.scope.stop() }
    })
  }
})

test('cleared conflicts and disposed controller scopes ignore in-flight results', async (t) => {
  for (const invalidate of ['clear', 'dispose']) {
    await t.test(invalidate, async () => {
      const waiting = deferred()
      const f = fixture({ readFile: () => waiting.promise })
      f.controller.report(conflict())
      const reloading = f.controller.reload()
      await settle()
      if (invalidate === 'clear') f.controller.clear()
      else f.scope.stop()
      waiting.resolve(file())
      assert.equal(await reloading, false)
      assert.equal(f.calls.applied.length, 0)
      assert.equal(f.controller.busy.value, false)
      assert.equal(f.controller.error.value, '')
      if (invalidate === 'clear') assert.equal(f.controller.conflict.value, null)
      else {
        f.controller.report(conflict({ path: 'E:\\Fixture\\ignored.qy' }))
        assert.equal(f.controller.conflict.value.path, conflictPath)
        assert.equal(await f.controller.reload(), false)
      }
      f.scope.stop()
    })
  }
})
