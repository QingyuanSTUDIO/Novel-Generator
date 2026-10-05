<script setup lang="ts">
import { computed } from 'vue'
import { BookOpen, ChevronDown, ChevronRight, FileText, Layers3, ListTree } from 'lucide-vue-next'
import type { Chapter, OutlineNodeType, Resource } from '../types'

const props = defineProps<{
  node: Resource
  children: Resource[]
  childMap: Record<string, Resource[]>
  selectedId: string
  chapters: Chapter[]
  depth?: number
}>()

const emit = defineEmits<{
  select: [id: string]
  toggle: [id: string]
}>()

const depth = computed(() => props.depth ?? 0)
const hasChildren = computed(() => props.children.length > 0)
const collapsed = computed(() => props.node.outlineCollapsed === true)

const labels: Record<OutlineNodeType, string> = {
  book: '全书',
  volume: '卷',
  chapterRange: '章节范围',
  scene: '场景',
}

function nodeType(node: Resource): OutlineNodeType {
  return node.outlineType ?? 'chapterRange'
}

function nodeLabel(node: Resource) {
  return labels[nodeType(node)]
}

function rangeLabel(node: Resource) {
  const start = props.chapters.find((chapter) => chapter.id === node.outlineStartChapterId)?.title
  const end = props.chapters.find((chapter) => chapter.id === node.outlineEndChapterId)?.title
  if (!start && !end) return ''
  if (start && end && start !== end) return `${start} → ${end}`
  return start || end || ''
}

function iconFor(node: Resource) {
  const type = nodeType(node)
  if (type === 'book') return BookOpen
  if (type === 'volume') return Layers3
  if (type === 'scene') return FileText
  return ListTree
}
</script>

<template>
  <div class="outline-tree-node" :style="{ '--outline-depth': String(depth) }">
    <div :class="['outline-tree-row', { selected: props.selectedId === props.node.id }]">
      <button
        v-if="hasChildren"
        class="outline-tree-toggle"
        type="button"
        :title="collapsed ? '展开子大纲' : '折叠子大纲'"
        :aria-label="collapsed ? '展开子大纲' : '折叠子大纲'"
        @click="emit('toggle', props.node.id)"
      >
        <ChevronRight v-if="collapsed" :size="14" />
        <ChevronDown v-else :size="14" />
      </button>
      <span v-else class="outline-tree-toggle outline-tree-toggle-empty" aria-hidden="true"></span>
      <button class="outline-tree-select" type="button" @click="emit('select', props.node.id)">
        <component :is="iconFor(props.node)" :size="15" class="outline-tree-icon" />
        <span class="outline-tree-copy">
          <strong>{{ props.node.title }}</strong>
          <small>
            <span class="outline-tree-kind">{{ nodeLabel(props.node) }}</span>
            <span v-if="rangeLabel(props.node)" class="outline-tree-range">{{ rangeLabel(props.node) }}</span>
            <span v-if="props.node.summary" class="outline-tree-summary">{{ props.node.summary }}</span>
          </small>
        </span>
      </button>
    </div>
    <div v-if="hasChildren && !collapsed" class="outline-tree-children">
      <OutlineTreeNode
        v-for="child in props.children"
        :key="child.id"
        :node="child"
        :children="props.childMap[child.id] ?? []"
        :child-map="props.childMap"
        :selected-id="props.selectedId"
        :chapters="props.chapters"
        :depth="depth + 1"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
      />
    </div>
  </div>
</template>
