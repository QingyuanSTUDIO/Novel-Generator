import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick, ref, watch } from 'vue'
import { createUnifiedSaveQueue } from '../src/composables/unifiedSave.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('queued saves capture the latest data when their turn starts and never write concurrently', async () => {
  const firstWrite = deferred()
  const firstStarted = deferred()
  const writes = []
  let content = 'first'
  let generation = 0
  let concurrent = 0
  let peakConcurrent = 0
  const queue = createUnifiedSaveQueue({
    getGeneration: () => generation,
    capture: () => ({ content }),
    write: async (snapshot) => {
      concurrent += 1
      peakConcurrent = Math.max(peakConcurrent, concurrent)
      writes.push(snapshot.content)
      if (writes.length === 1) {
        firstStarted.resolve()
        await firstWrite.promise
      }
      concurrent -= 1
      return { saved: true }
    },
  })

  const first = queue.save()
  await firstStarted.promise
  const second = queue.save()
  assert.equal(queue.pendingCount(), 2)
  content = 'latest'
  generation += 1
  firstWrite.resolve()
  assert.deepEqual(await first, { saved: true })
  assert.deepEqual(await second, { saved: true })
  await queue.waitForPending()
  assert.deepEqual(writes, ['first', 'latest', 'latest'])
  assert.equal(peakConcurrent, 1)
  assert.equal(queue.pendingCount(), 0)
})

test('pending reactive edits settle before snapshot capture and do not cause a false close-save failure', async () => {
  const content = ref('before')
  let generation = 0
  const states = []
  const writes = []
  const stop = watch(content, () => { generation += 1 })
  const queue = createUnifiedSaveQueue({
    getGeneration: () => generation,
    settle: nextTick,
    capture: () => ({ content: content.value }),
    write: async (snapshot) => {
      writes.push(snapshot.content)
      return { saved: true }
    },
    onState: (state) => states.push(state),
  })

  content.value = 'edited'
  assert.deepEqual(await queue.save(), { saved: true })
  assert.equal(generation, 1)
  assert.deepEqual(writes, ['edited'])
  assert.deepEqual(states, ['saving', 'saved'])
  stop()
})

test('real edits during saving are recaptured and Save As prompts only on the first attempt', async () => {
  let generation = 0
  let content = 'before'
  const writes = []
  const states = []
  const queue = createUnifiedSaveQueue({
    getGeneration: () => generation,
    capture: () => ({ content }),
    write: async (snapshot, options) => {
      writes.push({ snapshot, options })
      if (writes.length === 1) {
        content = 'edited while saving'
        generation += 1
      }
      return { saved: true }
    },
    onState: (state) => states.push(state),
  })

  assert.deepEqual(await queue.save({ saveAs: true, allowDialog: true }), { saved: true })
  assert.deepEqual(writes, [
    { snapshot: { content: 'before' }, options: { saveAs: true, allowDialog: true, profileOnly: false } },
    { snapshot: { content: 'edited while saving' }, options: { saveAs: false, allowDialog: false, profileOnly: false } },
  ])
  assert.deepEqual(states, ['saving', 'dirty', 'saving', 'saved'])
})

test('an edit during an asynchronous capture cannot be marked saved using the older snapshot', async () => {
  let generation = 0
  let content = 'before'
  let captures = 0
  const writes = []
  const queue = createUnifiedSaveQueue({
    getGeneration: () => generation,
    capture: async () => {
      const snapshot = { content }
      if (captures++ === 0) {
        await Promise.resolve()
        content = 'after'
        generation += 1
      }
      return snapshot
    },
    write: async (snapshot) => {
      writes.push(snapshot.content)
      return { saved: true }
    },
  })

  assert.deepEqual(await queue.save(), { saved: true })
  assert.deepEqual(writes, ['before', 'after'])
})

test('canceling never reports saved or error and does not stop a subsequent queued request', async () => {
  const states = []
  let writes = 0
  const queue = createUnifiedSaveQueue({
    getGeneration: () => 1,
    capture: () => ({ content: 'unsaved' }),
    write: async () => ++writes === 1
      ? { saved: true, canceled: true, error: 'ignored cancellation metadata' }
      : { saved: true },
    onState: (state) => states.push(state),
  })

  const canceled = queue.save({ saveAs: true, allowDialog: true })
  const successful = queue.save()
  assert.deepEqual(await canceled, { saved: false, canceled: true })
  assert.deepEqual(await successful, { saved: true })
  assert.deepEqual(states, ['saving', 'dirty', 'saving', 'saved'])
  assert.equal(queue.pendingCount(), 0)
})

