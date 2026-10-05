import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { effectScope, ref } from 'vue'
import { useWritingGeneration } from '../src/composables/useWritingGeneration.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function createProxy(t, handler) {
  const requests = []
  const handlerErrors = []
  const server = createServer(async (request, response) => {
    try {
      let bytes = ''
      for await (const chunk of request) bytes += chunk.toString()
      const payload = JSON.parse(bytes)
      requests.push(payload)
      await handler({ request, response, payload, index: requests.length - 1 })
    } catch (error) {
      handlerErrors.push(error)
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: error.message }))
      }
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.deepEqual(handlerErrors, [])
  })
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

function openStream(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  response.flushHeaders()
}

function event(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function createWriter(t, url, stream = true) {
  const scope = effectScope()
  const chapter = ref({
    id: 'chapter-1',
    title: '第一章',
    status: '草稿',
    content: '已有正文。\n',
    wordCount: 5,
    volumeId: 'volume-1',
    taskGoal: '前往码头',
    cast: ['沈砚'],
  })
  const projectId = ref('project-1')
  const provider = ref({
    id: 'provider-test',
    title: '测试 API',
    tag: '',
    summary: '',
    fields: {
      '接口地址': 'http://provider.invalid/v1',
      'API Key': 'test-only-token',
      '协议': 'OpenAI Compatible',
      '模型': 'test-model',
      '流式输出': String(stream),
    },
  })
  const candidate = ref('')
  const busy = ref(false)
  const error = ref('')
  const accepted = []
  const writer = scope.run(() => useWritingGeneration({
    activeChapter: chapter,
    projectId,
    provider,
    candidate,
    busy,
    error,
    isApiConfigured: () => true,
    buildMessages: (snapshot) => [
      { role: 'system', content: '按当前资料生成候选正文。' },
      { role: 'user', content: `${snapshot.title}\n${snapshot.content}\n${snapshot.cast.join('、')}` },
    ],
    localApiUrl: (path) => `${url}${path}`,
    updateChapterContent: (content) => {
      accepted.push({ projectId: projectId.value, chapterId: chapter.value.id, content })
      chapter.value.content = content
    },
  }))
  t.after(() => scope.stop())
  return { scope, writer, chapter, projectId, provider, candidate, busy, error, accepted }
}

test('streaming text cannot be accepted before done, then appends only the complete candidate', async (t) => {
  const finish = deferred()
  const { url, requests } = await createProxy(t, async ({ response }) => {
    openStream(response)
    event(response, { type: 'delta', text: ' 雾里' })
    await finish.promise
    event(response, { type: 'delta', text: '有人。\n' })
    event(response, { type: 'done' })
    response.end()
  })
  const { writer, chapter, candidate, busy, error, accepted } = createWriter(t, url)
  const generation = writer.generate()
  await waitUntil(() => candidate.value === ' 雾里', 'the first writing delta')

  assert.equal(requests[0].stream, true)
  assert.equal(busy.value, true)
  assert.equal(writer.state.value, 'running')
  assert.equal(writer.canAccept.value, false)
  assert.match(writer.detail.value, /已接收 2 字/)
  writer.accept()
  assert.deepEqual(accepted, [])
  assert.equal(chapter.value.content, '已有正文。\n')

  finish.resolve()
  await generation
  assert.equal(candidate.value, '雾里有人。')
  assert.equal(busy.value, false)
  assert.equal(writer.state.value, 'done')
  assert.equal(writer.canAccept.value, true)
  assert.equal(error.value, '')
  writer.accept()
  assert.deepEqual(accepted, [{ projectId: 'project-1', chapterId: 'chapter-1', content: '已有正文。\n\n雾里有人。' }])
  assert.equal(candidate.value, '')
  assert.equal(writer.state.value, 'idle')
});

test('disabling streaming sends stream false and accepts a complete JSON response', async (t) => {
  const finish = deferred()
  const { url, requests } = await createProxy(t, async ({ response }) => {
    await finish.promise
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, text: ' 完整的非流式正文。 ' }))
  })
  const { writer, candidate, busy } = createWriter(t, url, false)
  const generation = writer.generate()
  await waitUntil(() => requests.length === 1, 'the non-streaming request')

  assert.equal(requests[0].stream, false)
  assert.equal(candidate.value, '')
  assert.equal(busy.value, true)
  assert.equal(writer.canAccept.value, false)
  assert.doesNotMatch(writer.detail.value, /流式/)
  finish.resolve()
  await generation
  assert.equal(candidate.value, '完整的非流式正文。')
  assert.equal(writer.canAccept.value, true)
  assert.equal(writer.state.value, 'done')
})

