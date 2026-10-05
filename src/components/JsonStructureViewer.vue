<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Clipboard, Code2 } from 'lucide-vue-next'

export type JsonStructureEntry = {
  key: string
  label: string
  description: string
  value: unknown
}

const props = defineProps<{
  entries: readonly JsonStructureEntry[]
}>()

const selectedKey = ref(props.entries[0]?.key ?? '')
const copied = ref(false)
const selectedEntry = computed(() => props.entries.find((entry) => entry.key === selectedKey.value) ?? props.entries[0])
const formattedJson = computed(() => selectedEntry.value ? JSON.stringify(selectedEntry.value.value, null, 2) : '{}')

async function copyJson() {
  if (!selectedEntry.value) return
  try {
    await navigator.clipboard.writeText(formattedJson.value)
    copied.value = true
    window.setTimeout(() => { copied.value = false }, 1500)
  } catch {
    copied.value = false
  }
}
</script>

<template>
  <section class="page-view json-viewer-page">
    <div class="page-header">
      <div>
        <span class="eyebrow">校对工具</span>
        <h1>JSON 结构查看器</h1>
        <p>查看各栏目发送给 AI 的通用结构。这里展示字段约定和示例，不会修改作品数据。</p>
      </div>
      <div class="header-stat"><Code2 :size="18" /><span>{{ entries.length }} 种结构</span></div>
    </div>
    <div class="json-viewer-grid">
      <aside class="json-structure-list" aria-label="JSON 结构类型">
        <button
          v-for="entry in entries"
          :key="entry.key"
          type="button"
          :class="['json-structure-item', { selected: selectedEntry?.key === entry.key }]"
          @click="selectedKey = entry.key"
        >
          <strong>{{ entry.label }}</strong>
          <span>{{ entry.description }}</span>
        </button>
      </aside>
      <article v-if="selectedEntry" class="json-structure-detail">
        <div class="json-detail-head">
          <div><span class="eyebrow">通用格式</span><h2>{{ selectedEntry.label }}</h2><p>{{ selectedEntry.description }}</p></div>
          <button class="button secondary" type="button" @click="copyJson"><Check v-if="copied" :size="15" /><Clipboard v-else :size="15" />{{ copied ? '已复制' : '复制 JSON' }}</button>
        </div>
        <pre class="json-code"><code>{{ formattedJson }}</code></pre>
      </article>
      <div v-else class="empty-state">暂无可查看的结构。</div>
    </div>
  </section>
</template>