test('capture exceptions identify preparation failure and leave the queue usable', async () => {
  let captures = 0
  const states = []
  const errors = []
  const writes = []
  const queue = createUnifiedSaveQueue({
    getGeneration: () => 0,
    capture: () => {
      if (captures++ === 0) throw new Error('snapshot rejected')
      return 'valid snapshot'
    },
    write: async (snapshot) => {
      writes.push(snapshot)
      return { saved: true }
    },
    onState: (state, error) => {
      states.push(state)
      if (error) errors.push(error)
    },
  })

  assert.deepEqual(await queue.save(), { saved: false, error: '准备保存内容失败：snapshot rejected' })
  assert.deepEqual(await queue.save(), { saved: true })
  assert.deepEqual(writes, ['valid snapshot'])
  assert.deepEqual(states, ['saving', 'error', 'saving', 'saved'])
  assert.deepEqual(errors, ['准备保存内容失败：snapshot rejected'])
})

test('write exceptions and unsuccessful results are explicit failures rather than confirmed saves', async () => {
  for (const write of [
    async () => { throw new Error('disk full') },
    async () => ({ saved: false, error: 'permission denied' }),
    async () => ({ saved: false }),
  ]) {
    const states = []
    const queue = createUnifiedSaveQueue({
      getGeneration: () => 0,
      capture: () => 'data',
      write,
      onState: (state) => states.push(state),
    })
    const result = await queue.save()
    assert.equal(result.saved, false)
    assert.ok(result.error)
    assert.deepEqual(states, ['saving', 'error'])
    assert.equal(queue.pendingCount(), 0)
  }
})

test('continuous editing is limited to three writes and reports that the latest changes remain unsaved', async () => {
  let generation = 0
  let writes = 0
  const states = []
  const queue = createUnifiedSaveQueue({
    getGeneration: () => generation,
    capture: () => ({ generation }),
    write: async () => {
      writes += 1
      generation += 1
      return { saved: true }
    },
    onState: (state) => states.push(state),
  })

  const result = await queue.save()
  assert.equal(result.saved, false)
  assert.match(result.error, /已尝试 3 次.*最新修改仍未保存/)
  assert.equal(writes, 3)
  assert.deepEqual(states, ['saving', 'dirty', 'saving', 'dirty', 'saving', 'dirty', 'error'])
  await queue.waitForPending()
  assert.equal(queue.pendingCount(), 0)
})

test('a lower attempt limit is respected and an excessive limit remains bounded', async () => {
  for (const [maxAttempts, expectedWrites] of [[2, 2], [0, 1], [100, 3], [Infinity, 3]]) {
    let generation = 0
    let writes = 0
    const queue = createUnifiedSaveQueue({
      getGeneration: () => generation,
      capture: () => generation,
      write: async () => {
        writes += 1
        generation += 1
        return { saved: true }
      },
      maxAttempts,
    })
    assert.equal((await queue.save()).saved, false)
    assert.equal(writes, expectedWrites)
  }
})

test('waitForPending includes a save queued from a previous completion callback', async () => {
  const secondWrite = deferred()
  const secondStarted = deferred()
  let writes = 0
  let queuedSecond = false
  let secondResult
  let queue
  queue = createUnifiedSaveQueue({
    getGeneration: () => 0,
    capture: () => 'content',
    write: async () => {
      if (++writes === 2) {
        secondStarted.resolve()
        await secondWrite.promise
      }
      return { saved: true }
    },
    onState: (state) => {
      if (state === 'saved' && !queuedSecond) {
        queuedSecond = true
        secondResult = queue.save()
      }
    },
  })
  const first = queue.save()
  let completed = false
  const waiting = queue.waitForPending().then(() => { completed = true })
  assert.deepEqual(await first, { saved: true })
  await secondStarted.promise
  assert.equal(completed, false)
  assert.equal(queue.pendingCount(), 1)
  secondWrite.resolve()
  assert.deepEqual(await secondResult, { saved: true })
  await waiting
  assert.equal(completed, true)
  assert.equal(queue.pendingCount(), 0)
})