for (const switchTarget of ['chapter', 'project']) {
  test(`switching ${switchTarget} aborts the old stream and keeps it isolated from a new generation`, async (t) => {
    const oldStreamFinished = deferred()
    const oldConnectionClosed = deferred()
    const { url, requests } = await createProxy(t, async ({ response, index }) => {
      openStream(response)
      if (index === 0) {
        response.once('close', oldConnectionClosed.resolve)
        event(response, { type: 'delta', text: '旧作品的半段正文' })
        await oldStreamFinished.promise
        if (!response.destroyed) {
          event(response, { type: 'delta', text: '绝不能污染新的章节。' })
          event(response, { type: 'done' })
          response.end()
        }
      } else {
        event(response, { type: 'delta', text: '新章节正文。' })
        event(response, { type: 'done' })
        response.end()
      }
    })
    const { writer, chapter, projectId, candidate, busy, error, accepted } = createWriter(t, url)
    const oldGeneration = writer.generate()
    await waitUntil(() => candidate.value.includes('旧作品'), 'the old stream')

    if (switchTarget === 'chapter') chapter.value = { ...chapter.value, id: 'chapter-2', content: '新章开始。' }
    else projectId.value = 'project-2'
    assert.equal(candidate.value, '')
    assert.equal(busy.value, false)
    assert.equal(writer.state.value, 'idle')
    assert.equal(writer.canAccept.value, false)

    await waitUntil(() => writer.state.value === 'idle' && candidate.value === '', 'the cancelled stream state')
    await oldConnectionClosed.promise
    const newGeneration = writer.generate()
    oldStreamFinished.resolve()
    await Promise.all([oldGeneration, newGeneration])

    assert.equal(requests.length, 2)
    assert.equal(candidate.value, '新章节正文。')
    assert.equal(writer.state.value, 'done')
    assert.equal(writer.canAccept.value, true)
    assert.equal(error.value, '')
    writer.accept()
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].projectId, switchTarget === 'project' ? 'project-2' : 'project-1')
    assert.equal(accepted[0].chapterId, switchTarget === 'chapter' ? 'chapter-2' : 'chapter-1')
    assert.doesNotMatch(accepted[0].content, /旧作品|污染/)
  })
}

test('late deltas and completion from a transport ignoring abort cannot replace the newer writing run', async (t) => {
  const streams = []
  const encoder = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    let controller
    const stream = new ReadableStream({ start(value) { controller = value } })
    // Deliberately ignore the fetch signal to reproduce a response callback
    // that was already queued when the author switched chapters.
    streams.push({
      signal: init.signal,
      send(value) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)) },
      close() { controller.close() },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const { writer, chapter, candidate, busy, error, accepted } = createWriter(t, 'http://unused.invalid')
  const oldGeneration = writer.generate()
  await waitUntil(() => streams.length === 1, 'the old mock stream')
  streams[0].send({ type: 'delta', text: '旧回复' })
  await waitUntil(() => candidate.value === '旧回复', 'the old queued preview')

  chapter.value = { ...chapter.value, id: 'chapter-2', content: '新章开始。' }
  assert.equal(streams[0].signal.aborted, true)
  const newGeneration = writer.generate()
  await waitUntil(() => streams.length === 2, 'the new mock stream')
  streams[1].send({ type: 'delta', text: '新回复' })
  await waitUntil(() => candidate.value === '新回复', 'the new preview')

  streams[0].send({ type: 'delta', text: '迟到的旧数据' })
  streams[0].send({ type: 'done' })
  streams[0].close()
  await oldGeneration
  assert.equal(candidate.value, '新回复')
  assert.equal(busy.value, true)
  assert.equal(writer.state.value, 'running')
  assert.equal(writer.canAccept.value, false)
  assert.equal(error.value, '')

  streams[1].send({ type: 'delta', text: '已完成。' })
  streams[1].send({ type: 'done' })
  streams[1].close()
  await newGeneration
  assert.equal(candidate.value, '新回复已完成。')
  assert.equal(writer.canAccept.value, true)
  writer.accept()
  assert.equal(accepted[0].chapterId, 'chapter-2')
  assert.equal(accepted[0].content, '新章开始。\n\n新回复已完成。')
})

