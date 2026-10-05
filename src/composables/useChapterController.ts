import { computed, type Ref } from 'vue'
import { formatChapterContent as formatChapterText, markdownToPlainText } from '../utils/chapterText.ts'
import type { Chapter, Store, Volume } from '../types.ts'

type CopyFeedback = 'copied' | 'error' | ''

type ChapterControllerOptions = {
  store: Ref<Store>
  selectedChapterId: Ref<string>
  selectedVolumeId: Ref<string>
  chapterSearch: Ref<string>
  candidate: Ref<string>
  chapterDeleteOpen: Ref<boolean>
  editorToolsOpen: Ref<boolean>
  formatIndentSpaces: Ref<number>
  copyFeedback: Ref<CopyFeedback>
  castDraft: Ref<string>
  closeParagraphEdit: () => void
  persist: () => void
}

export function useChapterController(options: ChapterControllerOptions) {
  const { store, selectedChapterId, selectedVolumeId, chapterSearch, candidate, chapterDeleteOpen, editorToolsOpen, formatIndentSpaces, copyFeedback, castDraft } = options
  const activeChapter = computed(() => store.value.chapters.find((chapter) => chapter.id === selectedChapterId.value) ?? store.value.chapters[0])
  const visibleVolumes = computed<Volume[]>(() => {
    if (store.value.volumes?.length) return store.value.volumes
    return [{ id: 'volume-1', title: '', collapsed: false }]
  })
  const normalizedChapterSearch = computed(() => chapterSearch.value.trim().toLocaleLowerCase())
  const filteredChapters = computed(() => {
    const query = normalizedChapterSearch.value
    if (!query) return store.value.chapters
    return store.value.chapters.filter((chapter) => `${chapter.title} ${chapter.status} ${chapter.content}`.toLocaleLowerCase().includes(query))
  })
  const chapterCountByVolume = computed(() => {
    const counts: Record<string, number> = {}
    for (const chapter of filteredChapters.value) counts[chapter.volumeId] = (counts[chapter.volumeId] ?? 0) + 1
    return counts
  })

  function cancelDeleteChapter() {
    chapterDeleteOpen.value = false
  }

  function requestDeleteChapter() {
    editorToolsOpen.value = false
    if (activeChapter.value) chapterDeleteOpen.value = true
  }

  function chapterNumber(title: string) {
    const match = title.trim().match(/^(\d+)/)
    return match ? Number(match[1]) : 0
  }

  function chapterTitleForNumber(number: number) {
    return String(number).padStart(2, '0')
  }

  function volumeForChapter(chapter: { volumeId?: string }) {
    return visibleVolumes.value.find((volume) => volume.id === chapter.volumeId) ?? visibleVolumes.value[0]
  }

  function chaptersForVolume(volumeId: string) {
    return filteredChapters.value.filter((chapter) => chapter.volumeId === volumeId)
  }

  function ensureChapterVolume(chapter: { volumeId: string }) {
    if (!chapter.volumeId || !visibleVolumes.value.some((volume) => volume.id === chapter.volumeId)) {
      chapter.volumeId = visibleVolumes.value[0]?.id ?? 'volume-1'
    }
  }

  function selectChapter(id: string) {
    selectedChapterId.value = id
    candidate.value = ''
    const chapter = store.value.chapters.find((item) => item.id === id)
    if (chapter) {
      ensureChapterVolume(chapter)
      selectedVolumeId.value = chapter.volumeId
      const volume = store.value.volumes.find((item) => item.id === chapter.volumeId)
      if (volume) volume.collapsed = false
    }
  }

  function confirmDeleteChapter() {
    const chapter = activeChapter.value
    if (!chapter) return
    const index = store.value.chapters.findIndex((item) => item.id === chapter.id)
    if (index < 0) return
    store.value.chapters.splice(index, 1)
    if (!store.value.chapters.length) {
      const volumeId = visibleVolumes.value.some((volume) => volume.id === chapter.volumeId) ? chapter.volumeId : visibleVolumes.value[0]?.id
      store.value.chapters.push({ id: `ch-${Date.now()}`, title: chapterTitleForNumber(1), status: '草稿', content: '', wordCount: 0, volumeId: volumeId ?? 'volume-1' })
    }
    const nextChapter = store.value.chapters[Math.min(index, store.value.chapters.length - 1)]
    if (nextChapter) selectChapter(nextChapter.id)
    chapterDeleteOpen.value = false
    candidate.value = ''
    options.persist()
  }

  function updateChapterContent(value: string) {
    const chapter = activeChapter.value
    if (!chapter) return
    chapter.content = value
    chapter.wordCount = value.replace(/\s/g, '').length
    chapter.status = '草稿'
  }

  function formatChapterContent() {
    const content = activeChapter.value?.content
    if (!content?.trim()) {
      editorToolsOpen.value = false
      return
    }
    updateChapterContent(formatChapterText(content, formatIndentSpaces.value))
    options.closeParagraphEdit()
    editorToolsOpen.value = false
  }

  function toggleEditorTools() {
    editorToolsOpen.value = !editorToolsOpen.value
    copyFeedback.value = ''
  }

  function fallbackCopy(text: string) {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.focus()
    textarea.select()
    try {
      return document.execCommand('copy')
    } finally {
      textarea.remove()
    }
  }

  async function copyChapterAsPlainText() {
    const chapter = activeChapter.value
    if (!chapter) return
    const plainText = markdownToPlainText(`${chapterDisplayTitle(chapter)}\n\n${chapter.content}`)
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(plainText)
      else if (!fallbackCopy(plainText)) throw new Error('剪贴板不可用')
      copyFeedback.value = 'copied'
    } catch {
      try {
        if (fallbackCopy(plainText)) copyFeedback.value = 'copied'
        else throw new Error('copy failed')
      } catch {
        copyFeedback.value = 'error'
      }
    }
  }

  function toggleVolume(volume: Volume) {
    volume.collapsed = !volume.collapsed
  }

  function updateVolumeTitle(volume: Volume, value: string) {
    volume.title = value
  }

  function updateChapterTitle(value: string) {
    const chapter = activeChapter.value
    if (!chapter) return
    const prefix = chapter.title.match(/^(\d+)(?:\s+|$)/)?.[1]
    const title = value.replace(/^\s+/, '')
    chapter.title = prefix ? (title ? `${prefix} ${title}` : prefix) : title
  }

  function chapterDisplayTitle(chapter: Chapter | undefined) {
    return chapter?.title.replace(/^\d+\s*/, '') ?? ''
  }

  function jumpToLastChapter() {
    chapterSearch.value = ''
    const last = store.value.chapters[store.value.chapters.length - 1]
    if (!last) return
    selectChapter(last.id)
    window.setTimeout(() => document.querySelector('.chapter-item.active')?.scrollIntoView({ block: 'nearest' }), 0)
  }

  function nextChapterNumber() {
    return Math.max(0, ...store.value.chapters.map((chapter) => chapterNumber(chapter.title))) + 1
  }

  function createChapter() {
    const targetVolume = visibleVolumes.value.find((volume) => volume.id === selectedVolumeId.value) ?? volumeForChapter(activeChapter.value ?? { volumeId: '' }) ?? visibleVolumes.value[0]
    if (!targetVolume) return
    const number = nextChapterNumber()
    const id = `ch-${Date.now()}`
    store.value.chapters.push({ id, title: chapterTitleForNumber(number), status: '草稿', content: '', wordCount: 0, volumeId: targetVolume.id })
    targetVolume.collapsed = false
    selectedChapterId.value = id
    chapterSearch.value = ''
    candidate.value = ''
    options.persist()
  }

  function createVolume() {
    const volume: Volume = { id: `volume-${Date.now()}`, title: '', collapsed: false }
    store.value.volumes.push(volume)
    selectedVolumeId.value = volume.id
    chapterSearch.value = ''
    options.persist()
  }

  function updateChapterTaskGoal(value: string) {
    if (activeChapter.value) activeChapter.value.taskGoal = value
  }

  function addChapterCast(value: string) {
    const chapter = activeChapter.value
    if (!chapter) return
    const incoming = value.split(/[\s,，、;；|｜/]+/g).map((name) => name.trim()).filter(Boolean)
    if (incoming.length) chapter.cast = [...new Set([...(chapter.cast ?? []), ...incoming])]
    castDraft.value = ''
  }

  function commitChapterCast(event: KeyboardEvent) {
    if (event.isComposing || ![' ', 'Enter', ',', '，', '、'].includes(event.key)) return
    event.preventDefault()
    addChapterCast(castDraft.value)
  }

  function removeChapterCast(name: string) {
    if (!activeChapter.value) return
    activeChapter.value.cast = (activeChapter.value.cast ?? []).filter((item) => item !== name)
  }

  return {
    activeChapter,
    visibleVolumes,
    normalizedChapterSearch,
    filteredChapters,
    chapterCountByVolume,
    cancelDeleteChapter,
    requestDeleteChapter,
    confirmDeleteChapter,
    formatChapterContent,
    toggleEditorTools,
    copyChapterAsPlainText,
    chapterNumber,
    chapterTitleForNumber,
    volumeForChapter,
    chaptersForVolume,
    toggleVolume,
    updateVolumeTitle,
    updateChapterTitle,
    chapterDisplayTitle,
    jumpToLastChapter,
    createChapter,
    createVolume,
    selectChapter,
    updateChapterContent,
    updateChapterTaskGoal,
    addChapterCast,
    commitChapterCast,
    removeChapterCast,
  }
}