test('a failing status observer cannot turn a confirmed write into a failure', async () => {
  const queue = createUnifiedSaveQueue({
    getGeneration: () => 0,
    capture: () => 'content',
    write: async () => ({ saved: true }),
    onState: () => { throw new Error('observer failed') },
  })
  assert.deepEqual(await queue.save(), { saved: true })
  await queue.waitForPending()
  assert.equal(queue.pendingCount(), 0)
})

test('a profile-only save preserves portfolio dirty state and exposes its scope to status observers', async () => {
  const writes = []
  const states = []
  const queue = createUnifiedSaveQueue({
    getGeneration: () => 0,
    capture: () => 'settings',
    write: async (snapshot, options) => {
      writes.push({ snapshot, options })
      return { saved: true }
    },
    onState: (state, error, options) => states.push({ state, error, options }),
  })

  assert.deepEqual(await queue.save({ profileOnly: true }), { saved: true })
  assert.deepEqual(writes, [{
    snapshot: 'settings',
    options: { saveAs: false, allowDialog: false, profileOnly: true },
  }])
  assert.deepEqual(states.map(({ state }) => state), ['saving', 'dirty'])
  assert.ok(states.every(({ options }) => options.profileOnly === true))
})

test('profile-only retries retain their scope and cannot reopen a dialog', async () => {
  let generation = 0
  const writes = []
  const queue = createUnifiedSaveQueue({
    getGeneration: () => generation,
    capture: () => generation,
    write: async (_snapshot, options) => {
      writes.push(options)
      if (writes.length === 1) generation += 1
      return { saved: true }
    },
  })

  assert.deepEqual(await queue.save({ profileOnly: true, allowDialog: true }), { saved: true })
  assert.deepEqual(writes, [
    { saveAs: false, allowDialog: true, profileOnly: true },
    { saveAs: false, allowDialog: false, profileOnly: true },
  ])
})

test('Save As always saves the portfolio, even if profileOnly was passed', async () => {
  const writes = []
  const states = []
  const queue = createUnifiedSaveQueue({
    getGeneration: () => 0,
    capture: () => 'portfolio',
    write: async (_snapshot, options) => {
      writes.push(options)
      return { saved: true }
    },
    onState: (state) => states.push(state),
  })

  assert.deepEqual(await queue.save({ saveAs: true, allowDialog: true, profileOnly: true }), { saved: true })
  assert.deepEqual(writes, [{ saveAs: true, allowDialog: true, profileOnly: false }])
  assert.deepEqual(states, ['saving', 'saved'])
})

test('capture receives the requested scope so a profile-only save can avoid validating unsaved content', async () => {
  const captures = []
  const writes = []
  const queue = createUnifiedSaveQueue({
    getGeneration: () => 0,
    capture: (options) => {
      captures.push(options)
      if (!options.profileOnly) throw new Error('invalid editable portfolio')
      return 'valid settings'
    },
    write: async (snapshot) => {
      writes.push(snapshot)
      return { saved: true }
    },
  })

  assert.deepEqual(await queue.save({ profileOnly: true }), { saved: true })
  assert.equal((await queue.save({ allowDialog: true })).saved, false)
  assert.deepEqual(captures, [
    { saveAs: false, allowDialog: false, profileOnly: true },
    { saveAs: false, allowDialog: true, profileOnly: false },
  ])
  assert.deepEqual(writes, ['valid settings'])
})

test('file conflicts retain their distinct state and do not trigger an automatic write retry', async () => {
  const states = []
  let writes = 0
  const queue = createUnifiedSaveQueue({
    getGeneration: () => 0,
    capture: () => 'synthetic content',
    write: async () => {
      writes += 1
      return { saved: false, conflict: true, error: 'Disk revision changed' }
    },
    onState: (state) => states.push(state),
  })
  assert.deepEqual(await queue.save(), { saved: false, conflict: true, error: 'Disk revision changed' })
  assert.equal(writes, 1)
  assert.deepEqual(states, ['saving', 'conflict'])
  assert.equal(queue.pendingCount(), 0)
})
