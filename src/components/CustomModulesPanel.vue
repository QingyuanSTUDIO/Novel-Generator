<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ChevronDown, Clipboard, Database, GripVertical, LockKeyhole, LockKeyholeOpen, Plus, Trash2, X } from 'lucide-vue-next'
import ExpandableTextarea from './ExpandableTextarea.vue'

/** Field types understood by the experimental custom-module editor. */
export type CustomModuleFieldType =
  | 'string'
  | 'text'
  | 'longText'
  | 'number'
  | 'enum'
  | 'boolean'
  | 'tags'
  | 'characterIndex'
  | 'itemIndex'
  | 'skillIndex'

export type CustomModuleReferenceCollection = 'characters' | 'items' | 'skills'

export type CustomModuleReferenceOption = {
  id: string
  title: string
}

export type CustomModuleField = {
  id: string
  key: string
  label: string
  type: CustomModuleFieldType
  description?: string
  promptHint?: string
  placeholder?: string
  defaultValue?: unknown
  options?: string[]
  locked?: boolean
}

export type CustomModuleEntry = {
  id: string
  title: string
  data: Record<string, unknown>
  lockedAll?: boolean
  lockedFields?: string[]
}

export type CustomModuleDefinition = {
  id: string
  name: string
  description?: string
  titleField?: string
  fields: CustomModuleField[]
  entries: CustomModuleEntry[]
  lockedAll?: boolean
}

const props = withDefaults(defineProps<{
  modules?: readonly CustomModuleDefinition[]
  selectedModuleId?: string
  /** Disables editing while a parent save operation is in progress. */
  busy?: boolean
  /** Existing cards available to index fields. Values are stored by stable id. */
  characters?: readonly CustomModuleReferenceOption[]
  items?: readonly CustomModuleReferenceOption[]
  skills?: readonly CustomModuleReferenceOption[]
}>(), {
  modules: () => [],
  selectedModuleId: '',
  busy: false,
  characters: () => [],
  items: () => [],
  skills: () => [],
})

const emit = defineEmits<{
  (event: 'select-module', moduleId: string): void
  (event: 'create-module', payload: { name: string; description: string; fields: CustomModuleField[] }): void
  (event: 'rename-module', moduleId: string, name: string): void
  (event: 'update-module', module: CustomModuleDefinition): void
  (event: 'delete-module', moduleId: string): void
  (event: 'create-entry', moduleId: string, entry: CustomModuleEntry): void
  (event: 'update-entry', moduleId: string, entry: CustomModuleEntry): void
  (event: 'delete-entry', moduleId: string, entryId: string): void
  (event: 'open-reference', collection: CustomModuleReferenceCollection, id: string): void
}>()

const localSelectedId = ref(props.selectedModuleId || props.modules[0]?.id || '')
const showCreateForm = ref(false)
const moduleDraftName = ref('')
const moduleDraftDescription = ref('')
const editingModuleName = ref(false)
const moduleNameDraft = ref('')
const expandedFieldIds = ref<string[]>([])
const expandedEntryIds = ref<string[]>([])
const tagDrafts = ref<Record<string, string>>({})
const entryDrafts = ref<Record<string, string>>({})
const entryTitleDrafts = ref<Record<string, string>>({})
const jsonCopied = ref(false)

watch(() => props.selectedModuleId, (value) => {
  if (value) localSelectedId.value = value
})

watch(() => props.modules, (modules) => {
  if (modules.length === 0) {
    localSelectedId.value = ''
    return
  }
  if (!modules.some((module) => module.id === localSelectedId.value)) localSelectedId.value = modules[0].id
}, { deep: false })

const selectedModule = computed(() => props.modules.find((module) => module.id === localSelectedId.value) ?? null)
const selectedModuleIndex = computed(() => props.modules.findIndex((module) => module.id === localSelectedId.value))
const selectedEntryCount = computed(() => selectedModule.value?.entries?.length ?? 0)
const jsonPreview = computed(() => {
  const module = selectedModule.value
  if (!module) return ''
  const entry = module.entries[0]
  const data = entry
    ? entry.data
    : Object.fromEntries(module.fields.map((field) => [field.key, defaultForField(field)]))
  return JSON.stringify({ type: module.name, id: entry?.id ?? 'example-entry', data }, null, 2)
})

function selectModule(moduleId: string) {
  localSelectedId.value = moduleId
  emit('select-module', moduleId)
}

