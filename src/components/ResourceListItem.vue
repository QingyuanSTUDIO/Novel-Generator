<script setup lang="ts">
import type { Resource } from '../types'

const reviewablePages = new Set(['world', 'characters', 'items', 'skills', 'outline', 'style'])

const props = defineProps<{
  item: Resource
  selected: boolean
  activePage: string
  triggerMeta: string
}>()

const emit = defineEmits<{
  select: [id: string]
  startResourceDrag: [event: DragEvent, resourceId: string]
  endResourceDrag: []
  dropResourceOnResource: [resourceId: string]
  toggleResourceEnabled: [id: string]
}>()

const reviewable = reviewablePages.has(props.activePage)

function isStyleEnabled(resource: Resource) {
  return resource.enabled !== false
}

function visibleSemanticTag(tag: string) {
  const normalized = tag.trim()
  return Boolean(normalized) && !['草稿', '待完善', '待推进', '待审阅'].includes(normalized)
}
</script>

<template>
  <button
    :class="['resource-item', { selected: props.selected, 'style-resource-disabled': props.activePage === 'style' && !isStyleEnabled(props.item) }]"
    type="button"
    draggable="true"
    @dragstart="emit('startResourceDrag', $event, props.item.id)"
    @dragend="emit('endResourceDrag')"
    @dragover.prevent.stop
    @drop.prevent.stop="emit('dropResourceOnResource', props.item.id)"
    @click="emit('select', props.item.id)"
  >
    <div class="resource-item-top">
      <strong>{{ props.item.title }}</strong>
      <span class="resource-item-card-actions">
        <span
          v-if="props.activePage === 'style'"
          class="style-resource-switch"
          role="switch"
          tabindex="0"
          :aria-checked="isStyleEnabled(props.item)"
          :title="isStyleEnabled(props.item) ? '关闭文风规则' : '启用文风规则'"
          @click.prevent.stop="emit('toggleResourceEnabled', props.item.id)"
          @keydown.enter.prevent.stop="emit('toggleResourceEnabled', props.item.id)"
          @keydown.space.prevent.stop="emit('toggleResourceEnabled', props.item.id)"
        >
          <span class="toggle-track"><span></span></span>{{ isStyleEnabled(props.item) ? '启用' : '停用' }}
        </span>
        <span v-if="visibleSemanticTag(props.item.tag)" class="tag">{{ props.item.tag }}</span>
      </span>
    </div>
    <p class="resource-item-meta">
      <span v-if="reviewable" :class="['entry-source-chip', props.item.creationSource === 'agent' ? 'agent-created' : 'manual-created']">{{ props.item.creationSource === 'agent' ? 'Agent 创建' : '手动创建' }}</span>
      <span v-if="reviewable" :class="['entry-review-chip', props.item.reviewStatus === 'complete' ? 'review-complete' : 'review-pending']">{{ props.item.reviewStatus === 'complete' ? '完成' : '待修改' }}</span>
      <span v-if="props.triggerMeta" class="resource-trigger-status">{{ props.triggerMeta }}</span>
      <span class="resource-summary">{{ props.item.summary }}</span>
    </p>
  </button>
</template>
