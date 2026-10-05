import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ref } from 'vue'
import { useChapterController } from '../src/composables/useChapterController.ts'

function createStore() {
  return {
    schemaVersion: 8,
    volumes: [{ id: 'volume-1', title: '第一卷', collapsed: false }],
    chapters: [
      { id: 'ch-7', title: '07 线索', status: '已定稿', content: '章节内容', wordCount: 4, volumeId: 'volume-1' },
      { id: 'ch-8', title: '08 当前章节', status: '草稿', content: '正文', wordCount: 2, volumeId: 'volume-1' },
    ],
  }
}

function createChapterController() {
  const store = ref(createStore())
  const selectedChapterId = ref('ch-8')
  const selectedVolumeId = ref('volume-1')
  const chapterSearch = ref('')
  const candidate = ref('候选正文')
  const chapterDeleteOpen = ref(true)
  const editorToolsOpen = ref(false)
  const formatIndentSpaces = ref(2)
  const copyFeedback = ref('')
  const castDraft = ref('角色')
  let persistCalls = 0
  const controller = useChapterController({
    store,
    selectedChapterId,
    selectedVolumeId,
    chapterSearch,
    candidate,
    chapterDeleteOpen,
    editorToolsOpen,
    formatIndentSpaces,
    copyFeedback,
    castDraft,
    closeParagraphEdit: () => {},
    persist: () => { persistCalls += 1 },
  })
  return { store, selectedChapterId, selectedVolumeId, candidate, chapterDeleteOpen, controller, persistCalls: () => persistCalls }
}

test('selecting a chapter opens its volume and clears the pending candidate', () => {
  const { store, selectedChapterId, selectedVolumeId, candidate, controller } = createChapterController()
  store.value.volumes[0].collapsed = true

  controller.selectChapter('ch-7')

  assert.equal(selectedChapterId.value, 'ch-7')
  assert.equal(selectedVolumeId.value, 'volume-1')
  assert.equal(store.value.volumes[0].collapsed, false)
  assert.equal(candidate.value, '')
})

test('deleting the last chapter leaves a new editable chapter and persists', () => {
  const { store, candidate, chapterDeleteOpen, controller, persistCalls } = createChapterController()
  store.value.chapters = [store.value.chapters[0]]
  store.value.chapters[0].id = 'only-chapter'
  store.value.chapters[0].volumeId = 'volume-1'

  controller.confirmDeleteChapter()

  assert.equal(store.value.chapters.length, 1)
  assert.equal(store.value.chapters[0].title, '01')
  assert.equal(store.value.chapters[0].volumeId, 'volume-1')
  assert.equal(chapterDeleteOpen.value, false)
  assert.equal(candidate.value, '')
  assert.equal(persistCalls(), 1)
})