function cloneModule(module: CustomModuleDefinition): CustomModuleDefinition {
  return JSON.parse(JSON.stringify(module)) as CustomModuleDefinition
}

function publishModule(module: CustomModuleDefinition) {
  if (props.busy) return
  emit('update-module', module)
}

function startCreateModule() {
  moduleDraftName.value = ''
  moduleDraftDescription.value = ''
  showCreateForm.value = true
}

function cancelCreateModule() {
  showCreateForm.value = false
}

function createModule() {
  const name = moduleDraftName.value.trim()
  if (!name || props.busy) return
  emit('create-module', { name, description: moduleDraftDescription.value.trim(), fields: [] })
  showCreateForm.value = false
}

function startRenameModule() {
  if (!selectedModule.value) return
  moduleNameDraft.value = selectedModule.value.name
  editingModuleName.value = true
}

function saveModuleName() {
  const module = selectedModule.value
  const name = moduleNameDraft.value.trim()
  if (!module || !name || props.busy) return
  editingModuleName.value = false
  emit('rename-module', module.id, name)
}

function updateModuleDescription(event: Event) {
  const module = selectedModule.value
  if (!module) return
  const description = (event.target as HTMLInputElement).value
  publishModule({ ...cloneModule(module), description })
}

function updateModuleLock(locked: boolean) {
  const module = selectedModule.value
  if (!module) return
  publishModule({ ...cloneModule(module), lockedAll: locked })
}

function toggleModuleLock() {
  const module = selectedModule.value
  if (!module) return
  updateModuleLock(module.lockedAll !== true)
}

