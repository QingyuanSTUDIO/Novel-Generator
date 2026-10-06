<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowRight, Search, X } from 'lucide-vue-next'
import { globalSearchCollectionLabels, searchGlobalDocuments, type GlobalSearchDocument, type GlobalSearchResult } from '../search/globalSearch'

const props = withDefaults(defineProps<{
  open: boolean
  documents: readonly GlobalSearchDocument[]
  currentProjectId?: string
}>(), { currentProjectId: '' })

const emit = defineEmits<{
  close: []
  select: [result: GlobalSearchResult]
}>()

const input = ref('')
const inputElement = ref<HTMLInputElement | null>(null)
const selectedIndex = ref(0)

const results = computed(() => searchGlobalDocuments(props.documents, input.value))
const groupedCount = computed(() => new Set(results.value.map((result) => result.collection)).size)

watch(() => props.open, (open) => {
  if (!open) return
  selectedIndex.value = 0
  void nextTick(() => inputElement.value?.focus())
})
watch(input, () => { selectedIndex.value = 0 })

function close() {
  emit('close')
}

function selectResult(result: GlobalSearchResult) {
  emit('select', result)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, Math.max(0, results.value.length - 1))
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    selectedIndex.value = Math.max(0, selectedIndex.value - 1)
    return
  }
  if (event.key === 'Enter' && results.value[selectedIndex.value]) {
    event.preventDefault()
    selectResult(results.value[selectedIndex.value])
  }
}

function highlightSnippet(snippet: string) {
  const queryTerms = input.value.trim().split(/\s+/u).filter(Boolean)
  if (!queryTerms.length) return [{ text: snippet, hit: false }]
  const escaped = queryTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
  const expression = new RegExp(`(${escaped})`, 'giu')
  const parts: { text: string; hit: boolean }[] = []
  let last = 0
  for (const match of snippet.matchAll(expression)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: snippet.slice(last, index), hit: false })
    parts.push({ text: match[0], hit: true })
    last = index + match[0].length
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false })
  return parts.length ? parts : [{ text: snippet, hit: false }]
}