test('manual chapter changes during generation retain preview text but block acceptance', async (t) => {
  const finish = deferred()
  const { url } = await createProxy(t, async ({ response }) => {
    openStream(response)
    event(response, { type: 'delta', text: '部分候选' })
    await finish.promise
    event(response, { type: 'delta', text: '，已写完。' })
    event(response, { type: 'done' })
    response.end()
  })
  const { writer, chapter, candidate, error, accepted } = createWriter(t, url)
  const generation = writer.generate()
  await waitUntil(() => candidate.value === '部分候选', 'the partial preview')
  chapter.value.content = '作者已手动修改本章。'
  finish.resolve()
  await generation

  assert.equal(candidate.value, '部分候选，已写完。')
  assert.equal(writer.state.value, 'error')
  assert.equal(writer.canAccept.value, false)
  assert.match(error.value, /本章正文发生了变化/)
  writer.accept()
  assert.deepEqual(accepted, [])
  assert.equal(chapter.value.content, '作者已手动修改本章。')
})

test('manual chapter changes after completion invalidate acceptance without overwriting the author', async (t) => {
  const { url } = await createProxy(t, async ({ response }) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ text: '待采纳的正文。' }))
  })
  const { writer, chapter, candidate, error, accepted } = createWriter(t, url)
  await writer.generate()
  assert.equal(writer.canAccept.value, true)

  chapter.value.content = '作者保留的新内容。'
  assert.equal(writer.canAccept.value, false)
  writer.accept()
  assert.equal(writer.state.value, 'error')
  assert.match(error.value, /正文发生了变化/)
  assert.equal(candidate.value, '待采纳的正文。')
  assert.equal(chapter.value.content, '作者保留的新内容。')
  assert.deepEqual(accepted, [])
})

test('an SSE failure preserves partial text for inspection and never enables acceptance', async (t) => {
  const { url } = await createProxy(t, async ({ response }) => {
    openStream(response)
    event(response, { type: 'delta', text: '未完成的正文' })
    event(response, { type: 'error', error: '中转模型连接失败' })
    response.end()
  })
  const { writer, chapter, candidate, busy, error, accepted } = createWriter(t, url)
  await writer.generate()

  assert.equal(candidate.value, '未完成的正文')
  assert.equal(busy.value, false)
  assert.equal(writer.state.value, 'error')
  assert.equal(writer.canAccept.value, false)
  assert.equal(error.value, '中转模型连接失败')
  assert.equal(writer.detail.value, '中转模型连接失败')
  writer.accept()
  assert.deepEqual(accepted, [])
  assert.equal(chapter.value.content, '已有正文。\n')
})

test('disposing the writing scope cancels an in-flight response and clears the candidate', async (t) => {
  const finish = deferred()
  const closed = deferred()
  const { url } = await createProxy(t, async ({ response }) => {
    openStream(response)
    response.once('close', closed.resolve)
    event(response, { type: 'delta', text: '尚在接收' })
    await finish.promise
    if (!response.destroyed) response.end()
  })
  const { scope, writer, candidate, busy, accepted } = createWriter(t, url)
  const generation = writer.generate()
  await waitUntil(() => candidate.value === '尚在接收', 'the preview before scope disposal')
  scope.stop()
  assert.equal(candidate.value, '')
  assert.equal(busy.value, false)
  assert.equal(writer.state.value, 'idle')
  await closed.promise
  finish.resolve()
  await generation
  assert.equal(candidate.value, '')
  assert.equal(writer.canAccept.value, false)
  assert.deepEqual(accepted, [])
})