function makeFieldId() {
  return `field-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function addField() {
  const module = selectedModule.value
  if (!module) return
  const index = module.fields.length + 1
  const field: CustomModuleField = { id: makeFieldId(), key: `字段_${index}`, label: `新字段 ${index}`, type: 'string', description: '', defaultValue: '' }
  const next = cloneModule(module)
  next.fields.push(field)
  publishModule(next)
  expandedFieldIds.value = [...expandedFieldIds.value, field.id]
}

function removeField(fieldId: string) {
  const module = selectedModule.value
  if (!module) return
  const next = cloneModule(module)
  next.fields = next.fields.filter((field) => field.id !== fieldId)
  publishModule(next)
}

function updateField(fieldId: string, patch: Partial<CustomModuleField>) {
  const module = selectedModule.value
  if (!module) return
  const next = cloneModule(module)
  const field = next.fields.find((item) => item.id === fieldId)
  if (!field) return
  Object.assign(field, patch)
  if (field.type === 'enum' && !field.options?.length) field.options = ['选项 1']
  if (field.type !== 'enum') delete field.options
  if (patch.type && isArrayField(field)) field.defaultValue = []
  if (patch.type && !isArrayField(field) && Array.isArray(field.defaultValue)) field.defaultValue = ''
  publishModule(next)
}

function toggleFieldLock(fieldId: string) {
  const module = selectedModule.value
  const field = module?.fields.find((item) => item.id === fieldId)
  if (!field) return
  updateField(fieldId, { locked: field.locked !== true })
}

function updateFieldFromInput(fieldId: string, key: keyof CustomModuleField, event: Event) {
  updateField(fieldId, { [key]: (event.target as HTMLInputElement).value })
}

function updateFieldText(fieldId: string, key: keyof CustomModuleField, value: string) {
  updateField(fieldId, { [key]: value })
}

function toggleField(fieldId: string) {
  expandedFieldIds.value = expandedFieldIds.value.includes(fieldId)
    ? expandedFieldIds.value.filter((id) => id !== fieldId)
    : [...expandedFieldIds.value, fieldId]
}

function addEnumOption(fieldId: string) {
  const module = selectedModule.value
  const field = module?.fields.find((item) => item.id === fieldId)
  if (!field) return
  updateField(fieldId, { options: [...(field.options ?? []), `选项 ${(field.options?.length ?? 0) + 1}`] })
}

function updateEnumOption(fieldId: string, optionIndex: number, event: Event) {
  const module = selectedModule.value
  const field = module?.fields.find((item) => item.id === fieldId)
  if (!field) return
  const options = [...(field.options ?? [])]
  options[optionIndex] = (event.target as HTMLInputElement).value
  updateField(fieldId, { options })
}

function removeEnumOption(fieldId: string, optionIndex: number) {
  const module = selectedModule.value
  const field = module?.fields.find((item) => item.id === fieldId)
  if (!field) return
  updateField(fieldId, { options: (field.options ?? []).filter((_, index) => index !== optionIndex) })
}

function makeEntryId() {
  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function defaultForField(field: CustomModuleField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue
  if (field.type === 'number') return 0
  if (field.type === 'boolean') return false
  if (isArrayField(field)) return []
  if (field.type === 'enum') return field.options?.[0] ?? ''
  return ''
}

function createEntry() {
  const module = selectedModule.value
  if (!module || props.busy) return
  const data: Record<string, unknown> = {}
  module.fields.forEach((field) => { data[field.key] = defaultForField(field) })
  const entry: CustomModuleEntry = { id: makeEntryId(), title: `未命名${module.name}`, data }
  emit('create-entry', module.id, entry)
  expandedEntryIds.value = [...expandedEntryIds.value, entry.id]
}

function updateEntry(entry: CustomModuleEntry, patch: Partial<CustomModuleEntry>) {
  const module = selectedModule.value
  if (!module) return
  emit('update-entry', module.id, { ...entry, ...patch, data: { ...entry.data, ...(patch.data ?? {}) } })
}

function updateEntryTitle(entry: CustomModuleEntry, event: Event) {
  entryTitleDrafts.value[entry.id] = (event.target as HTMLInputElement).value
}

function entryTitleValue(entry: CustomModuleEntry) {
  return Object.prototype.hasOwnProperty.call(entryTitleDrafts.value, entry.id)
    ? entryTitleDrafts.value[entry.id]
    : entry.title
}

function commitEntryTitle(entry: CustomModuleEntry) {
  if (!Object.prototype.hasOwnProperty.call(entryTitleDrafts.value, entry.id)) return
  const title = entryTitleDrafts.value[entry.id]
  delete entryTitleDrafts.value[entry.id]
  const module = selectedModule.value
  const data = module?.titleField
    ? { ...entry.data, [module.titleField]: title }
    : undefined
  updateEntry(entry, { title, ...(data ? { data } : {}) })
}

function updateEntryValue(entry: CustomModuleEntry, field: CustomModuleField, value: unknown) {
  const module = selectedModule.value
  const data = { ...entry.data, [field.key]: value }
  const title = module?.titleField === field.key && typeof value === 'string' ? value : undefined
  updateEntry(entry, { data, ...(title !== undefined ? { title } : {}) })
}

function entryDraftKey(entry: CustomModuleEntry, field: CustomModuleField) {
  return `${entry.id}:${field.id}`
}

function entryFieldValue(entry: CustomModuleEntry, field: CustomModuleField) {
  const key = entryDraftKey(entry, field)
  return Object.prototype.hasOwnProperty.call(entryDrafts.value, key)
    ? entryDrafts.value[key]
    : fieldValueAsText(entry, field)
}

function updateEntryDraft(entry: CustomModuleEntry, field: CustomModuleField, value: string) {
  entryDrafts.value[entryDraftKey(entry, field)] = value
}

function updateEntryDraftFromInput(entry: CustomModuleEntry, field: CustomModuleField, event: Event) {
  updateEntryDraft(entry, field, (event.target as HTMLInputElement | HTMLTextAreaElement).value)
}

function commitEntryDraft(entry: CustomModuleEntry, field: CustomModuleField) {
  const key = entryDraftKey(entry, field)
  if (!Object.prototype.hasOwnProperty.call(entryDrafts.value, key)) return
  const raw = entryDrafts.value[key]
  delete entryDrafts.value[key]
  if (field.type === 'number') updateEntryValue(entry, field, raw === '' ? '' : Number(raw))
  else updateEntryValue(entry, field, raw)
}

function updateEntryText(entry: CustomModuleEntry, field: CustomModuleField, value: string) {
  updateEntryDraft(entry, field, value)
}

function isReferenceField(field: CustomModuleField) {
  return field.type === 'characterIndex' || field.type === 'itemIndex' || field.type === 'skillIndex'
}

function isArrayField(field: CustomModuleField) {
  return field.type === 'tags' || isReferenceField(field)
}

function referenceCollection(field: CustomModuleField): CustomModuleReferenceCollection | null {
  if (field.type === 'characterIndex') return 'characters'
  if (field.type === 'itemIndex') return 'items'
  if (field.type === 'skillIndex') return 'skills'
  return null
}

function referenceOptions(field: CustomModuleField): readonly CustomModuleReferenceOption[] {
  const collection = referenceCollection(field)
  if (collection === 'characters') return props.characters
  if (collection === 'items') return props.items
  if (collection === 'skills') return props.skills
  return []
}

function referenceTitle(field: CustomModuleField, id: string) {
  return referenceOptions(field).find((option) => option.id === id)?.title ?? `${id}（已删除）`
}

function entryFieldKey(entry: CustomModuleEntry, field: CustomModuleField) {
  return `${entry.id}:${field.id}`
}

function arrayValue(entry: CustomModuleEntry, field: CustomModuleField): string[] {
  const value = entry.data?.[field.key]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') return value.split(/[,，、\s\n]+/u).map((item) => item.trim()).filter(Boolean)
  return []
}

function addArrayValues(entry: CustomModuleEntry, field: CustomModuleField, raw: string) {
  const values = raw.split(/[,，、\s\n]+/u).map((item) => item.trim()).filter(Boolean)
  if (!values.length) return
  const next = [...new Set([...arrayValue(entry, field), ...values])]
  updateEntryValue(entry, field, next)
}

function commitTagDraft(entry: CustomModuleEntry, field: CustomModuleField) {
  const key = entryFieldKey(entry, field)
  addArrayValues(entry, field, tagDrafts.value[key] ?? '')
  tagDrafts.value[key] = ''
}

function updateTagDraft(entry: CustomModuleEntry, field: CustomModuleField, event: Event) {
  tagDrafts.value[entryFieldKey(entry, field)] = (event.target as HTMLInputElement).value
}

function handleTagKeydown(entry: CustomModuleEntry, field: CustomModuleField, event: KeyboardEvent) {
  if (['Enter', ',', '，', '、', ' '].includes(event.key)) {
    event.preventDefault()
    commitTagDraft(entry, field)
  }
}

function removeArrayValue(entry: CustomModuleEntry, field: CustomModuleField, value: string) {
  updateEntryValue(entry, field, arrayValue(entry, field).filter((item) => item !== value))
}

function addReferenceValue(entry: CustomModuleEntry, field: CustomModuleField, event: Event) {
  const id = (event.target as HTMLSelectElement).value
  if (!id) return
  addArrayValues(entry, field, id)
  ;(event.target as HTMLSelectElement).value = ''
}

function openReference(field: CustomModuleField, id: string) {
  const collection = referenceCollection(field)
  if (collection) emit('open-reference', collection, id)
}

function toggleEntryField(entry: CustomModuleEntry, field: CustomModuleField, event: Event) {
  updateEntryValue(entry, field, (event.target as HTMLInputElement).checked)
}

function toggleEntry(entryId: string) {
  expandedEntryIds.value = expandedEntryIds.value.includes(entryId)
    ? expandedEntryIds.value.filter((id) => id !== entryId)
    : [...expandedEntryIds.value, entryId]
}

function toggleEntryLock(entry: CustomModuleEntry, locked: boolean) {
  updateEntry(entry, { lockedAll: locked })
}

function toggleEntryLockState(entry: CustomModuleEntry) {
  toggleEntryLock(entry, entry.lockedAll !== true)
}

function isEntryFieldLocked(entry: CustomModuleEntry, field: CustomModuleField) {
  return entry.lockedAll === true || (entry.lockedFields ?? []).some((value) => value === field.key || value === field.id || value === field.label)
}

function toggleEntryFieldLock(entry: CustomModuleEntry, field: CustomModuleField) {
  if (entry.lockedAll === true) return
  const current = new Set(entry.lockedFields ?? [])
  const locked = isEntryFieldLocked(entry, field)
  for (const key of [field.key, field.id, field.label]) current.delete(key)
  if (!locked) current.add(field.key)
  updateEntry(entry, { lockedFields: [...current] })
}

function displayEntryValue(entry: CustomModuleEntry, field: CustomModuleField) {
  const value = entry.data?.[field.key]
  if (field.type === 'boolean') return value ? '是' : '否'
  if (isArrayField(field) && Array.isArray(value)) {
    const values = value.map((item) => isReferenceField(field) ? referenceTitle(field, String(item)) : String(item))
    return values.join('、') || '未填写'
  }
  return value === undefined || value === '' ? '未填写' : String(value)
}

function fieldTypeLabel(type: CustomModuleFieldType) {
  return ({
    string: '文字',
    text: '长文本',
    longText: '动态长文本',
    number: '数字',
    enum: '枚举',
    boolean: '布尔',
    tags: '标签',
    characterIndex: '人物索引',
    itemIndex: '道具索引',
    skillIndex: '技能索引',
  } as Record<CustomModuleFieldType, string>)[type]
}

function fieldValueAsText(entry: CustomModuleEntry, field: CustomModuleField) {
  const value = entry.data?.[field.key]
  if (isArrayField(field)) return Array.isArray(value) ? value.join('、') : String(value ?? '')
  return value === undefined || value === null ? '' : String(value)
}

async function copyJsonPreview() {
  if (!jsonPreview.value) return
  try {
    await navigator.clipboard.writeText(jsonPreview.value)
    jsonCopied.value = true
    window.setTimeout(() => { jsonCopied.value = false }, 1600)
  } catch {
    jsonCopied.value = false
  }
}
</script>

<template>
  <section class="page-view custom-modules-page" aria-labelledby="custom-modules-title">
    <div class="page-header custom-modules-header">
      <div>
        <span class="eyebrow">实验性功能</span>
        <h1 id="custom-modules-title">自定义模块</h1>
        <p>用字段定义一份可复用的 JSON 结构，界面和 Agent 都按同一份结构读写。</p>
      </div>
      <div class="header-stat"><Database :size="18" /><span>{{ modules.length }} 个模块</span></div>
    </div>

    <div class="custom-modules-grid">
      <aside class="custom-module-sidebar" aria-label="自定义模块列表">
        <div class="custom-module-sidebar-head">
          <div><span class="eyebrow">模块</span><strong>数据结构</strong></div>
        </div>

        <form v-if="showCreateForm" class="custom-module-create-form" @submit.prevent="createModule">
          <label>栏目名称<input v-model="moduleDraftName" autofocus placeholder="例如：势力卡" /></label>
          <label>说明<input v-model="moduleDraftDescription" placeholder="这个栏目记录什么" /></label>
          <div class="custom-module-form-actions"><button class="button secondary" type="button" @click="cancelCreateModule"><X :size="14" />取消</button><button class="button primary" type="submit" :disabled="!moduleDraftName.trim()"><Check :size="14" />创建</button></div>
        </form>

        <div v-if="modules.length" class="custom-module-list">
          <button v-for="module in modules" :key="module.id" class="custom-module-list-item" :class="{ selected: module.id === selectedModule?.id }" type="button" @click="selectModule(module.id)">
            <span class="custom-module-list-icon"><Database :size="14" /></span>
            <span class="custom-module-list-copy"><strong>{{ module.name }}</strong><small>{{ module.fields.length }} 个字段 · {{ module.entries.length }} 条数据</small></span>
            <ChevronDown :size="14" class="custom-module-list-arrow" />
          </button>
        </div>
        <div v-else-if="!showCreateForm" class="custom-module-empty"><Database :size="17" /><span>还没有自定义栏目。请使用主区域的“创建栏目”按钮开始。</span></div>
      </aside>

      <main v-if="selectedModule" class="custom-module-editor">
        <header class="custom-module-editor-head">
          <div class="custom-module-editor-title">
            <span class="eyebrow">结构定义 · {{ selectedModuleIndex + 1 }}</span>
            <div class="custom-module-title-row">
              <div v-if="editingModuleName" class="custom-module-title-edit"><input v-model="moduleNameDraft" aria-label="栏目名称" @keyup.enter="saveModuleName" /><button class="icon-button" type="button" title="保存栏目名称" aria-label="保存栏目名称" @click="saveModuleName"><Check :size="14" /></button></div>
              <h2 v-else>{{ selectedModule.name }}</h2>
              <button
                class="custom-lock-toggle custom-lock-button"
                :class="{ locked: selectedModule.lockedAll === true }"
                type="button"
                :title="selectedModule.lockedAll ? '解锁模块，允许 Agent 修改' : '锁定模块，禁止 Agent 修改'"
                :aria-label="selectedModule.lockedAll ? '解锁模块' : '锁定模块'"
                :aria-pressed="selectedModule.lockedAll === true"
                :disabled="busy"
                @click="toggleModuleLock"
              >
                <LockKeyhole v-if="selectedModule.lockedAll" :size="14" />
                <LockKeyholeOpen v-else :size="14" />
                <span>{{ selectedModule.lockedAll ? '已锁定' : '可修改' }}</span>
              </button>
            </div>
            <p v-if="!editingModuleName">{{ selectedModule.description || '为这个栏目补充用途说明，方便 AI 理解数据结构。' }}</p>
            <input v-if="!editingModuleName" class="custom-module-description-input" :value="selectedModule.description" placeholder="栏目说明" @change="updateModuleDescription" />
          </div>
          <div class="custom-module-editor-actions">
            <button class="button secondary" type="button" :disabled="busy" @click="startRenameModule">重命名</button>
            <button class="icon-button danger" type="button" title="删除栏目" aria-label="删除栏目" :disabled="busy" @click="emit('delete-module', selectedModule.id)"><Trash2 :size="15" /></button>
          </div>
        </header>

        <section class="custom-module-section">
          <div class="custom-module-section-head"><div><span class="eyebrow">JSON schema</span><h3>字段定义</h3><p>字段名称会作为 JSON 的 key；说明和类型会一起提供给 Agent。</p></div><button class="button secondary" type="button" :disabled="busy" @click="addField"><Plus :size="14" />添加字段</button></div>
          <div v-if="selectedModule.fields.length" class="custom-field-list">
            <article v-for="(field, index) in selectedModule.fields" :key="field.id" class="custom-field-card" :class="{ expanded: expandedFieldIds.includes(field.id) }">
              <button class="custom-field-summary" type="button" @click="toggleField(field.id)"><GripVertical :size="14" class="custom-field-grip" /><span class="custom-field-index">{{ index + 1 }}</span><span class="custom-field-summary-copy"><strong>{{ field.label || field.key }}</strong><small>{{ field.key }} · {{ fieldTypeLabel(field.type) }}</small></span><ChevronDown :size="15" class="custom-field-chevron" /></button>
              <div v-if="expandedFieldIds.includes(field.id)" class="custom-field-form">
                <div class="custom-field-form-grid">
                  <label>显示名称<input :value="field.label" placeholder="例如：势力名称" @input="updateFieldFromInput(field.id, 'label', $event)" /></label>
                  <label>JSON 键名<input :value="field.key" placeholder="例如：名称" @input="updateFieldFromInput(field.id, 'key', $event)" /></label>
                  <label>字段类型<select :value="field.type" @change="updateField(field.id, { type: ($event.target as HTMLSelectElement).value as CustomModuleFieldType })"><option value="string">文字</option><option value="text">长文本</option><option value="longText">动态长文本</option><option value="number">数字</option><option value="enum">枚举</option><option value="boolean">布尔</option><option value="tags">标签</option><option value="characterIndex">人物索引</option><option value="itemIndex">道具索引</option><option value="skillIndex">技能索引</option></select></label>
                  <label>默认值<input :value="field.defaultValue === undefined ? '' : String(field.defaultValue)" placeholder="可留白" @input="updateFieldFromInput(field.id, 'defaultValue', $event)" /></label>
                </div>
                <label>字段说明<input :value="field.description" placeholder="例如：这里填写势力规模" @input="updateFieldFromInput(field.id, 'description', $event)" /></label>
                <label>输入提示<input :value="field.placeholder" placeholder="例如：填写势力名称，可留白" @input="updateFieldFromInput(field.id, 'placeholder', $event)" /></label>
                <label>强化提示词<ExpandableTextarea :model-value="field.promptHint ?? ''" aria-label="字段强化提示词" placeholder="告诉 AI 这个字段应该填写什么、遵循什么边界；可留白" @update:model-value="updateFieldText(field.id, 'promptHint', $event)" /></label>
                <button
                  class="custom-lock-toggle custom-lock-button custom-field-lock"
                  :class="{ locked: field.locked === true }"
                  type="button"
                  :title="field.locked ? '解锁字段，允许 Agent 修改' : '锁定字段，禁止 Agent 修改'"
                  :aria-label="field.locked ? '解锁字段' : '锁定字段'"
                  :aria-pressed="field.locked === true"
                  :disabled="busy"
                  @click="toggleFieldLock(field.id)"
                >
                  <LockKeyhole v-if="field.locked" :size="14" />
                  <LockKeyholeOpen v-else :size="14" />
                  <span>{{ field.locked ? 'Agent 不可修改此字段' : '允许 Agent 修改此字段' }}</span>
                </button>
                <div v-if="field.type === 'enum'" class="custom-enum-options">
                  <div class="custom-enum-options-head"><span>枚举选项</span><button class="icon-button" type="button" title="添加枚举选项" aria-label="添加枚举选项" @click="addEnumOption(field.id)"><Plus :size="14" /></button></div>
                  <div v-for="(option, optionIndex) in (field.options ?? [])" :key="`${field.id}-${optionIndex}`" class="custom-enum-option"><input :value="option" :aria-label="`枚举选项 ${optionIndex + 1}`" @input="updateEnumOption(field.id, optionIndex, $event)" /><button class="icon-button" type="button" title="删除枚举选项" :aria-label="`删除枚举选项 ${optionIndex + 1}`" @click="removeEnumOption(field.id, optionIndex)"><X :size="13" /></button></div>
                </div>
                <div class="custom-field-form-actions"><button class="button danger subtle" type="button" @click="removeField(field.id)"><Trash2 :size="13" />删除字段</button></div>
              </div>
            </article>
          </div>
          <div v-else class="custom-module-empty custom-module-empty-inline"><Database :size="17" /><span>还没有字段。先添加一个字段，生成器就能按结构创建数据。</span></div>
        </section>

        <section class="custom-module-section custom-module-data-section">
          <div class="custom-module-section-head"><div><span class="eyebrow">data</span><h3>条目数据 <small>{{ selectedEntryCount }}</small></h3><p>这些数据会放在同一模块的 entries 数组中，能够直接导出给 AI。</p></div><button class="button primary" type="button" :disabled="busy" @click="createEntry"><Plus :size="14" />新建条目</button></div>
          <div v-if="selectedModule.entries.length" class="custom-entry-list">
            <article v-for="entry in selectedModule.entries" :key="entry.id" class="custom-entry-card" :class="{ expanded: expandedEntryIds.includes(entry.id) }">
              <div class="custom-entry-head"><button class="custom-entry-collapse" type="button" :aria-expanded="expandedEntryIds.includes(entry.id)" :title="expandedEntryIds.includes(entry.id) ? '收起条目' : '展开条目'" @click="toggleEntry(entry.id)"><ChevronDown :size="15" /></button><input class="custom-entry-title" :value="entryTitleValue(entry)" aria-label="条目名称" @input="updateEntryTitle(entry, $event)" @blur="commitEntryTitle(entry)" @keydown.enter.prevent="commitEntryTitle(entry)" /><span class="custom-entry-json-preview">{{ selectedModule.fields.slice(0, 2).map((field) => `${field.key}: ${displayEntryValue(entry, field)}`).join(' · ') }}</span><button class="custom-lock-toggle custom-lock-button custom-lock-icon" :class="{ locked: entry.lockedAll === true }" type="button" :title="entry.lockedAll ? '解锁条目，允许 Agent 修改' : '锁定条目，禁止 Agent 修改'" :aria-label="entry.lockedAll ? '解锁条目' : '锁定条目'" :aria-pressed="entry.lockedAll === true" :disabled="busy" @click="toggleEntryLockState(entry)"><LockKeyhole v-if="entry.lockedAll" :size="14" /><LockKeyholeOpen v-else :size="14" /></button><button class="icon-button danger" type="button" title="删除条目" :aria-label="`删除${entry.title || '条目'}`" :disabled="busy" @click="emit('delete-entry', selectedModule.id, entry.id)"><Trash2 :size="14" /></button></div>
              <div v-if="expandedEntryIds.includes(entry.id)" class="custom-entry-form">
                 <div v-for="field in selectedModule.fields" :key="`${entry.id}-${field.id}`" class="custom-entry-field">
                    <div class="custom-entry-field-label"><span class="custom-entry-field-copy"><span class="custom-entry-field-heading"><strong>{{ field.label || field.key }}</strong></span><small v-if="field.description" class="custom-entry-field-description">{{ field.description }}</small></span>
                      <button class="custom-lock-toggle custom-lock-button custom-lock-icon custom-entry-field-lock" :class="{ locked: isEntryFieldLocked(entry, field) }" type="button" :title="entry.lockedAll ? '条目已整体锁定，请先解锁条目' : (isEntryFieldLocked(entry, field) ? '解锁字段，允许 Agent 修改' : '锁定字段，禁止 Agent 修改')" :aria-label="entry.lockedAll ? '条目已整体锁定' : (isEntryFieldLocked(entry, field) ? '解锁字段' : '锁定字段')" :aria-pressed="isEntryFieldLocked(entry, field)" :disabled="busy || entry.lockedAll === true" @click="toggleEntryFieldLock(entry, field)"><LockKeyhole v-if="isEntryFieldLocked(entry, field)" :size="13" /><LockKeyholeOpen v-else :size="13" /></button>
                    </div>
                     <input v-if="field.type === 'string'" :value="entryFieldValue(entry, field)" :aria-label="field.label || field.key" :placeholder="field.placeholder" @input="updateEntryDraftFromInput(entry, field, $event)" @blur="commitEntryDraft(entry, field)" />
                     <textarea v-else-if="field.type === 'text'" :value="entryFieldValue(entry, field)" rows="3" :placeholder="field.placeholder" @input="updateEntryDraftFromInput(entry, field, $event)" @blur="commitEntryDraft(entry, field)" />
                    <ExpandableTextarea v-else-if="field.type === 'longText'" :model-value="entryFieldValue(entry, field)" :aria-label="field.label || field.key" :placeholder="field.placeholder || '输入较长内容，可自动展开或拖动右下角调整高度'" @update:model-value="updateEntryText(entry, field, $event)" @blur="commitEntryDraft(entry, field)" />
                    <div v-else-if="isArrayField(field)" class="trigger-tag-editor custom-reference-editor">
                      <span v-for="value in arrayValue(entry, field)" :key="`${entry.id}-${field.id}-${value}`" class="trigger-tag" :class="{ 'custom-reference-tag': isReferenceField(field) }">
                        <button v-if="isReferenceField(field)" type="button" class="custom-reference-link" :title="`打开${referenceTitle(field, value)}`" @click="openReference(field, value)">{{ referenceTitle(field, value) }}</button>
                        <span v-else>{{ value }}</span>
                        <button type="button" class="custom-reference-remove" title="删除" aria-label="删除标签" @click="removeArrayValue(entry, field, value)"><X :size="12" /></button>
                      </span>
                      <input
                        v-if="field.type === 'tags'"
                        :value="tagDrafts[entryFieldKey(entry, field)] ?? ''"
                        placeholder="输入后按空格、回车或逗号添加"
                        @input="updateTagDraft(entry, field, $event)"
                        @keydown="handleTagKeydown(entry, field, $event)"
                        @blur="commitTagDraft(entry, field)"
                      />
                      <select v-else class="custom-reference-select" :aria-label="`添加${fieldTypeLabel(field.type)}`" @change="addReferenceValue(entry, field, $event)">
                        <option value="">＋ 添加关联</option>
                        <option v-for="option in referenceOptions(field)" :key="option.id" :value="option.id" :disabled="arrayValue(entry, field).includes(option.id)">{{ option.title }}</option>
                      </select>
                    </div>
                    <input v-else-if="field.type === 'number'" type="number" :value="entryFieldValue(entry, field)" :placeholder="field.placeholder" @input="updateEntryDraftFromInput(entry, field, $event)" @blur="commitEntryDraft(entry, field)" />
                     <select v-else-if="field.type === 'enum'" :value="entryFieldValue(entry, field)" @change="updateEntryValue(entry, field, ($event.target as HTMLSelectElement).value)"><option value="">请选择</option><option v-for="option in (field.options ?? [])" :key="option" :value="option">{{ option }}</option></select>
                     <input v-else-if="field.type === 'boolean'" type="checkbox" :checked="Boolean(entry.data?.[field.key])" @change="toggleEntryField(entry, field, $event)" />
                     <input v-else :value="entryFieldValue(entry, field)" :aria-label="field.label || field.key" :placeholder="field.placeholder" @input="updateEntryDraftFromInput(entry, field, $event)" @blur="commitEntryDraft(entry, field)" />
                </div>
                <div v-if="!selectedModule.fields.length" class="custom-entry-no-fields">请先在上方添加字段。</div>
              </div>
            </article>
          </div>
          <div v-else class="custom-module-empty custom-module-empty-inline"><Database :size="17" /><span>还没有条目。点击“新建条目”，按当前字段生成一条数据。</span></div>
        </section>

        <details class="custom-json-preview" open>
          <summary><span><span class="eyebrow">AI JSON</span><strong>结构预览</strong></span><button class="button secondary" type="button" @click.prevent="copyJsonPreview"><Check v-if="jsonCopied" :size="13" /><Clipboard v-else :size="13" />{{ jsonCopied ? '已复制' : '复制 JSON' }}</button></summary>
          <pre>{{ jsonPreview }}</pre>
        </details>
      </main>
      <div v-else class="custom-module-empty custom-module-detail-empty"><Database :size="24" /><strong>创建一个自定义栏目</strong><span>先定义字段，再把它们组合成你自己的数据表。</span><button class="button primary" type="button" @click="startCreateModule"><Plus :size="14" />创建栏目</button></div>
    </div>
  </section>
</template>
