<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Check, LoaderCircle, Send, Sparkles, X } from 'lucide-vue-next'

type ParagraphEditView = {
  index: number
  instruction: string
  status: 'editing' | 'waiting' | 'ready' | 'error'
  response: string
  error: string
}

const props = defineProps<{
  modelValue: string
  editState: ParagraphEditView | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'open-edit': [payload: { index: number; paragraph: string }]
  'close-edit': []
  'update-instruction': [value: string]
  'request-edit': [payload: { index: number; paragraph: string; instruction: string }]
  'apply-edit': [payload: { index: number; paragraph: string; response: string }]
}>()

const paragraphInputs = ref<(HTMLTextAreaElement | null)[]>([])
const paragraphs = computed(() => {
  const content = props.modelValue.replace(/\r\n?/g, '\n')
  return content ? content.split(/\n[ \t\u3000]*\n+/) : ['']
})

function setParagraphInput(element: Element | null, index: number) {
  paragraphInputs.value[index] = element as HTMLTextAreaElement | null
}

function updateParagraph(index: number, value: string) {
  const next = [...paragraphs.value]
  const split = value.split(/\n[ \t\u3000]*\n+/)
  next.splice(index, 1, ...split)
  emit('update:modelValue', next.join('\n\n'))
  if (split.length > 1) {
    void nextTick(() => {
      const input = paragraphInputs.value[index + split.length - 1]
      input?.focus()
      input?.setSelectionRange(split[split.length - 1].length, split[split.length - 1].length)
    })
  }
}

function toggleEdit(index: number, paragraph: string) {
  if (props.editState?.index === index) emit('close-edit')
  else emit('open-edit', { index, paragraph })
}

function requestEdit(index: number, paragraph: string) {
  const edit = props.editState
  if (!edit || edit.status === 'waiting' || !edit.instruction.trim()) return
  emit('request-edit', { index, paragraph, instruction: edit.instruction })
}
</script>

<template>
  <div class="paragraph-editor-list">
    <section v-for="(paragraph, index) in paragraphs" :key="index" class="novel-paragraph">
      <div class="paragraph-editor-head">
        <span>第 {{ index + 1 }} 段</span>
        <button class="icon-button paragraph-ai-trigger" type="button" :title="editState?.index === index ? (editState.status === 'waiting' ? '取消请求并关闭本段 AI 修改' : '关闭本段 AI 修改') : 'AI 修改本段'" :aria-label="editState?.index === index ? (editState.status === 'waiting' ? '取消请求并关闭本段 AI 修改' : '关闭本段 AI 修改') : 'AI 修改本段'" :aria-expanded="editState?.index === index" :disabled="disabled || !paragraph.trim()" @click="toggleEdit(index, paragraph)"><Sparkles :size="15" /></button>
      </div>
      <textarea :ref="(element) => setParagraphInput(element as Element | null, index)" class="novel-paragraph-input" :class="{ 'empty-paragraph': !modelValue }" :rows="Math.max(3, Math.ceil(paragraph.length / 34) + paragraph.split('\n').length - 1)" :value="paragraph" :aria-label="`第 ${index + 1} 段正文`" placeholder="输入正文段落" @input="updateParagraph(index, ($event.target as HTMLTextAreaElement).value)" />
      <div v-if="editState?.index === index" class="paragraph-ai-panel">
        <div class="paragraph-ai-heading"><strong>AI 修改本段</strong><button class="icon-button" type="button" :title="editState.status === 'waiting' ? '取消请求并关闭' : '关闭'" :aria-label="editState.status === 'waiting' ? '取消请求并关闭' : '关闭'" @click="emit('close-edit')"><X :size="14" /></button></div>
        <label class="paragraph-ai-request"><span>修改要求</span><textarea :value="editState.instruction" rows="2" placeholder="例如：加强紧张感，保留剧情事实和人物说话习惯" :disabled="editState.status === 'waiting'" @input="emit('update-instruction', ($event.target as HTMLTextAreaElement).value)" @keydown.ctrl.enter.prevent="requestEdit(index, paragraph)" @keydown.meta.enter.prevent="requestEdit(index, paragraph)" /></label>
        <div v-if="editState.status === 'waiting'" class="paragraph-ai-waiting"><LoaderCircle class="spin" :size="14" />{{ editState.response ? '正在接收修改内容，完成后可采纳…' : '正在读取章节资料并等待模型回复…' }}</div>
        <div v-if="editState.status === 'error'" class="paragraph-ai-error" role="alert">{{ editState.error }}</div>
        <div v-if="editState.response && ['waiting', 'ready', 'error'].includes(editState.status)" :class="['paragraph-ai-response', { 'paragraph-ai-response-live': editState.status === 'waiting', 'paragraph-ai-response-incomplete': editState.status === 'error' }]">
          <span>{{ editState.status === 'ready' ? 'AI 建议' : editState.status === 'waiting' ? '实时预览 · 尚未完成' : '未完成回复 · 不可采纳' }}</span>
          <p>{{ editState.response }}<span v-if="editState.status === 'waiting'" class="paragraph-ai-typing-cursor" aria-hidden="true"></span></p>
          <div v-if="editState.status === 'ready'" class="paragraph-ai-actions"><button class="button secondary" type="button" @click="emit('close-edit')">保留原文</button><button class="button primary" type="button" @click="emit('apply-edit', { index, paragraph, response: editState.response })"><Check :size="14" />替换本段</button></div>
        </div>
        <button v-if="editState.status !== 'ready'" class="button primary paragraph-ai-send" type="button" :disabled="editState.status === 'waiting' || !editState.instruction.trim()" @click="requestEdit(index, paragraph)"><Send :size="14" />{{ editState.status === 'waiting' ? '等待回复' : '发送修改要求' }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.paragraph-ai-response-live > span { color: var(--theme-button); }
.paragraph-ai-response-incomplete > span { color: var(--theme-danger, var(--theme-button)); }
.paragraph-ai-typing-cursor { display: inline-block; width: 2px; height: 1.05em; margin-left: 3px; background: var(--theme-button); vertical-align: -.13em; animation: paragraph-cursor-blink 1s step-end infinite; }
@keyframes paragraph-cursor-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .paragraph-ai-typing-cursor { animation: none; }
}
</style>
