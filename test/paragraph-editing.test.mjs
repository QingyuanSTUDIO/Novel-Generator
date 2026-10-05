import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computed, effectScope, ref } from 'vue'
import { useParagraphEditing } from '../src/composables/useParagraphEditing.ts'

function createHarness(t, stream = 'true') {
  const chapters = ref([
    { id: 'chapter-1', title: '第一章', status: '草稿', content: '原始段落\n\n后续段落', wordCount: 8, volumeId: 'volume-1' },
    { id: 'chapter-2', title: '第二章', status: '草稿', content: '另一章的内容', wordCount: 6, volumeId: 'volume-1' },
  ])
  const activeId = ref('chapter-1')
  const activeChapter = computed(() => chapters.value.find((chapter) => chapter.id === activeId.value))
  const provider = {
    id: 'provider-1',
    fields: { '接口地址': 'https://example.test/v1', 'API Key': 'test-only-key', '模型': 'test-model', '流式输出': stream },
  }
  let writes = 0
  const scope = effectScope()
  const controller = scope.run(() => useParagraphEditing({
    activeChapter,
    writerProvider: computed(() => provider),
    effectiveCast: computed(() => []),
    getChapter: (id) => chapters.value.find((chapter) => chapter.id === id),
    isApiConfigured: () => true,
    retrievedContext: () => ({ text: '世界书上下文' }),
    formatStyleRulesContext: () => '保留具体动作。',
    localApiUrl: (path) => `http://local.test${path}`,
    updateChapterContent: (content) => {
      writes += 1
      activeChapter.value.content = content
    },
  }))
  t.after(() => scope.stop())
  const selection = { index: 0, paragraph: '原始段落' }
  controller.openParagraphEdit(selection)
  return { chapters, activeId, activeChapter, controller, scope, selection, writes: () => writes }
}

function mockPendingFetch(t) {
  const requests = []
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((resolve) => {
    requests.push({ options, resolve, input: JSON.parse(options.body) })
  }))
  return requests
}

function mockStreamFetch(t) {
  let streamController
  let signal
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options.signal
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller
        signal.addEventListener('abort', () => {
          try { controller.error(signal.reason) } catch { /* stream already ended */ }
        }, { once: true })
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  })
  return {
    emit(event) { streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) },
    close() { streamController.close() },
    signal: () => signal,
  }
}

function jsonReply(text) {
  return new Response(JSON.stringify({ ok: true, text }), { headers: { 'content-type': 'application/json' } })
}

async function settleChunks() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('shows streamed paragraph text while waiting and applies only a completed matching reply', async (t) => {
  const harness = createHarness(t)
  const stream = mockStreamFetch(t)
  const { controller, selection } = harness
  const pending = controller.requestParagraphEdit({ ...selection, instruction: '加强紧张感' })
  stream.emit({ type: 'delta', text: '改写' })
  await settleChunks()

  assert.equal(controller.paragraphEdit.value.status, 'waiting')
  assert.equal(controller.paragraphEdit.value.response, '改写')
  controller.applyParagraphEdit({ ...selection, response: '改写' })
  assert.equal(harness.writes(), 0)

  stream.emit({ type: 'delta', text: '后的段落' })
  stream.emit({ type: 'done' })
  stream.close()
  await pending

  assert.equal(controller.paragraphEdit.value.status, 'ready')
  assert.equal(controller.paragraphEdit.value.response, '改写后的段落')
  controller.applyParagraphEdit({ ...selection, response: '不属于模型结果的内容' })
  assert.equal(harness.writes(), 0)
  controller.applyParagraphEdit({ ...selection, response: '改写后的段落' })
  assert.equal(harness.activeChapter.value.content, '改写后的段落\n\n后续段落')
  assert.equal(harness.writes(), 1)
  assert.equal(controller.paragraphEdit.value, null)
})

test('ignores repeated send attempts during the same paragraph request', async (t) => {
  const { controller, selection } = createHarness(t)
  const requests = mockPendingFetch(t)
  const pending = controller.requestParagraphEdit({ ...selection, instruction: '修改描写' })
  await controller.requestParagraphEdit({ ...selection, instruction: '重复请求' })
  assert.equal(requests.length, 1)
  assert.equal(controller.paragraphEdit.value.instruction, '修改描写')
  requests[0].resolve(jsonReply('完整建议'))
  await pending
  assert.equal(controller.paragraphEdit.value.status, 'ready')
})

