<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Braces, ChevronDown, ChevronsDownUp, ChevronsUpDown, Ellipsis, FileText, FolderPlus, LockKeyhole, LockKeyholeOpen, PenLine, Plus, Trash2, X } from 'lucide-vue-next'
import { agentResourceTemplateFields } from '../agent/resourceFieldPolicy'
import type { StandardResourceType } from '../agent/resourceStructure'
import type { Chapter, Resource, ResourceGroup, Volume } from '../types'
import { canonicalTriggerField, triggerKeysFor, triggerStrategyFor } from '../context/retrieval'
import CharacterImageManager from './CharacterImageManager.vue'
import ExpandableTextarea from './ExpandableTextarea.vue'
import OutlineTreeNode from './OutlineTreeNode.vue'
import ResourceListItem from './ResourceListItem.vue'

type GroupSection = ResourceGroup & { resources: Resource[] }

const props = defineProps<{
  title: string
  intro: string
  activePage: string
  activeCollection: Resource[]
  selectedResource?: Resource
  creationPromptHints?: Record<string, string>
  roleOptions: readonly string[]
  resourceCreateLabel: string
  activeGroupPage: string | null
  activeGroups: ResourceGroup[]
  resourceGroupSections: GroupSection[]
  dropTargetGroupId: string | null
  outlineRoots?: Resource[]
  outlineChildMap?: Record<string, Resource[]>
  outlineChapters?: Chapter[]
  outlineVolumes?: Volume[]
}>()

const emit = defineEmits<{
  addResource: []
  openResourceGroupDialog: []
  renameResourceGroup: [id: string]
  moveResourceGroupToTop: [id: string]
  moveResourceGroupToBottom: [id: string]
  deleteResourceGroup: [id: string]
  setAllResourceGroupsCollapsed: [collapsed: boolean]
  selectResource: [id: string]
  toggleResourceGroup: [id: string]
  startResourceDrag: [event: DragEvent, resourceId: string]
  endResourceDrag: []
  startResourceGroupDrag: [event: DragEvent, groupId: string]
  endResourceGroupDrag: []
  dragOverResourceGroup: [groupId: string]
  dropResourceIntoGroup: [groupId: string]
  dropResourceOnResource: [resourceId: string]
  removeResource: []
  updateTitle: [value: string]
  updateSummary: [value: string]
  updateField: [key: string, value: string]
  updateCreationPromptHint: [key: string, value: string]
  updateCharacterField: [key: string, value: string]
  updateCharacterImages: [payload: { images: NonNullable<Resource['characterImages']>; coverImageId: string }]
  updateResourceMeta: [key: 'allowRecursive' | 'allowFurtherRecursive' | 'injectionOrder', value: boolean | number]
  toggleResourceLock: [field: string]
  toggleReviewStatus: []
  toggleReviewStatusLock: []
  toggleResourceLockAll: []
  toggleResourceEnabled: [id: string]
  toggleOutlineCollapse: [id: string]
  updateOutlineStructure: [payload: { outlineType?: Resource['outlineType']; outlineParentId?: string; outlineStartChapterId?: string; outlineEndChapterId?: string; outlineCollapsed?: boolean }]
}>()

function fieldType(key: string) {
  return key.toLowerCase().includes('key') || key.includes('密钥') ? 'password' : 'text'
}

const contextResourcePages = ['world', 'characters', 'items', 'skills']
const reviewableResourcePages = ['world', 'characters', 'items', 'skills', 'outline', 'style']
const hiddenStyleMetadataFields = new Set(['检查方式', '触发键', '触发词', '关键词', '关键字', '触发策略', '触发方式', '触发模式'])
const longTextFieldNames = new Set(['当前状态', '人物动机', '性格', '已知信息', '尚未知晓', '说话习惯', '外貌', '技能效果', '用途', '内容', '说明', '规则', '反例', '正例', '适用范围', '章节目标', '卷目标', '卷结局', '场景', '冲突', '结尾状态', '作者真相', '表面线索', '回收窗口', '本章动作', '关联线索', '后果', '描述', '背景', '约束', '允许', '视角', '使用限制'])
const triggerDraft = ref('')
const creationStructureOpen = ref(false)
const structureDialog = ref<HTMLElement | null>(null)
const structureEditorButton = ref<HTMLButtonElement | null>(null)
const groupDragInProgress = ref(false)
const resourceDragInProgress = ref(false)
const openGroupMenuId = ref<string | null>(null)

watch(() => [props.selectedResource?.id, props.activePage], () => {
  triggerDraft.value = ''
})
watch(() => props.activePage, (page) => {
  closeGroupMenu()
  if (!['world', 'characters', 'items', 'skills'].includes(page)) creationStructureOpen.value = false
})

