<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { ArrowDown, ArrowUp, ChevronDown, ChevronsDownUp, ChevronsUpDown, GripVertical, SlidersHorizontal } from 'lucide-vue-next'
import type { ContextBlock } from '../types'

type ContextItem = {
  id: string
  title: string
  source?: string
  role?: string
  tokens?: number
  enabled?: boolean
  collection?: string
  resourceId?: string
  resourceIds?: string[]
  customModuleId?: string
  tag?: string
}

type ContextBlockView = ContextBlock & {
  items?: ContextItem[]
  collapsed?: boolean
  collection?: string
  order?: number
}

const props = defineProps<{
  blocks: ContextBlockView[]
}>()

const emit = defineEmits<{
  (event: 'update-blocks', blocks: ContextBlockView[]): void
}>()

const draggingBlockId = ref('')
const draggingItem = ref<{ blockId: string; itemId: string } | null>(null)

function hasInternalDrag() {
  return Boolean(draggingBlockId.value || draggingItem.value)
}

function allowGlobalDrop(event: DragEvent) {
  if (!hasInternalDrag()) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function attachGlobalDropGuard() {
  window.addEventListener('dragover', allowGlobalDrop, true)
}

function detachGlobalDropGuard() {
  window.removeEventListener('dragover', allowGlobalDrop, true)
}

const enabledCount = computed(() => props.blocks.filter((block) => block.enabled).length)
const totalItemCount = computed(() => props.blocks.reduce((sum, block) => sum + (block.items?.length ?? 0), 0))
const allBlocksCollapsed = computed(() => props.blocks.length > 0 && props.blocks.every((block) => block.collapsed !== false))

function isBlockCollapsed(block: ContextBlockView) {
  // Missing collapse state is treated as the default collapsed state. This
  // keeps layouts created before the field was added compact on first open.
  return block.collapsed !== false
}

function copyBlocks() {
  // props.blocks can contain Vue reactive proxies. JSON cloning keeps the
  // layout data plain so Electron's drag and click handlers can update it.
  const blocks = JSON.parse(JSON.stringify(props.blocks)) as ContextBlockView[]
  // Materialize the default so the first interaction persists the collapsed
  // state instead of letting the normalization layer expand missing values.
  return blocks.map((block) => ({ ...block, collapsed: isBlockCollapsed(block) }))
}

function publish(blocks = copyBlocks()) {
  emit('update-blocks', blocks)
}

function itemsFor(block: ContextBlockView) {
  return Array.isArray(block.items) ? block.items : []
}

function toggleBlock(blockId: string) {
  const blocks = copyBlocks()
  const block = blocks.find((item) => item.id === blockId)
  if (!block) return
  block.enabled = !block.enabled
  publish(blocks)
}

function toggleItem(blockId: string, itemId: string) {
  const blocks = copyBlocks()
  const block = blocks.find((item) => item.id === blockId)
  const item = block?.items?.find((entry) => entry.id === itemId)
  if (!item) return
  item.enabled = item.enabled === false
  publish(blocks)
}

function toggleBlockCollapsed(blockId: string) {
  const blocks = copyBlocks()
  const block = blocks.find((item) => item.id === blockId)
  if (!block) return
  block.collapsed = !isBlockCollapsed(block)
  publish(blocks)
}

function setAllBlocksCollapsed(collapsed: boolean) {
  const blocks = copyBlocks()
  const changed = blocks.some((block) => block.collapsed !== collapsed)
  if (!changed) return
  for (const block of blocks) block.collapsed = collapsed
  publish(blocks)
}

function toggleAllBlocksCollapsed() {
  setAllBlocksCollapsed(!allBlocksCollapsed.value)
}

function moveBlock(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= props.blocks.length) return
  const blocks = copyBlocks()
  ;[blocks[index], blocks[target]] = [blocks[target], blocks[index]]
  publish(blocks)
}

function moveItem(blockId: string, index: number, direction: -1 | 1) {
  const blocks = copyBlocks()
  const block = blocks.find((item) => item.id === blockId)
  if (!block?.items) return
  const target = index + direction
  if (target < 0 || target >= block.items.length) return
  ;[block.items[index], block.items[target]] = [block.items[target], block.items[index]]
  publish(blocks)
}