function collectionLabel(result: GlobalSearchResult) {
  return globalSearchCollectionLabels[result.collection] ?? result.collectionLabel
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="global-search-backdrop" @click.self="close">
      <section class="global-search-dialog" role="dialog" aria-modal="true" aria-labelledby="global-search-title" @keydown="onKeydown">
        <header class="global-search-header">
          <div>
            <span class="eyebrow">作品级检索</span>
            <h2 id="global-search-title">搜索全部资料</h2>
            <p>搜索章节、世界书、卡片、大纲、世界引擎、自定义模块、热梗和 Agent 对话。</p>
          </div>
          <button class="icon-button" type="button" title="关闭搜索" aria-label="关闭搜索" @click="close"><X :size="18" /></button>
        </header>
        <label class="global-search-input-wrap">
          <Search :size="17" />
          <input ref="inputElement" v-model="input" type="search" placeholder="输入名称、关键词或正文片段" aria-label="搜索全部资料" autocomplete="off" />
          <kbd>Esc</kbd>
        </label>
        <div class="global-search-meta">
          <span v-if="input.trim()">找到 {{ results.length }} 条结果 · {{ groupedCount }} 个栏目</span>
          <span v-else>输入关键词后开始检索</span>
          <small>↑↓选择 · Enter打开</small>
        </div>
        <div class="global-search-results" role="listbox" aria-label="搜索结果">
          <button
            v-for="(result, index) in results"
            :key="result.id"
            :class="['global-search-result', { selected: selectedIndex === index }]"
            type="button"
            role="option"
            :aria-selected="selectedIndex === index"
            @mouseenter="selectedIndex = index"
            @click="selectResult(result)"
          >
            <div class="global-search-result-head">
              <span class="global-search-result-badge">{{ collectionLabel(result) }}</span>
              <span v-if="result.projectId !== props.currentProjectId" class="global-search-result-project">{{ result.projectTitle }}</span>
              <ArrowRight :size="14" />
            </div>
            <strong>{{ result.title }}</strong>
            <small v-if="result.location">{{ result.location }}</small>
            <p><template v-for="(part, partIndex) in highlightSnippet(result.snippet)" :key="`${result.id}-${partIndex}`"><mark v-if="part.hit">{{ part.text }}</mark><span v-else>{{ part.text }}</span></template></p>
          </button>
          <div v-if="input.trim() && !results.length" class="global-search-empty"><Search :size="25" /><strong>没有找到匹配内容</strong><span>试试名称、章节片段或角色状态。</span></div>
          <div v-else-if="!input.trim()" class="global-search-empty global-search-empty-start"><Search :size="25" /><strong>从任意资料开始搜索</strong><span>搜索结果会按标题命中优先排列。</span></div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.global-search-backdrop { position: fixed; z-index: 7000; inset: 0; display: flex; align-items: flex-start; justify-content: center; padding: min(14vh, 120px) 18px 18px; background: var(--theme-overlay, rgba(0, 0, 0, .42)); }
.global-search-dialog { display: flex; width: min(740px, 100%); max-height: min(740px, calc(100vh - 150px)); flex-direction: column; overflow: hidden; border: 1px solid var(--theme-border); border-radius: 12px; background: var(--theme-surface); color: var(--theme-font); box-shadow: 0 22px 70px color-mix(in srgb, var(--theme-font) 22%, transparent); }
.global-search-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 21px 22px 15px; border-bottom: 1px solid var(--theme-border); }
.global-search-header h2 { margin: 5px 0 0; font-size: 20px; }
.global-search-header p { margin: 7px 0 0; color: var(--theme-muted); font-size: 12px; }
.global-search-input-wrap { display: flex; align-items: center; gap: 9px; margin: 15px 18px 8px; padding: 0 11px; border: 1px solid var(--theme-border); border-radius: 8px; color: var(--theme-muted); background: var(--theme-input-bg); }
.global-search-input-wrap:focus-within { border-color: var(--theme-button); box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-button) 20%, transparent); }
.global-search-input-wrap input { min-width: 0; flex: 1; height: 42px; border: 0; outline: 0; color: var(--theme-font); background: transparent; font-size: 14px; }
.global-search-input-wrap kbd { padding: 3px 6px; border: 1px solid var(--theme-border); border-radius: 4px; color: var(--theme-muted); background: var(--theme-surface-soft); font-size: 10px; }
.global-search-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 20px 9px; color: var(--theme-muted); font-size: 11px; }
.global-search-meta small { color: var(--theme-muted); }
.global-search-results { min-height: 160px; overflow: auto; padding: 0 11px 12px; }
.global-search-result { width: 100%; display: block; padding: 11px 11px 10px; border: 1px solid transparent; border-radius: 8px; color: var(--theme-font); background: transparent; text-align: left; }
.global-search-result:hover, .global-search-result.selected { border-color: var(--theme-border); background: var(--theme-hover); }
.global-search-result-head { display: flex; align-items: center; gap: 7px; color: var(--theme-muted); }
.global-search-result-head > svg { margin-left: auto; opacity: .55; }
.global-search-result-badge { padding: 3px 6px; border-radius: 4px; color: var(--theme-button-text); background: var(--theme-button); font-size: 10px; }
.global-search-result-project { overflow: hidden; max-width: 220px; text-overflow: ellipsis; white-space: nowrap; }
.global-search-result strong { display: block; margin-top: 6px; font-size: 14px; }
.global-search-result > small { display: block; margin-top: 4px; color: var(--theme-muted); font-size: 11px; }
.global-search-result p { margin: 5px 0 0; color: var(--theme-muted); font-size: 12px; line-height: 1.55; }
.global-search-result mark { border-radius: 2px; color: var(--theme-font); background: color-mix(in srgb, var(--theme-button) 24%, transparent); }
.global-search-empty { display: flex; min-height: 190px; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--theme-muted); text-align: center; }
.global-search-empty strong { color: var(--theme-font); font-size: 14px; }
.global-search-empty span { font-size: 12px; }
.global-search-empty-start { min-height: 240px; }
@media (max-width: 600px) { .global-search-backdrop { padding: 8vh 10px 10px; } .global-search-header { padding: 17px 16px 13px; } .global-search-input-wrap { margin-inline: 13px; } .global-search-meta { padding-inline: 15px; } }
</style>