function triggerStrategy(resource: Resource): '常驻' | '关键词' {
  return triggerStrategyFor(resource) === 'always' ? '常驻' : '关键词'
}

function triggerStrategyHint(resource: Resource) {
  if (triggerStrategy(resource) === '常驻') return '启用后每次生成都会注入，不需要命中关键词。'
  return props.activePage === 'world'
    ? '命中已配置的触发词后注入；未填写时不会通过关键词触发。'
    : `命中触发词后注入；未填写触发词时使用当前名称：${resource.title}`
}

const triggerTags = computed(() => props.selectedResource ? triggerKeysFor(props.selectedResource) : [])
const structureResourceTypes: Partial<Record<string, StandardResourceType>> = {
  world: 'world',
  characters: 'character',
  items: 'item',
  skills: 'skill',
}
const supportsStructureEdit = computed(() => Boolean(structureResourceTypes[props.activePage]))
const creationStructureFields = computed(() => {
  const type = structureResourceTypes[props.activePage]
  return type ? [...new Set(['名称', '摘要', ...agentResourceTemplateFields[type]])] : []
})
const creationStructurePreview = computed(() => {
  const resourceType = structureResourceTypes[props.activePage]
  if (!resourceType) return ''
  const fields = Object.fromEntries(
    creationStructureFields.value
      .filter((field) => field !== '名称' && field !== '摘要')
      .map((field) => [field, '']),
  )
  return JSON.stringify({
    action: 'create_resource',
    resourceType,
    title: '',
    summary: '',
    fields,
  }, null, 2)
})

function creationFieldHint(key: string) {
  return props.creationPromptHints?.[key] ?? ''
}

function openCreationStructureEditor() {
  creationStructureOpen.value = true
  void nextTick(() => structureDialog.value?.focus())
}

function closeCreationStructureEditor() {
  creationStructureOpen.value = false
  void nextTick(() => structureEditorButton.value?.focus())
}

function isContextTriggerField(key: string) {
  return (contextResourcePages.includes(props.activePage)
    && ['触发键', '触发词', '关键词', '关键字', '触发策略', '触发方式', '触发模式'].includes(key))
    || (props.activePage === 'style' && hiddenStyleMetadataFields.has(key))
    || (props.activePage === 'characters' && key === '角色信息')
}

function isLongTextField(key: string) {
  return longTextFieldNames.has(key) || /(?:说明|描述|背景|动机|习惯|内容|效果|目标|计划|状态|信息|原因|真相|限制|作用|意图|约束|线索|动作|策略|结果|补充|概要|摘要)/.test(key)
}

function saveTriggerTags(tags: string[]) {
  emit('updateField', '触发键', [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].join('、'))
}

function addTriggerTags(value: string) {
  const incoming = value.split(/[\s,，、;；|｜/]+/g).map((item) => item.trim()).filter(Boolean)
  if (incoming.length) saveTriggerTags([...triggerTags.value, ...incoming])
  triggerDraft.value = ''
}

function commitTriggerDraft(event: KeyboardEvent) {
  if (event.isComposing) return
  if (![' ', 'Enter', ',', '，', '、'].includes(event.key)) return
  event.preventDefault()
  addTriggerTags(triggerDraft.value)
}

function removeTriggerTag(tag: string) {
  saveTriggerTags(triggerTags.value.filter((item) => item !== tag))
}

function allowsRecursive(resource: Resource) {
  return resource.retrieval?.allowRecursion ?? resource.allowRecursive ?? false
}
function allowsFurtherRecursive(resource: Resource) {
  return resource.retrieval?.allowFurtherRecursion ?? resource.allowFurtherRecursive ?? false
}
function injectionOrder(resource: Resource) {
  const configured = resource.retrieval?.injectionOrder ?? resource.injectionOrder
  return Number.isFinite(configured) ? configured : 100
}
function isLocked(resource: Resource, field: string) {
  return resource.lockedAll === true
    || (resource.lockedFields?.some((locked) => canonicalTriggerField(locked) === canonicalTriggerField(field)) ?? false)
}

function isReviewStatusLocked(resource: Resource) {
  return resource.lockedAll === true || resource.reviewStatusLocked === true
}

function lockAllTitle(resource: Resource) {
  return resource.lockedAll
    ? '解锁条目及其字段锁和校对状态锁，允许 Agent 修改'
    : '锁定条目下所有可编辑内容，禁止 Agent 修改'
}

function lockTitle(resource: Resource, field: string) {
  if (resource.lockedAll === true) return '整条目已锁定，使用名称旁总锁解锁'
  return isLocked(resource, field) ? '已锁定，点击允许 Agent 修改' : '未锁定，点击禁止 Agent 修改'
}