function startBlockDrag(event: DragEvent, blockId: string) {
  draggingBlockId.value = blockId
  draggingItem.value = null
  attachGlobalDropGuard()
  event.dataTransfer?.setData('text/plain', `block:${blockId}`)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function startItemDrag(event: DragEvent, blockId: string, itemId: string) {
  draggingItem.value = { blockId, itemId }
  draggingBlockId.value = ''
  attachGlobalDropGuard()
  event.dataTransfer?.setData('text/plain', `item:${blockId}:${itemId}`)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function finishDrag() {
  draggingBlockId.value = ''
  draggingItem.value = null
  detachGlobalDropGuard()
}

function dropBlock(event: DragEvent, targetIndex: number) {
  event.preventDefault()
  const sourceId = draggingBlockId.value || event.dataTransfer?.getData('text/plain').replace(/^block:/, '')
  if (!sourceId) return finishDrag()
  const sourceIndex = props.blocks.findIndex((block) => block.id === sourceId)
  if (sourceIndex < 0 || sourceIndex === targetIndex) return finishDrag()
  const blocks = copyBlocks()
  const [moved] = blocks.splice(sourceIndex, 1)
  blocks.splice(targetIndex, 0, moved)
  publish(blocks)
  finishDrag()
}

function dropItem(event: DragEvent, targetBlockId: string, targetIndex: number) {
  event.preventDefault()
  const source = draggingItem.value
  if (!source) return finishDrag()
  const blocks = copyBlocks()
  const sourceBlock = blocks.find((block) => block.id === source.blockId)
  const targetBlock = blocks.find((block) => block.id === targetBlockId)
  if (!sourceBlock?.items || !targetBlock?.items) return finishDrag()
  const sourceIndex = sourceBlock.items.findIndex((item) => item.id === source.itemId)
  if (sourceIndex < 0) return finishDrag()
  const sourceItem = sourceBlock.items[sourceIndex]
  const sourceIsCustom = Boolean(sourceItem.customModuleId || sourceItem.collection === 'custom' || sourceBlock.collection === 'custom')
  const targetIsCustom = targetBlock.collection === 'custom'
  // Custom-module schemas are their own prompt collection. Do not let a
  // dragged module entry land in a world/character/item/skill block (or let a
  // standard resource get dropped into the custom block), where it would be
  // rendered and injected under the wrong boundary.
  if (sourceIsCustom !== targetIsCustom) return finishDrag()
  const [moved] = sourceBlock.items.splice(sourceIndex, 1)
  let insertIndex = targetIndex
  if (source.blockId === targetBlockId && sourceIndex < targetIndex) insertIndex -= 1
  targetBlock.items.splice(Math.max(0, insertIndex), 0, moved)
  publish(blocks)
  finishDrag()
}

function allowDrop(event: DragEvent) {
  if (!hasInternalDrag()) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function ignoreDropOutsideItems(event: DragEvent) {
  if (!draggingBlockId.value && !draggingItem.value) return
  event.preventDefault()
  finishDrag()
}

onBeforeUnmount(detachGlobalDropGuard)
</script>

<template>
  <div class="context-orchestration" @dragover="allowDrop" @drop="ignoreDropOutsideItems">
    <div class="context-orchestration-head">
      <div>
        <div class="inspector-icon"><SlidersHorizontal :size="18" /></div>
        <h2>提示词顺序</h2>
        <p>先排列资料大块，再在块内排列标签。启用的内容会按此顺序注入模型。</p>
      </div>
      <div class="context-orchestration-head-tools">
        <div class="context-orchestration-stats">
          <strong>{{ enabledCount }} / {{ blocks.length }}</strong><span>启用大块</span>
          <strong>{{ totalItemCount }}</strong><span>个资料标签</span>
        </div>
        <button
          class="button secondary context-collapse-all-button"
          type="button"
          :disabled="!blocks.length"
          :aria-label="allBlocksCollapsed ? '展开全部提示大块' : '折叠全部提示大块'"
          :title="allBlocksCollapsed ? '展开全部提示大块' : '折叠全部提示大块'"
          @click="toggleAllBlocksCollapsed"
        >
          <ChevronsUpDown v-if="allBlocksCollapsed" :size="15" />
          <ChevronsDownUp v-else :size="15" />
          {{ allBlocksCollapsed ? '全部展开' : '全部折叠' }}
        </button>
      </div>
    </div>

    <div class="context-orchestration-list" @dragend="finishDrag">
      <article
        v-for="(block, blockIndex) in blocks"
        :key="block.id"
        class="context-group-card"
        :class="{ disabled: !block.enabled, dragging: draggingBlockId === block.id }"
        draggable="true"
        @dragstart="startBlockDrag($event, block.id)"
        @dragover="allowDrop"
        @drop="dropBlock($event, blockIndex)"
      >
        <header class="context-group-head">
          <div class="context-group-grip" title="拖动大块排序"><GripVertical :size="17" /></div>
          <button class="context-group-collapse" type="button" :aria-expanded="!isBlockCollapsed(block)" :title="isBlockCollapsed(block) ? '展开大块' : '折叠大块'" @click.stop="toggleBlockCollapsed(block.id)"><ChevronDown :size="16" :class="{ collapsed: isBlockCollapsed(block) }" /></button>
          <div class="context-group-title"><strong>{{ blockIndex + 1 }}. {{ block.title }}</strong><span>{{ block.source }}<template v-if="block.role"> · {{ block.role }}</template></span></div>
          <span class="token-count">{{ block.tokens }} t</span>
          <button class="icon-button" type="button" title="上移大块" :disabled="blockIndex === 0" @click.stop="moveBlock(blockIndex, -1)"><ArrowUp :size="15" /></button>
          <button class="icon-button" type="button" title="下移大块" :disabled="blockIndex === blocks.length - 1" @click.stop="moveBlock(blockIndex, 1)"><ArrowDown :size="15" /></button>
          <button class="toggle" type="button" :aria-pressed="block.enabled" :title="block.enabled ? '停用大块' : '启用大块'" @click.stop="toggleBlock(block.id)"><span /></button>
        </header>

        <div v-if="!isBlockCollapsed(block)" class="context-group-body" @dragover="allowDrop">
          <div v-if="itemsFor(block).length" class="context-item-list">
            <div
              v-for="(item, itemIndex) in itemsFor(block)"
              :key="item.id"
              class="context-item-row"
              :class="{ disabled: item.enabled === false, dragging: draggingItem?.itemId === item.id }"
              draggable="true"
              @dragstart.stop="startItemDrag($event, block.id, item.id)"
              @dragover.stop="allowDrop"
              @drop.stop="dropItem($event, block.id, itemIndex)"
            >
              <span class="context-item-grip" title="拖动标签排序"><GripVertical :size="14" /></span>
              <div class="context-item-copy"><strong>{{ item.title }}</strong><span>{{ item.tag || item.source || item.collection || '资料标签' }}<template v-if="item.role"> · {{ item.role }}</template></span></div>
              <span v-if="item.tokens" class="token-count">{{ item.tokens }} t</span>
              <button class="icon-button" type="button" title="上移标签" :disabled="itemIndex === 0" @click.stop="moveItem(block.id, itemIndex, -1)"><ArrowUp :size="13" /></button>
              <button class="icon-button" type="button" title="下移标签" :disabled="itemIndex === itemsFor(block).length - 1" @click.stop="moveItem(block.id, itemIndex, 1)"><ArrowDown :size="13" /></button>
              <button class="toggle compact" type="button" :aria-pressed="item.enabled !== false" :title="item.enabled === false ? '启用标签' : '停用标签'" @click.stop="toggleItem(block.id, item.id)"><span /></button>
            </div>
          </div>
          <p v-else class="context-items-empty">这个大块暂未拆分标签，将按块整体注入。</p>
        </div>
      </article>
    </div>
  </div>
</template>
