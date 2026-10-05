import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import { requestChat, type ChatMessage } from '../api/chat.ts'
import { readModelSettings } from '../api/modelSettings.ts'
import type { Chapter, Resource } from '../types.ts'

type Options = {
  activeChapter: Readonly<Ref<Chapter | undefined>>
  projectId: Readonly<Ref<string>>
  provider: Readonly<Ref<Resource | undefined>>
  candidate: Ref<string>
  busy: Ref<boolean>
  error: Ref<string>
  isApiConfigured: (provider: Resource) => boolean
  buildMessages: (chapter: Chapter) => ChatMessage[]
  localApiUrl: (path: string) => string
  updateChapterContent: (content: string) => void
}

/** Candidate text is never written to a chapter until a complete reply is accepted. */
export function useWritingGeneration(options: Options) {
  const state = ref<'idle' | 'running' | 'done' | 'error'>('idle')
  const detail = ref('')
  let runId = 0
  let controller: AbortController | undefined
  let target: { projectId: string; chapterId: string; content: string } | undefined
  const canAccept = computed(() => Boolean(
    state.value === 'done' && !options.busy.value && options.candidate.value.trim()
    && target?.projectId === options.projectId.value
    && target?.chapterId === options.activeChapter.value?.id
    && target?.content === options.activeChapter.value?.content,
  ))

  function discard() {
    runId += 1
    controller?.abort()
    controller = undefined
    target = undefined
    options.busy.value = false
    options.candidate.value = ''
    options.error.value = ''
    state.value = 'idle'
    detail.value = ''
  }

  watch([options.projectId, () => options.activeChapter.value?.id], discard, { flush: 'sync' })
  if (getCurrentScope()) onScopeDispose(discard)

  async function generate() {
    if (options.busy.value) return
    discard()
    const id = ++runId
    const chapter = options.activeChapter.value
    const projectId = options.projectId.value
    if (!chapter) return
    const chapterSnapshot = { ...chapter, cast: [...(chapter.cast ?? [])] }
    const currentController = new AbortController()
    controller = currentController
    options.busy.value = true
    state.value = 'running'
    detail.value = '正在检索章节任务、世界书、角色卡和文风规则'
    try {
      const provider = options.provider.value
      if (!provider || !options.isApiConfigured(provider)) throw new Error('请先在右上角设置中配置并保存一个可用 API。')
      const fields = { ...provider.fields }
      const messages = options.buildMessages(chapterSnapshot)
      const streaming = fields['流式输出'] !== 'false'
      detail.value = `已发送到 ${provider.title}，等待模型回复${streaming ? '（流式）' : ''}`
      const text = await requestChat(options.localApiUrl, {
        ...readModelSettings({ fields }),
        providerId: provider.id,
        purpose: 'writing',
        baseUrl: fields['接口地址'] ?? '',
        apiKey: fields['API Key'] ?? '',
        protocol: fields['协议'] ?? 'OpenAI Compatible',
        model: fields['模型'] ?? '',
        useProxy: fields['使用代理'] === 'true',
        proxyHost: fields['代理地址'] ?? '',
        proxyPort: fields['代理端口'] ?? '',
        responseFormat: 'text',
        stream: streaming,
        signal: currentController.signal,
        messages,
      }, {
        onDelta: (delta) => {
          if (id !== runId || currentController.signal.aborted) return
          options.candidate.value += delta
          const words = options.candidate.value.replace(/\s/g, '').length
          detail.value = `正在接收正文 · 已接收 ${words} 字`
        },
      })
      if (id !== runId) return
      if (chapterSnapshot.content !== options.activeChapter.value?.content) {
        throw new Error('生成期间本章正文发生了变化，请重新生成候选。')
      }
      options.candidate.value = text
      target = { projectId, chapterId: chapterSnapshot.id, content: chapterSnapshot.content }
      state.value = 'done'
      detail.value = `已生成 ${text.replace(/\s/g, '').length} 字候选正文，等待采纳`
    } catch (error) {
      if (id !== runId) return
      target = undefined
      options.error.value = error instanceof Error ? error.message : '生成正文失败，请检查 API 配置后重试。'
      state.value = 'error'
      detail.value = options.error.value
    } finally {
      if (id === runId) {
        options.busy.value = false
        controller = undefined
      }
    }
  }

  function accept() {
    if (!canAccept.value) {
      if (state.value === 'done' && options.candidate.value) {
        options.error.value = '候选生成后本章正文发生了变化，请重新生成。'
        state.value = 'error'
        detail.value = options.error.value
      }
      return
    }
    const content = options.activeChapter.value!.content.trimEnd()
    options.updateChapterContent(content ? `${content}\n\n${options.candidate.value}` : options.candidate.value)
    discard()
  }

  return { state, detail, canAccept, generate, discard, accept }
}