function resourceTriggerMeta(resource: Resource) {
  return contextResourcePages.includes(props.activePage) ? triggerStrategy(resource) : ''
}

function creationSourceLabel(resource: Resource) {
  return resource.creationSource === 'agent' ? 'Agent 创建' : '手动创建'
}

function reviewStatusLabel(resource: Resource) {
  return resource.reviewStatus === 'complete' ? '完成' : '待修改'
}

function isReviewableResourcePage() {
  return reviewableResourcePages.includes(props.activePage)
}

function startGroupDrag(event: DragEvent, groupId: string) {
  if (groupId === '__ungrouped__') return
  groupDragInProgress.value = true
  resourceDragInProgress.value = true
  emit('startResourceGroupDrag', event, groupId)
}

function endGroupDrag() {
  emit('endResourceGroupDrag')
  window.setTimeout(() => {
    groupDragInProgress.value = false
    resourceDragInProgress.value = false
  }, 0)
}

function startResourceItemDrag(event: DragEvent, resourceId: string) {
  resourceDragInProgress.value = true
  emit('startResourceDrag', event, resourceId)
}

function endResourceItemDrag() {
  emit('endResourceDrag')
  window.setTimeout(() => { resourceDragInProgress.value = false }, 0)
}

function allowInternalResourceDrop(event: DragEvent) {
  if (!resourceDragInProgress.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function ignoreInternalResourceDrop(event: DragEvent) {
  if (!resourceDragInProgress.value) return
  event.preventDefault()
}

function toggleGroup(groupId: string) {
  if (groupDragInProgress.value) return
  emit('toggleResourceGroup', groupId)
}

function toggleGroupMenu(groupId: string) {
  if (groupId === '__ungrouped__') return
  openGroupMenuId.value = openGroupMenuId.value === groupId ? null : groupId
}

function closeGroupMenu() {
  openGroupMenuId.value = null
}

function runGroupAction(action: 'rename' | 'top' | 'bottom' | 'delete', groupId: string) {
  closeGroupMenu()
  if (action === 'rename') emit('renameResourceGroup', groupId)
  else if (action === 'top') emit('moveResourceGroupToTop', groupId)
  else if (action === 'bottom') emit('moveResourceGroupToBottom', groupId)
  else emit('deleteResourceGroup', groupId)
}

const allGroupsCollapsed = computed(() => props.activeGroups.length > 0 && props.activeGroups.every((group) => group.collapsed))

const outlineNodeTypes = [
  { value: 'book', label: '全书大纲' },
  { value: 'volume', label: '卷大纲' },
  { value: 'chapterRange', label: '章节范围大纲' },
  { value: 'scene', label: '场景大纲' },
] as const

const isOutlinePage = computed(() => props.activePage === 'outline')
const outlineRoots = computed(() => props.outlineRoots ?? [])
const outlineChildMap = computed(() => props.outlineChildMap ?? {})

function descendantIds(id: string, seen = new Set<string>()): Set<string> {
  if (seen.has(id)) return seen
  seen.add(id)
  for (const child of outlineChildMap.value[id] ?? []) descendantIds(child.id, seen)
  return seen
}

function outlineParentOptions(node: Resource) {
  const excluded = descendantIds(node.id)
  return props.activeCollection.filter((candidate) => {
    if (candidate.id === node.id || excluded.has(candidate.id)) return false
    const candidateType = candidate.outlineType ?? 'chapterRange'
    const nodeType = node.outlineType ?? 'chapterRange'
    if (nodeType === 'book') return false
    if (nodeType === 'volume') return candidateType === 'book'
    if (nodeType === 'chapterRange') return candidateType === 'volume' || candidateType === 'book'
    return candidateType === 'chapterRange' || candidateType === 'volume'
  })
}

function updateOutlineMeta(key: 'outlineType' | 'outlineParentId' | 'outlineStartChapterId' | 'outlineEndChapterId' | 'outlineCollapsed', value: string | boolean) {
  emit('updateOutlineStructure', { [key]: value } as { [key: string]: string | boolean })
}
</script>

<template>
  <section class="page-view resource-view">
    <div class="page-header">
      <div><span class="eyebrow">作品资料</span><h1>{{ props.title }}</h1><p>{{ props.intro }}</p></div>
      <div class="header-actions">
        <button v-if="supportsStructureEdit" ref="structureEditorButton" class="button secondary resource-structure-mode-button" type="button" title="编辑该类别的 AI 创建结构与字段提示词" @click="openCreationStructureEditor"><Braces :size="15" />结构编辑</button>
        <template v-if="props.activeGroupPage">
          <button class="button secondary" type="button" :disabled="!props.activeGroups.length" :title="props.activeGroups.length ? (allGroupsCollapsed ? '展开全部折叠栏' : '折叠全部折叠栏') : '暂无折叠栏'" @click="emit('setAllResourceGroupsCollapsed', !allGroupsCollapsed)">
            <ChevronsUpDown v-if="allGroupsCollapsed" :size="15" />
            <ChevronsDownUp v-else :size="15" />
            {{ allGroupsCollapsed ? '展开全部' : '折叠全部' }}
          </button>
          <button class="button secondary" type="button" @click="emit('openResourceGroupDialog')"><FolderPlus :size="15" />添加折叠栏</button>
        </template>
        <button class="button primary" type="button" @click="emit('addResource')"><Plus :size="15" />{{ props.resourceCreateLabel }}</button>
      </div>
    </div>

    <div v-if="creationStructureOpen && supportsStructureEdit" class="creation-structure-backdrop" @click.self="closeCreationStructureEditor">
      <section ref="structureDialog" class="creation-structure-dialog" role="dialog" aria-modal="true" aria-labelledby="creation-structure-title" tabindex="-1" @keydown.esc.stop.prevent="closeCreationStructureEditor">
        <header class="creation-structure-header">
          <div>
            <span class="eyebrow">{{ props.title }} · AI 创建结构</span>
            <h2 id="creation-structure-title">结构编辑</h2>
            <p>这里编辑整类条目的字段强化提示词。它们只指导 AI 创建内容，不会写入已有条目。</p>
          </div>
          <button class="icon-button" type="button" title="关闭结构编辑" aria-label="关闭结构编辑" @click="closeCreationStructureEditor"><X :size="18" /></button>
        </header>
        <div class="creation-structure-body">
          <section class="creation-structure-hints" aria-label="字段强化提示词">
            <div class="creation-structure-section-head">
              <div><span class="eyebrow">共享定义</span><h3>字段强化提示词</h3></div>
              <span class="helper">留空表示不额外提示</span>
            </div>
            <label v-for="field in creationStructureFields" :key="field" class="creation-structure-field">
              <span>{{ field }}</span>
              <ExpandableTextarea
                :model-value="creationFieldHint(field)"
                :aria-label="`${field}字段强化提示词`"
                :placeholder="`说明 AI 创建${field}时应遵循的定义、范围或写法；可留空`"
                @update:model-value="emit('updateCreationPromptHint', field, $event)"
              />
            </label>
          </section>
          <section class="creation-structure-preview" aria-label="AI 创建 JSON 结构预览">
            <div class="creation-structure-section-head">
              <div><span class="eyebrow">AI 返回结构</span><h3>通用 JSON 预览</h3></div>
              <span class="helper">强化提示词作为独立指导，不属于返回数据</span>
            </div>
            <pre>{{ creationStructurePreview }}</pre>
          </section>
        </div>
        <footer class="creation-structure-footer">
          <span class="helper">修改实时生效；仅应用于 {{ props.title }} 类型。</span>
          <button class="button primary" type="button" @click="closeCreationStructureEditor">完成</button>
        </footer>
      </section>
    </div>

    <div class="resource-grid" @dragover="allowInternalResourceDrop" @drop="ignoreInternalResourceDrop">
      <div v-if="isOutlinePage" class="resource-list outline-tree-list">
        <div v-if="outlineRoots.length" class="outline-tree">
          <OutlineTreeNode
            v-for="node in outlineRoots"
            :key="node.id"
            :node="node"
            :children="outlineChildMap[node.id] ?? []"
            :child-map="outlineChildMap"
            :selected-id="props.selectedResource?.id ?? ''"
            :chapters="props.outlineChapters ?? []"
            @select="emit('selectResource', $event)"
            @toggle="emit('toggleOutlineCollapse', $event)"
          />
        </div>
        <div v-else class="resource-empty">还没有大纲节点，点击右上角新建全书大纲。</div>
      </div>
      <div v-else-if="props.activeGroupPage && props.activeGroups.length" class="resource-groups" @click="closeGroupMenu">
          <section v-for="group in props.resourceGroupSections" :key="group.id" :class="['resource-group', { 'drop-target': props.dropTargetGroupId === group.id, 'menu-open': openGroupMenuId === group.id }]" @dragover.prevent="emit('dragOverResourceGroup', group.id)" @drop.prevent="emit('dropResourceIntoGroup', group.id)">
          <div class="resource-group-head" :draggable="group.id !== '__ungrouped__'" role="button" tabindex="0" :title="group.id === '__ungrouped__' ? '未分组条目' : '拖动以调整折叠栏顺序'" @dragstart.stop="startGroupDrag($event, group.id)" @dragend.stop="endGroupDrag" @click="toggleGroup(group.id)" @keydown.enter.prevent="toggleGroup(group.id)" @keydown.space.prevent="toggleGroup(group.id)">
            <ChevronDown :size="15" :class="{ 'group-chevron-collapsed': group.collapsed }" />
            <span>{{ group.title }}</span>
            <small>{{ group.resources.length }}</small>
            <div v-if="group.id !== '__ungrouped__'" class="resource-group-menu-wrap" @click.stop @keydown.stop>
              <button class="resource-group-menu-trigger icon-button" type="button" :aria-label="`管理折叠栏 ${group.title}`" :aria-expanded="openGroupMenuId === group.id" title="折叠栏操作" @click="toggleGroupMenu(group.id)">
                <Ellipsis :size="16" />
              </button>
              <div v-if="openGroupMenuId === group.id" class="resource-group-menu" role="menu" :aria-label="`${group.title} 操作`">
                <button type="button" role="menuitem" @click="runGroupAction('rename', group.id)"><PenLine :size="14" />重命名</button>
                <button type="button" role="menuitem" @click="runGroupAction('top', group.id)"><ArrowUp :size="14" />移到最顶部</button>
                <button type="button" role="menuitem" @click="runGroupAction('bottom', group.id)"><ArrowDown :size="14" />移到最底部</button>
                <button class="danger" type="button" role="menuitem" @click="runGroupAction('delete', group.id)"><Trash2 :size="14" />删除折叠栏</button>
              </div>
            </div>
          </div>
          <div v-if="!group.collapsed" class="resource-group-items">
            <ResourceListItem
              v-for="item in group.resources"
              :key="item.id"
              :item="item"
              :selected="props.selectedResource?.id === item.id"
              :active-page="props.activePage"
              :trigger-meta="resourceTriggerMeta(item)"
              @select="emit('selectResource', $event)"
              @start-resource-drag="startResourceItemDrag"
              @end-resource-drag="endResourceItemDrag"
              @drop-resource-on-resource="emit('dropResourceOnResource', $event)"
              @toggle-resource-enabled="emit('toggleResourceEnabled', $event)"
            />
            <div v-if="!group.resources.length" class="resource-group-empty">当前折叠栏还没有卡片，新建后会归入这里。</div>
          </div>
        </section>
      </div>
      <div v-else class="resource-list">
        <ResourceListItem
          v-for="item in props.activeCollection"
          :key="item.id"
          :item="item"
          :selected="props.selectedResource?.id === item.id"
          :active-page="props.activePage"
          :trigger-meta="resourceTriggerMeta(item)"
          @select="emit('selectResource', $event)"
          @start-resource-drag="startResourceItemDrag"
          @end-resource-drag="endResourceItemDrag"
          @drop-resource-on-resource="emit('dropResourceOnResource', $event)"
          @toggle-resource-enabled="emit('toggleResourceEnabled', $event)"
        />
      </div>

      <article v-if="props.selectedResource" :class="['detail-panel', { 'character-detail-panel': props.activePage === 'characters' }]">
        <div v-if="props.activePage === 'characters'" class="character-top-grid">
          <CharacterImageManager
            class="character-image-slot"
            :images="props.selectedResource.characterImages ?? []"
            :cover-image-id="props.selectedResource.characterCoverImageId ?? ''"
            @update="emit('updateCharacterImages', $event)"
          />
          <div class="character-top-fields">
            <div class="detail-head"><div class="detail-title-copy"><div class="detail-eyebrow-line"><span class="eyebrow">{{ props.title }} · 可编辑</span><div v-if="isReviewableResourcePage()" class="entry-review-badges"><span :class="['entry-source-chip', props.selectedResource.creationSource === 'agent' ? 'agent-created' : 'manual-created']">{{ creationSourceLabel(props.selectedResource) }}</span><button :class="['entry-review-chip', props.selectedResource.reviewStatus === 'complete' ? 'review-complete' : 'review-pending']" type="button" title="点击切换校对状态" @click="emit('toggleReviewStatus')">{{ reviewStatusLabel(props.selectedResource) }}</button><button class="field-lock-button" :class="{ locked: isReviewStatusLocked(props.selectedResource) }" type="button" :title="isReviewStatusLocked(props.selectedResource) ? '校对状态已锁定；整条目锁定时请使用名称旁总锁解锁' : '锁定校对状态，禁止 Agent 切换'" @click="emit('toggleReviewStatusLock')"><LockKeyhole v-if="isReviewStatusLocked(props.selectedResource)" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></div></div><div class="detail-title-line"><h2>{{ props.selectedResource.title }}</h2><button v-if="isReviewableResourcePage()" :class="['entry-lock-all-button', { locked: props.selectedResource.lockedAll === true }]" type="button" :title="lockAllTitle(props.selectedResource)" @click="emit('toggleResourceLockAll')"><LockKeyhole v-if="props.selectedResource.lockedAll" :size="14" /><LockKeyholeOpen v-else :size="14" />{{ props.selectedResource.lockedAll ? '已锁定' : '锁定条目' }}</button></div></div><div class="detail-actions"><button class="icon-button danger" type="button" title="删除条目" @click="emit('removeResource')"><Trash2 :size="16" /></button></div></div>
            <label class="form-field"><span class="field-label-row"><span>名称</span><button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, 'title') }" :title="isLocked(props.selectedResource, 'title') ? '已锁定，Agent 不可修改' : '锁定名称，禁止 Agent 修改'" @click="emit('toggleResourceLock', 'title')"><LockKeyhole v-if="isLocked(props.selectedResource, 'title')" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></span><input :value="props.selectedResource.title" @input="emit('updateTitle', ($event.target as HTMLInputElement).value)" /></label>
            <label v-for="field in ['性别', '种族']" :key="field" class="form-field"><span class="field-label-row"><span>{{ field }}</span><button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, field) }" :title="isLocked(props.selectedResource, field) ? `已锁定，Agent 不可修改` : `锁定${field}，禁止 Agent 修改`" @click="emit('toggleResourceLock', field)"><LockKeyhole v-if="isLocked(props.selectedResource, field)" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></span><input :value="props.selectedResource.fields[field] ?? ''" @input="emit('updateCharacterField', field, ($event.target as HTMLInputElement).value)" /></label>
            <label v-if="contextResourcePages.includes(props.activePage)" class="form-field"><span class="field-label-row"><span>触发策略</span><button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, '触发策略') }" :title="isLocked(props.selectedResource, '触发策略') ? '已锁定，Agent 不可修改' : '锁定触发策略，禁止 Agent 修改'" @click="emit('toggleResourceLock', '触发策略')"><LockKeyhole v-if="isLocked(props.selectedResource, '触发策略')" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></span><select :value="triggerStrategy(props.selectedResource)" @change="emit('updateField', '触发策略', ($event.target as HTMLSelectElement).value)"><option value="关键词">关键词</option><option value="常驻">常驻</option></select><small>{{ triggerStrategyHint(props.selectedResource) }}</small></label>
          </div>
        </div>
        <div v-else class="detail-editor-column">
          <div class="detail-head"><div class="detail-title-copy"><div class="detail-eyebrow-line"><span class="eyebrow">{{ props.title }} · 可编辑</span><div v-if="isReviewableResourcePage()" class="entry-review-badges"><span :class="['entry-source-chip', props.selectedResource.creationSource === 'agent' ? 'agent-created' : 'manual-created']">{{ creationSourceLabel(props.selectedResource) }}</span><button :class="['entry-review-chip', props.selectedResource.reviewStatus === 'complete' ? 'review-complete' : 'review-pending']" type="button" title="点击切换校对状态" @click="emit('toggleReviewStatus')">{{ reviewStatusLabel(props.selectedResource) }}</button><button class="field-lock-button" :class="{ locked: isReviewStatusLocked(props.selectedResource) }" type="button" :title="isReviewStatusLocked(props.selectedResource) ? '校对状态已锁定；整条目锁定时请使用名称旁总锁解锁' : '锁定校对状态，禁止 Agent 切换'" @click="emit('toggleReviewStatusLock')"><LockKeyhole v-if="isReviewStatusLocked(props.selectedResource)" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></div></div><div class="detail-title-line"><h2>{{ props.selectedResource.title }}</h2><button v-if="isReviewableResourcePage()" :class="['entry-lock-all-button', { locked: props.selectedResource.lockedAll === true }]" type="button" :title="lockAllTitle(props.selectedResource)" @click="emit('toggleResourceLockAll')"><LockKeyhole v-if="props.selectedResource.lockedAll" :size="14" /><LockKeyholeOpen v-else :size="14" />{{ props.selectedResource.lockedAll ? '已锁定' : '锁定条目' }}</button></div></div><div class="detail-actions"><button class="icon-button danger" type="button" title="删除条目" @click="emit('removeResource')"><Trash2 :size="16" /></button></div></div>
          <label class="form-field"><span class="field-label-row"><span>名称</span><button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, 'title') }" :title="isLocked(props.selectedResource, 'title') ? '已锁定，Agent 不可修改' : '锁定名称，禁止 Agent 修改'" @click="emit('toggleResourceLock', 'title')"><LockKeyhole v-if="isLocked(props.selectedResource, 'title')" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></span><input :value="props.selectedResource.title" @input="emit('updateTitle', ($event.target as HTMLInputElement).value)" /></label>
          <label class="form-field"><span class="field-label-row"><span>摘要</span><button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, 'summary') }" :title="isLocked(props.selectedResource, 'summary') ? '已锁定，Agent 不可修改' : '锁定摘要，禁止 Agent 修改'" @click="emit('toggleResourceLock', 'summary')"><LockKeyhole v-if="isLocked(props.selectedResource, 'summary')" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></span><ExpandableTextarea :model-value="props.selectedResource.summary" aria-label="摘要" @update:model-value="emit('updateSummary', $event)" /></label>
        </div>
        <div class="character-details-flow">
        <section v-if="isOutlinePage" class="outline-structure-editor">
          <div class="resource-context-settings-head">
            <div><span class="eyebrow">大纲结构</span><h3>嵌套关系</h3></div>
            <span class="helper">全书 → 卷 → 章节范围 → 场景</span>
          </div>
          <label class="form-field">
            <span>大纲层级</span>
            <select :value="props.selectedResource.outlineType ?? 'chapterRange'" @change="updateOutlineMeta('outlineType', ($event.target as HTMLSelectElement).value)">
              <option v-for="type in outlineNodeTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
            </select>
          </label>
          <label class="form-field">
            <span>上级大纲</span>
            <select :value="props.selectedResource.outlineParentId ?? ''" @change="updateOutlineMeta('outlineParentId', ($event.target as HTMLSelectElement).value)">
              <option value="">根层级（无上级）</option>
              <option v-for="parent in outlineParentOptions(props.selectedResource)" :key="parent.id" :value="parent.id">{{ parent.title }}</option>
            </select>
            <small>系统会过滤当前节点和它的子节点，避免形成循环引用。</small>
          </label>
          <div v-if="(props.selectedResource.outlineType ?? 'chapterRange') === 'chapterRange'" class="outline-range-grid">
            <label class="form-field">
              <span>起始章节</span>
              <select :value="props.selectedResource.outlineStartChapterId ?? ''" @change="updateOutlineMeta('outlineStartChapterId', ($event.target as HTMLSelectElement).value)">
                <option value="">未指定</option>
                <option v-for="chapter in props.outlineChapters ?? []" :key="chapter.id" :value="chapter.id">{{ chapter.title }}</option>
              </select>
            </label>
            <label class="form-field">
              <span>结束章节</span>
              <select :value="props.selectedResource.outlineEndChapterId ?? ''" @change="updateOutlineMeta('outlineEndChapterId', ($event.target as HTMLSelectElement).value)">
                <option value="">未指定</option>
                <option v-for="chapter in props.outlineChapters ?? []" :key="chapter.id" :value="chapter.id">{{ chapter.title }}</option>
              </select>
            </label>
          </div>
          <label class="switch-label resource-setting-toggle"><input type="checkbox" :checked="props.selectedResource.outlineCollapsed === true" @change="updateOutlineMeta('outlineCollapsed', ($event.target as HTMLInputElement).checked)" /><span>默认折叠子大纲</span></label>
        </section>
        <template v-if="contextResourcePages.includes(props.activePage)">
          <label v-if="props.activePage !== 'characters'" class="form-field"><span class="field-label-row"><span>触发策略</span><button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, '触发策略') }" :title="isLocked(props.selectedResource, '触发策略') ? '已锁定，Agent 不可修改' : '锁定触发策略，禁止 Agent 修改'" @click="emit('toggleResourceLock', '触发策略')"><LockKeyhole v-if="isLocked(props.selectedResource, '触发策略')" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></span><select :value="triggerStrategy(props.selectedResource)" @change="emit('updateField', '触发策略', ($event.target as HTMLSelectElement).value)"><option value="关键词">关键词</option><option value="常驻">常驻</option></select><small>{{ triggerStrategyHint(props.selectedResource) }}</small></label>
          <div class="form-field"><span class="field-label-row"><span>触发键</span><button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, '触发键') }" :title="isLocked(props.selectedResource, '触发键') ? '已锁定，Agent 不可修改' : '锁定触发键，禁止 Agent 修改'" @click="emit('toggleResourceLock', '触发键')"><LockKeyhole v-if="isLocked(props.selectedResource, '触发键')" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></span><div class="trigger-tag-editor"><span v-for="tag in triggerTags" :key="tag" class="trigger-tag"><span>{{ tag }}</span><button type="button" title="删除触发键" :aria-label="`删除触发键 ${tag}`" @click="removeTriggerTag(tag)">×</button></span><input v-model="triggerDraft" type="text" placeholder="输入触发词，按空格添加" @keydown="commitTriggerDraft" @blur="addTriggerTags(triggerDraft)" /></div><small>{{ triggerStrategyHint(props.selectedResource) }}</small></div>
        </template>
        <label v-if="props.activePage === 'characters'" class="form-field"><span class="field-label-row"><span>角色身份</span><button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, '角色身份') }" :title="isLocked(props.selectedResource, '角色身份') ? '已锁定，Agent 不可修改' : '锁定角色身份，禁止 Agent 修改'" @click="emit('toggleResourceLock', '角色身份')"><LockKeyhole v-if="isLocked(props.selectedResource, '角色身份')" :size="13" /><LockKeyholeOpen v-else :size="13" /></button></span><select :value="props.selectedResource.fields['角色身份'] ?? ''" @change="emit('updateCharacterField', '角色身份', ($event.target as HTMLSelectElement).value)"><option value="">未设置</option><option v-for="role in props.roleOptions" :key="role" :value="role">{{ role }}</option></select></label>
        <div class="detail-fields">
          <template v-for="(value, key) in props.selectedResource.fields" :key="key">
            <label v-if="String(key) !== '角色身份' && String(key) !== '性别' && String(key) !== '种族' && !isContextTriggerField(String(key))" class="form-field">
              <span class="field-label-row">
                <span>{{ String(key) === '说明' ? '内容' : key }}</span>
                <button class="field-lock-button" type="button" :class="{ locked: isLocked(props.selectedResource, String(key) === '说明' ? '内容' : String(key)) }" :title="lockTitle(props.selectedResource, String(key) === '说明' ? '内容' : String(key))" @click="emit('toggleResourceLock', String(key) === '说明' ? '内容' : String(key))">
                  <LockKeyhole v-if="isLocked(props.selectedResource, String(key) === '说明' ? '内容' : String(key))" :size="13" />
                  <LockKeyholeOpen v-else :size="13" />
                </button>
              </span>
              <select v-if="props.activePage === 'skills' && String(key) === '技能性质'" :value="value === '被动' ? '被动' : '主动'" @change="emit('updateField', String(key), ($event.target as HTMLSelectElement).value)">
                <option value="被动">被动</option><option value="主动">主动</option>
              </select>
              <ExpandableTextarea
                v-else-if="isLongTextField(String(key))"
                :model-value="value"
                :placeholder="props.activePage === 'style' && ['反例', '正例'].includes(String(key)) ? '可留空' : undefined"
                :aria-label="String(key)"
                @update:model-value="emit('updateField', String(key) === '说明' ? '内容' : String(key), $event)"
              />
              <input v-else :type="fieldType(String(key))" :value="value" @input="emit('updateField', String(key), ($event.target as HTMLInputElement).value)" />
              
              <small v-if="String(key).includes('密钥') || String(key).includes('Key')"><LockKeyhole :size="12" />配置保存于本机应用数据</small>
            </label>
          </template>
        </div>
        
        <section v-if="contextResourcePages.includes(props.activePage)" class="resource-context-settings">
          <div class="resource-context-settings-head"><div><span class="eyebrow">上下文注入</span><h3>递归与排序</h3></div><span class="helper">用于正文生成与 AI Agent 智能检索</span></div>
          <label class="switch-label resource-setting-toggle"><input type="checkbox" :checked="allowsRecursive(props.selectedResource)" @change="emit('updateResourceMeta', 'allowRecursive', ($event.target as HTMLInputElement).checked)" /><span>允许递归</span></label>
          <label class="switch-label resource-setting-toggle"><input type="checkbox" :checked="allowsFurtherRecursive(props.selectedResource)" @change="emit('updateResourceMeta', 'allowFurtherRecursive', ($event.target as HTMLInputElement).checked)" /><span>允许进一步递归</span></label>
          <label class="form-field resource-injection-order"><span>注入排序</span><input type="number" min="0" step="1" :value="injectionOrder(props.selectedResource)" @input="emit('updateResourceMeta', 'injectionOrder', Math.max(0, Number(($event.target as HTMLInputElement).value) || 0))" /><small>数值越小越早注入，命中多个条目时按此顺序排列。</small></label>
        </section>
        <slot />
        <div class="source-note"><FileText :size="15" /><span>修订自动保存 · 本章生成时会固定当前资料版本</span></div>
        </div>
      </article>
    </div>
  </section>
</template>