test('closing aborts a request and its late reply cannot overwrite a new request', async (t) => {
  const { controller, selection } = createHarness(t)
  const requests = mockPendingFetch(t)
  const oldRequest = controller.requestParagraphEdit({ ...selection, instruction: '旧请求' })
  controller.closeParagraphEdit()
  assert.equal(requests[0].options.signal.aborted, true)
  assert.equal(controller.paragraphEdit.value, null)

  controller.openParagraphEdit(selection)
  const newRequest = controller.requestParagraphEdit({ ...selection, instruction: '新请求' })
  requests[1].resolve(jsonReply('新建议'))
  await newRequest
  requests[0].resolve(jsonReply('迟到的旧建议'))
  await oldRequest
  assert.equal(controller.paragraphEdit.value.status, 'ready')
  assert.equal(controller.paragraphEdit.value.response, '新建议')
})

test('switching chapters aborts the old paragraph request without changing either chapter', async (t) => {
  const harness = createHarness(t)
  const requests = mockPendingFetch(t)
  const pending = harness.controller.requestParagraphEdit({ ...harness.selection, instruction: '改写' })
  harness.activeId.value = 'chapter-2'

  assert.equal(requests[0].options.signal.aborted, true)
  assert.equal(harness.controller.paragraphEdit.value, null)
  requests[0].resolve(jsonReply('迟到建议'))
  await pending
  assert.equal(harness.chapters.value[0].content, '原始段落\n\n后续段落')
  assert.equal(harness.chapters.value[1].content, '另一章的内容')
  assert.equal(harness.writes(), 0)
})

test('an interrupted stream remains an unapplyable preview', async (t) => {
  const harness = createHarness(t)
  const stream = mockStreamFetch(t)
  const pending = harness.controller.requestParagraphEdit({ ...harness.selection, instruction: '改写' })
  stream.emit({ type: 'delta', text: '未完成的建议' })
  stream.close()
  await pending

  assert.equal(harness.controller.paragraphEdit.value.status, 'error')
  assert.equal(harness.controller.paragraphEdit.value.response, '未完成的建议')
  assert.match(harness.controller.paragraphEdit.value.error, /连接中断/)
  harness.controller.applyParagraphEdit({ ...harness.selection, response: '未完成的建议' })
  assert.equal(harness.writes(), 0)
})

test('manual changes made while waiting cannot be overwritten by the completed reply', async (t) => {
  const harness = createHarness(t)
  const requests = mockPendingFetch(t)
  const pending = harness.controller.requestParagraphEdit({ ...harness.selection, instruction: '改写' })
  harness.activeChapter.value.content = '作者的新内容'
  requests[0].resolve(jsonReply('模型建议'))
  await pending

  assert.equal(harness.controller.paragraphEdit.value.status, 'error')
  assert.match(harness.controller.paragraphEdit.value.error, /正文.*变化/)
  harness.controller.applyParagraphEdit({ ...harness.selection, response: '模型建议' })
  assert.equal(harness.activeChapter.value.content, '作者的新内容')
  assert.equal(harness.writes(), 0)
})

test('uses the preset non-stream setting and accepts a complete JSON response', async (t) => {
  const { controller, selection } = createHarness(t, 'false')
  const requests = mockPendingFetch(t)
  const pending = controller.requestParagraphEdit({ ...selection, instruction: '改写' })
  assert.equal(requests[0].input.stream, false)
  requests[0].resolve(jsonReply('非流式完整建议'))
  await pending
  assert.equal(controller.paragraphEdit.value.status, 'ready')
  assert.equal(controller.paragraphEdit.value.response, '非流式完整建议')
})

test('disposing the editor scope aborts its request and ignores a late result', async (t) => {
  const harness = createHarness(t)
  const requests = mockPendingFetch(t)
  const pending = harness.controller.requestParagraphEdit({ ...harness.selection, instruction: '改写' })
  harness.scope.stop()
  assert.equal(requests[0].options.signal.aborted, true)
  requests[0].resolve(jsonReply('迟到建议'))
  await pending
  assert.equal(harness.controller.paragraphEdit.value, null)
  assert.equal(harness.writes(), 0)
})
