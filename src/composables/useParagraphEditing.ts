import { getCurrentScope, onScopeDispose, ref, watch, type ComputedRef } from 'vue'
import type { Chapter, Resource } from '../types'
import { splitChapterParagraphs } from '../utils/chapterText.ts'
import { requestChat } from '../api/chat.ts'
import { readModelSettings } from '../api/modelSettings.ts'

export type ParagraphEditTask = {
  index: number
  instruction: string
  status: 'editing' | 'waiting' | 'ready' | 'error'
  response: string
  error: string
  token: number
  chapterId: string
  chapterContentSnapshot: string
  original: string
}

export type ParagraphEditSelection = { index: number; paragraph: string }
export type ParagraphEditResult = ParagraphEditSelection & { response: string }

type ParagraphEditingOptions = {
  activeChapter: ComputedRef<Chapter | undefined>
  writerProvider: ComputedRef<Resource | undefined>
  effectiveCast: ComputedRef<string[]>
  getChapter: (id: string) => Chapter | undefined
  isApiConfigured: (resource: Resource) => boolean
  retrievedContext: (extra: string, forcedCast: string[]) => { text: string }
  formatStyleRulesContext: () => string
  localApiUrl: (path: string) => string
  updateChapterContent: (content: string) => void
}

export function useParagraphEditing(options: ParagraphEditingOptions) {
  const paragraphEdit = ref<ParagraphEditTask | null>(null)
  let paragraphEditToken = 0
  let activeRequest: { controller: AbortController; editToken: number; chapterId: string } | null = null

  function cancelActiveRequest() {
    const request = activeRequest
    activeRequest = null
    request?.controller.abort()
  }

  function isCurrentRequest(request: NonNullable<typeof activeRequest>) {
    return activeRequest === request
      && !request.controller.signal.aborted
      && paragraphEdit.value?.token === request.editToken
      && paragraphEdit.value.status === 'waiting'
      && options.activeChapter.value?.id === request.chapterId
  }

  function openParagraphEdit(payload: ParagraphEditSelection) {
    const chapter = options.activeChapter.value
    if (!chapter) return
    cancelActiveRequest()
    paragraphEditToken += 1
    paragraphEdit.value = {
      token: paragraphEditToken,
      chapterId: chapter.id,
      chapterContentSnapshot: chapter.content,
      index: payload.index,
      original: payload.paragraph,
      instruction: '',
      status: 'editing',
      response: '',
      error: '',
    }
  }

  function closeParagraphEdit() {
    cancelActiveRequest()
    paragraphEditToken += 1
    paragraphEdit.value = null
  }

  // Chapter switching can happen outside the chapter rail (for example when
  // changing works). Abort before a late response can reach the new editor.
  watch(() => options.activeChapter.value, (chapter, previous) => {
    if (paragraphEdit.value && (chapter?.id !== paragraphEdit.value.chapterId || chapter !== previous)) closeParagraphEdit()
  }, { flush: 'sync' })
  if (getCurrentScope()) onScopeDispose(closeParagraphEdit)

  function updateParagraphInstruction(value: string) {
    if (!paragraphEdit.value || paragraphEdit.value.status === 'waiting') return
    paragraphEdit.value.instruction = value
    paragraphEdit.value.status = 'editing'
    paragraphEdit.value.response = ''
    paragraphEdit.value.error = ''
  }

  async function requestParagraphEdit(payload: ParagraphEditSelection & { instruction: string }) {
    const edit = paragraphEdit.value
    if (!edit || edit.status === 'waiting' || activeRequest || edit.index !== payload.index || edit.original !== payload.paragraph || !payload.instruction.trim()) return
    const chapter = options.getChapter(edit.chapterId)
    const provider = options.writerProvider.value
    if (!chapter || options.activeChapter.value?.id !== edit.chapterId) return
    edit.instruction = payload.instruction
    edit.status = 'waiting'
    edit.error = ''
    edit.response = ''
    const request = { controller: new AbortController(), editToken: edit.token, chapterId: edit.chapterId }
    activeRequest = request

    try {
      if (chapter.content !== edit.chapterContentSnapshot || splitChapterParagraphs(chapter.content)[edit.index] !== edit.original) throw new Error('章节正文已经变化，请重新打开本段修改。')
      if (!provider || !options.isApiConfigured(provider)) throw new Error('请先在右侧选择并配置可用的正文生成 API。')
      const { text: rawContextText } = options.retrievedContext(`${payload.paragraph}\n${payload.instruction}`, options.effectiveCast.value)
      const contextText = rawContextText
      const chapterText = chapter.content || '（空）'
      const styleText = options.formatStyleRulesContext() || '当前没有启用的文风规则。'
      const text = await requestChat(options.localApiUrl, {
        ...readModelSettings(provider),
        providerId: provider.id,
        purpose: 'paragraph',
        baseUrl: provider.fields['接口地址'] ?? '',
        apiKey: provider.fields['API Key'] ?? '',
        protocol: provider.fields['协议'] ?? 'OpenAI Compatible',
        model: provider.fields['模型'] ?? '',
        useProxy: provider.fields['使用代理'] === 'true',
        proxyHost: provider.fields['代理地址'] ?? '',
        proxyPort: provider.fields['代理端口'] ?? '',
        responseFormat: 'text',
        stream: provider.fields['流式输出'] !== 'false',
        signal: request.controller.signal,
        messages: [
          { role: 'system', content: `你是小说段落编辑。根据作者要求修改指定段落，只返回修改后的段落正文，不要解释或添加 Markdown 标记。保留人物设定、已发生的剧情事实、信息揭露顺序和相邻段落的衔接，不得擅自改变世界书与角色卡中的事实。\n\n章节标题：${chapter.title}\n剧情目标：${chapter.taskGoal || '未指定'}\n出场人物：${options.effectiveCast.value.join('、') || '由正文和资料判断'}\n\n启用的文风规则：\n${styleText}\n\n章节全文（仅作上下文，不要重写全文）：\n${chapterText}\n\n本次智能检索资料：\n${contextText || '没有命中的资料。'}` },
          { role: 'user', content: `作者的修改要求：\n${payload.instruction}\n\n只修改下面这一段：\n${payload.paragraph}` },
        ],
      }, {
        onDelta: (delta) => {
          if (isCurrentRequest(request)) paragraphEdit.value!.response += delta
        },
      })
      if (!text.trim()) throw new Error('模型没有返回修改内容')
      if (!isCurrentRequest(request) || !paragraphEdit.value) return
      const currentChapter = options.getChapter(edit.chapterId)
      if (!currentChapter || currentChapter.content !== edit.chapterContentSnapshot || splitChapterParagraphs(currentChapter.content)[edit.index] !== edit.original) throw new Error('章节正文在等待回复时已变化，请重新发起修改。')
      paragraphEdit.value.status = 'ready'
      paragraphEdit.value.response = text.trim()
    } catch (error) {
      if (!isCurrentRequest(request) || !paragraphEdit.value) return
      paragraphEdit.value.status = 'error'
      paragraphEdit.value.error = error instanceof Error ? error.message : '段落修改失败，请稍后重试。'
    } finally {
      if (activeRequest === request) activeRequest = null
    }
  }

  function applyParagraphEdit(payload: ParagraphEditResult) {
    const edit = paragraphEdit.value
    const chapter = options.activeChapter.value
    if (!edit || edit.status !== 'ready' || !edit.response.trim() || edit.index !== payload.index || edit.original !== payload.paragraph || chapter?.id !== edit.chapterId || payload.response.trim() !== edit.response.trim()) return
    if (chapter.content !== edit.chapterContentSnapshot) {
      edit.status = 'error'
      edit.error = '章节正文已经变化，请重新发起修改。'
      return
    }
    const paragraphs = splitChapterParagraphs(chapter.content)
    if (paragraphs[payload.index] !== edit.original) {
      edit.status = 'error'
      edit.error = '本段内容已经变化，请重新发起修改。'
      return
    }
    paragraphs[payload.index] = edit.response.trim()
    options.updateChapterContent(paragraphs.join('\n\n'))
    closeParagraphEdit()
  }

  return {
    paragraphEdit,
    openParagraphEdit,
    closeParagraphEdit,
    updateParagraphInstruction,
    requestParagraphEdit,
    applyParagraphEdit,
  }
}
