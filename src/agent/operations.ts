import type { ComputedRef, Ref } from 'vue'
import {
  createCustomModuleEntry,
  normalizeCustomModuleData,
  normalizeCustomModuleEntry,
  normalizeCustomModuleSchema,
} from '../data/customModules.ts'
import { createDefaultWorldEngineState } from '../data/worldEngine.ts'
import { canonicalTriggerField, normalizeResourceTriggers, updateResourceTriggerField } from '../context/retrieval.ts'
import {
  missingAgentResourceTemplateFields,
  normalizeAgentResourceFields,
  strictStandardResourceTypes,
  unknownAgentResourceFields,
} from './resourceFieldPolicy.ts'
import type { AgentOperation, AgentResourceType, GroupedResourceCollection } from './schema.ts'
import type {
  Chapter,
  CustomModuleEntry,
  CustomModuleFieldDefinition,
  CustomModuleFieldType,
  CustomModuleFieldValue,
  CustomModuleSchema,
  AgentOperationReview,
  AgentPlanFieldDiff,
  Resource,
  Store,
  Volume,
  WorldEngineEvent,
} from '../types.ts'

/** Resource pages backed by Store collections. `worldEngine` is a sentinel
 * page for world_event operations and is handled by the engine state branch. */
export type AgentResourcePage = 'world' | 'characters' | 'items' | 'skills' | 'outline' | 'worldEngine' | 'style'
type GroupedResourcePage = 'world' | 'characters' | 'items' | 'skills' | 'style'

export const legacyStyleMetadataFields = new Set(['检查方式', '触发键', '触发词', '关键词', '关键字', '触发策略', '触发方式', '触发模式'])

type AgentOperationsOptions = {
  store: Ref<Store>
  activeChapter: ComputedRef<Chapter | undefined>
  selectedGroupIds: Ref<Record<GroupedResourcePage, string>>
  selectedVolumeId: Ref<string>
  selectedChapterId: Ref<string>
  chapterSearch: Ref<string>
  candidate: Ref<string>
  agentPageForType: (type: AgentResourceType) => AgentResourcePage
  insertResource: (page: AgentResourcePage, title: string, summary?: string, fields?: Record<string, string>) => Resource
}

const collectionLabels: Record<GroupedResourceCollection, string> = {
  world: '世界书',
  characters: '角色卡',
  items: '道具卡',
  skills: '技能卡',
  style: '文风规则',
}

const resourceLabels: Record<AgentResourceType, string> = {
  world: '世界书条目',
  character: '角色',
  item: '道具',
  skill: '技能',
  outline: '大纲条目',
  world_event: '世界引擎事件',
  style: '文风规则',
}

const groupedResourcePages = new Set<GroupedResourcePage>(['world', 'characters', 'items', 'skills', 'style'])

type CustomEntryWithAgentLocks = CustomModuleEntry & {
  /** Optional metadata kept for custom entry protection. */
  lockedAll?: boolean
  lockedFields?: string[]
}

type CustomSchemaWithAgentLocks = CustomModuleSchema & {
  lockedAll?: boolean
}

type CustomModuleReference = {
  schemaId?: string
  moduleId?: string
}

export function createAgentOperations(options: AgentOperationsOptions) {
  const { store, activeChapter, selectedGroupIds, selectedVolumeId, selectedChapterId, chapterSearch, candidate } = options

  function findResource(type: AgentResourceType, target: string) {
    const collection = store.value[options.agentPageForType(type)] as Resource[]
    const byId = collection.find((item) => item.id === target)
    if (byId) return byId
    const byTitle = collection.filter((item) => item.title.trim() === target.trim())
    if (byTitle.length > 1) throw new Error(`有多个条目名为“${target}”，请使用条目 ID 指定要修改的资料`)
    return byTitle[0]
  }

  function findGroup(collection: GroupedResourceCollection, target: string) {
    const groups = store.value.resourceGroups[collection]
    const byId = groups.find((group) => group.id === target)
    if (byId) return byId
    const byTitle = groups.filter((group) => group.title.trim() === target.trim())
    if (byTitle.length > 1) throw new Error(`${collectionLabels[collection]}中有多个折叠栏名为“${target}”，请使用折叠栏 ID 指定目标`)
    return byTitle[0]
  }

  function findGroupedResource(collection: GroupedResourceCollection, target: string) {
    const resources = store.value[collection] as Resource[]
    const byId = resources.find((resource) => resource.id === target)
    if (byId) return byId
    const byTitle = resources.filter((resource) => resource.title.trim() === target.trim())
    if (byTitle.length > 1) throw new Error(`${collectionLabels[collection]}中有多个条目名为“${target}”，请使用条目 ID 指定目标`)
    return byTitle[0]
  }

  function resolveHoldingReferences(collection: 'items' | 'skills', values: readonly string[]) {
    const resources = store.value[collection] as Resource[]
    const label = collectionLabels[collection]
    return [...new Set(values.map((rawValue) => {
      const value = rawValue.trim()
      if (!value) throw new Error(`${label}引用不能是空字符串`)
      const byId = resources.find((resource) => resource.id === value)
      if (byId) return byId.id
      const byTitle = resources.filter((resource) => resource.title.trim() === value)
      if (byTitle.length > 1) throw new Error(`${label}中有多个条目名为“${value}”，请使用条目 ID 指定引用`)
      if (!byTitle[0]) throw new Error(`没有找到${label}“${value}”，无法建立持有关系`)
      return byTitle[0].id
    }))]
  }

  function applyOutlineMetadata(item: Resource, operation: Extract<AgentOperation, { action: 'create_resource' | 'update_resource' }>, skipped: string[] = []) {
    if (operation.resourceType !== 'outline') return
    const allowed = new Set(['book', 'volume', 'chapterRange', 'scene'])
    const nextType = operation.outlineType ?? item.outlineType ?? 'chapterRange'
    if (!allowed.has(nextType)) throw new Error(`大纲层级无效：“${String(nextType)}”`)
    const parentId = operation.outlineParentId !== undefined ? operation.outlineParentId.trim() : item.outlineParentId
    const parent = parentId ? store.value.outline.find((node) => node.id === parentId) : undefined
    if (parentId && !parent) throw new Error(`没有找到上级大纲节点“${parentId}”`)
    if (parentId === item.id) throw new Error('大纲节点不能设置自己为上级')
    const parentType = parent?.outlineType ?? 'chapterRange'
    const validParent = nextType === 'book'
      ? !parent
      : nextType === 'volume'
        ? parentType === 'book'
        : nextType === 'chapterRange'
          ? parentType === 'volume' || parentType === 'book'
          : parentType === 'chapterRange' || parentType === 'volume'
    if (!validParent) throw new Error('大纲层级与上级大纲不匹配')
    const seen = new Set<string>()
    let cursor = parent?.id
    while (cursor && !seen.has(cursor)) {
      if (cursor === item.id) throw new Error('大纲节点不能移动到自己的子节点下')
      seen.add(cursor)
      cursor = store.value.outline.find((node) => node.id === cursor)?.outlineParentId
    }
    const chapterIds = new Set(store.value.chapters.map((chapter) => chapter.id))
    const startId = operation.outlineStartChapterId ?? item.outlineStartChapterId
    const endId = operation.outlineEndChapterId ?? item.outlineEndChapterId
    if (startId && !chapterIds.has(startId)) throw new Error(`没有找到起始章节“${startId}”`)
    if (endId && !chapterIds.has(endId)) throw new Error(`没有找到结束章节“${endId}”`)
    if (!isFieldLocked(item, 'outlineType') && (operation.outlineType !== undefined || !item.outlineType)) item.outlineType = nextType
    else if (operation.outlineType !== undefined) skipped.push('大纲层级')
    if (!isFieldLocked(item, 'outlineParentId') && operation.outlineParentId !== undefined) item.outlineParentId = parentId || undefined
    else if (operation.outlineParentId !== undefined) skipped.push('上级大纲')
    if (!isFieldLocked(item, 'outlineStartChapterId') && operation.outlineStartChapterId !== undefined) item.outlineStartChapterId = startId || undefined
    else if (operation.outlineStartChapterId !== undefined) skipped.push('起始章节')
    if (!isFieldLocked(item, 'outlineEndChapterId') && operation.outlineEndChapterId !== undefined) item.outlineEndChapterId = endId || undefined
    else if (operation.outlineEndChapterId !== undefined) skipped.push('结束章节')
    if (!isFieldLocked(item, 'outlineCollapsed') && operation.outlineCollapsed !== undefined) item.outlineCollapsed = operation.outlineCollapsed
    else if (operation.outlineCollapsed !== undefined) skipped.push('折叠状态')
  }

  function isFieldLocked(resource: Resource, field: string) {
    return Array.isArray(resource.lockedFields)
      && resource.lockedFields.some((locked) => canonicalTriggerField(locked) === canonicalTriggerField(field))
  }

  function isLockedAll(resource: { lockedAll?: boolean }) {
    return resource.lockedAll === true
  }

  function customModuleStore() {
    if (!store.value.customModules) store.value.customModules = { schemas: [], entries: [] }
    return store.value.customModules
  }

  function customReferenceCollection(fieldType: CustomModuleFieldType): 'characters' | 'items' | 'skills' | undefined {
    if (fieldType === 'characterIndex') return 'characters'
    if (fieldType === 'itemIndex') return 'items'
    if (fieldType === 'skillIndex') return 'skills'
    return undefined
  }

  function customFieldIsLocked(entry: CustomEntryWithAgentLocks, field: CustomModuleFieldDefinition) {
    if (field.locked) return true
    return Array.isArray(entry.lockedFields)
      && entry.lockedFields.some((locked) => locked === field.key || locked === field.id || locked === field.label)
  }

  function findCustomSchema(reference: CustomModuleReference, allowTitle = true): CustomSchemaWithAgentLocks {
    const schemaId = typeof reference.schemaId === 'string' ? reference.schemaId.trim() : ''
    const moduleId = typeof reference.moduleId === 'string' ? reference.moduleId.trim() : ''
    if (schemaId && moduleId && schemaId !== moduleId) {
      throw new Error(`schemaId（${schemaId}）与 moduleId（${moduleId}）不一致，请只指定同一个自定义模块`)
    }
    const target = schemaId || moduleId
    if (!target) throw new Error('自定义模块操作必须提供 schemaId 或 moduleId')
    const schemas = customModuleStore().schemas as CustomSchemaWithAgentLocks[]
    const byId = schemas.find((schema) => schema.id === target)
    if (byId) return byId
    if (!allowTitle) throw new Error(`没有找到 ID 为“${target}”的自定义模块`)
    const byTitle = schemas.filter((schema) => schema.title.trim() === target || schema.type.trim() === target)
    if (byTitle.length > 1) throw new Error(`有多个自定义模块名为“${target}”，请使用 schemaId 指定目标`)
    if (!byTitle[0]) throw new Error(`没有找到自定义模块“${target}”`)
    return byTitle[0]
  }

  function findCustomEntry(schema: CustomSchemaWithAgentLocks, target: string): CustomEntryWithAgentLocks {
    const normalizedTarget = target.trim()
    if (!normalizedTarget) throw new Error('自定义模块条目标识不能为空')
    const entries = customModuleStore().entries.filter((entry) => entry.schemaId === schema.id) as CustomEntryWithAgentLocks[]
    const byId = entries.find((entry) => entry.id === normalizedTarget)
    if (byId) return byId
    const byTitle = entries.filter((entry) => entry.title?.trim() === normalizedTarget)
    if (byTitle.length > 1) throw new Error(`自定义模块“${schema.title}”中有多个条目名为“${target}”，请使用条目 ID 指定目标`)
    if (!byTitle[0]) throw new Error(`没有找到自定义模块“${schema.title}”中的条目“${target}”`)
    return byTitle[0]
  }

  function makeUniqueCustomId(prefix: string, values: readonly { id: string }[]) {
    let id = ''
    do {
      id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    } while (values.some((value) => value.id === id))
    return id
  }

  /**
   * Normalize one custom data payload and resolve indexed references against
   * the current project's stable card IDs. Agent prompts expose IDs, but
   * accepting an unambiguous title here makes recovery from a model's title
   * response safe while still rejecting unknown references.
   */
  function normalizeCustomAgentData(
    schema: CustomSchemaWithAgentLocks,
    input: unknown,
    validateReferenceFields?: ReadonlySet<string>,
  ): Record<string, CustomModuleFieldValue> {
    const normalized = normalizeCustomModuleData(input, schema)
    for (const field of schema.fields) {
      const collection = customReferenceCollection(field.type)
      if (!collection) continue
      if (validateReferenceFields && !validateReferenceFields.has(field.key)) continue
      const values = normalized[field.key]
      if (!Array.isArray(values)) continue
      const resources = store.value[collection] as Resource[]
      const resolved = values.map((value) => {
        const byId = resources.find((resource) => resource.id === value)
        if (byId) return byId.id
        const byTitle = resources.filter((resource) => resource.title.trim() === value.trim())
        if (byTitle.length === 1) return byTitle[0].id
        if (byTitle.length > 1) {
          throw new Error(`自定义模块“${schema.title}”的字段“${field.label}”引用了多个同名${collectionLabels[collection]}“${value}”，请使用 ID`)
        }
        throw new Error(`自定义模块“${schema.title}”的字段“${field.label}”引用了不存在的${collectionLabels[collection]} ID“${value}”`)
      })
      normalized[field.key] = [...new Set(resolved)]
    }
    return normalized
  }

  function customEntryTitle(schema: CustomSchemaWithAgentLocks, data: Record<string, CustomModuleFieldValue>, fallback?: string) {
    if (schema.titleField) {
      const value = data[schema.titleField]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return fallback?.trim() || undefined
  }

  function validateCustomAgentDataInput(
    schema: CustomSchemaWithAgentLocks,
    input: unknown,
    requireRequired = false,
  ): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`自定义模块“${schema.title}”的 data 必须是对象`)
    }
    const source = input as Record<string, unknown>
    const fields = new Map(schema.fields.map((field) => [field.key, field]))
    for (const [key, value] of Object.entries(source)) {
      const field = fields.get(key)
      if (!field) throw new Error(`自定义模块“${schema.title}”不存在字段“${key}”`)
      if (field.type === 'number' && value !== '' && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`自定义模块“${schema.title}”的字段“${field.label}”必须是有限数字`)
      }
      if (field.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`自定义模块“${schema.title}”的字段“${field.label}”必须是布尔值`)
      }
      if (['tags', 'characterIndex', 'itemIndex', 'skillIndex'].includes(field.type)
        && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
        throw new Error(`自定义模块“${schema.title}”的字段“${field.label}”必须是字符串数组`)
      }
      if (field.type === 'enum') {
        if (typeof value !== 'string') throw new Error(`自定义模块“${schema.title}”的字段“${field.label}”必须是字符串`)
        if (value !== '' && field.options?.length && !field.options.includes(value)) {
          throw new Error(`自定义模块“${schema.title}”的字段“${field.label}”必须使用枚举选项：${field.options.join('、')}`)
        }
      }
      if (['string', 'text', 'longText'].includes(field.type) && typeof value !== 'string') {
        throw new Error(`自定义模块“${schema.title}”的字段“${field.label}”必须是字符串`)
      }
    }
    if (requireRequired) {
      for (const field of schema.fields) {
        if (field.required && !Object.prototype.hasOwnProperty.call(source, field.key)) {
          throw new Error(`自定义模块“${schema.title}”的必填字段“${field.label}”未提供`)
        }
      }
    }
    return source
  }

  function operationCustomSchemaId(operation: {
    schemaId?: string
    moduleId?: string
  }) {
    const schemaId = typeof operation.schemaId === 'string' ? operation.schemaId.trim() : ''
    const moduleId = typeof operation.moduleId === 'string' ? operation.moduleId.trim() : ''
    if (schemaId && moduleId && schemaId !== moduleId) {
      throw new Error(`schemaId（${schemaId}）与 moduleId（${moduleId}）不一致，请只指定同一个自定义模块`)
    }
    return schemaId || moduleId
  }

  function customEntryTarget(operation: {
    target?: string
    id?: string
  }) {
    const target = typeof operation.target === 'string' ? operation.target.trim() : ''
    const id = typeof operation.id === 'string' ? operation.id.trim() : ''
    if (target && id && target !== id) throw new Error(`自定义模块操作的 target（${target}）与 id（${id}）不一致`)
    return target || id
  }

  function applyCustomModuleOperation(operation: Extract<
    AgentOperation,
    { action: 'create_custom_module' | 'create_custom_module_entry' | 'update_custom_module_entry' | 'delete_custom_module_entry' }
  >) {
    const customStore = customModuleStore()
    if (operation.action === 'create_custom_module') {
      const title = operation.title.trim()
      if (!title) throw new Error('自定义模块名称不能为空')
      if (!Array.isArray(operation.fields) || operation.fields.length === 0) {
        throw new Error('自定义模块至少需要定义一个字段')
      }
      if (customStore.schemas.some((schema) => schema.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase())) {
        throw new Error(`已经存在名为“${title}”的自定义模块`)
      }
      const requestedId = typeof operation.id === 'string' ? operation.id.trim() : ''
      if (requestedId && customStore.schemas.some((schema) => schema.id === requestedId)) {
        throw new Error(`自定义模块 ID“${requestedId}”已存在，请换一个 ID`)
      }
      const now = Date.now()
      const schema = normalizeCustomModuleSchema({
        id: requestedId || makeUniqueCustomId('custom-module', customStore.schemas),
        type: operation.type?.trim() || title,
        title,
        description: operation.description?.trim() || '',
        fields: operation.fields ?? [],
        titleField: operation.titleField,
        createdAt: now,
        updatedAt: now,
      }, now)
      customStore.schemas.push(schema)
      return `已创建自定义模块“${schema.title}”（schemaId：${schema.id}）。`
    }

    const schema = findCustomSchema(operation)
    if (schema.lockedAll) {
      throw new Error(`自定义模块“${schema.title}”已整体锁定，Agent 不能修改`)
    }

    if (operation.action === 'create_custom_module_entry') {
      const requestedId = typeof operation.id === 'string' ? operation.id.trim() : ''
      const existingEntries = customStore.entries.filter((entry) => entry.schemaId === schema.id)
      if (requestedId && existingEntries.some((entry) => entry.id === requestedId)) {
        throw new Error(`自定义模块“${schema.title}”中条目 ID“${requestedId}”已存在`)
      }
      const input = validateCustomAgentDataInput(schema, operation.data, true)
      const data = normalizeCustomAgentData(schema, input)
      const now = Date.now()
      const entry = createCustomModuleEntry(schema, data, now)
      if (requestedId) entry.id = requestedId
      const explicitTitle = typeof operation.title === 'string' ? operation.title.trim() : ''
      entry.title = explicitTitle || customEntryTitle(schema, data)
      customStore.entries.push(entry)
      return `已在自定义模块“${schema.title}”中创建条目“${entry.title || entry.id}”（entryId：${entry.id}）。`
    }

    const target = customEntryTarget(operation)
    if (!target) throw new Error('更新或删除自定义模块条目必须提供 target 或 id')
    const entry = findCustomEntry(schema, target)
    if (entry.lockedAll) throw new Error(`自定义模块“${schema.title}”条目“${entry.title || entry.id}”已整体锁定，Agent 不能修改`)

    if (operation.action === 'delete_custom_module_entry') {
      customStore.entries = customStore.entries.filter((candidate) => candidate !== entry)
      return `已删除自定义模块“${schema.title}”中的条目“${entry.title || entry.id}”。`
    }

    const skipped: string[] = []
    const mergedData: Record<string, unknown> = { ...entry.data }
    const input = operation.data === undefined ? {} : validateCustomAgentDataInput(schema, operation.data)
    const changedReferenceFields = new Set<string>()
    for (const [fieldKey, value] of Object.entries(input)) {
      const field = schema.fields.find((candidate) => candidate.key === fieldKey || candidate.id === fieldKey)
      if (!field) throw new Error(`自定义模块“${schema.title}”不存在字段“${fieldKey}”`)
      if (customFieldIsLocked(entry, field)) {
        skipped.push(field.key)
        continue
      }
      mergedData[field.key] = value
      if (customReferenceCollection(field.type)) changedReferenceFields.add(field.key)
    }
    const data = normalizeCustomAgentData(schema, mergedData, changedReferenceFields)
    const explicitTitle = operation.title?.trim() || ''
    const next = normalizeCustomModuleEntry({
      ...entry,
      schemaId: schema.id,
      data,
      title: explicitTitle || customEntryTitle(schema, data, entry.title),
      updatedAt: Date.now(),
    }, schema, Date.now())
    if (explicitTitle && entry.lockedFields?.some((field) => field === 'title')) {
      skipped.push('title')
      next.title = entry.title
    } else if (explicitTitle) {
      next.title = explicitTitle
    }
    Object.assign(entry, next)
    return skipped.length
      ? `已更新自定义模块“${schema.title}”条目“${entry.title || entry.id}”；已跳过锁定字段：${[...new Set(skipped)].join('、')}。`
      : `已更新自定义模块“${schema.title}”条目“${entry.title || entry.id}”。`
  }

  function applyAgentOperation(operation: AgentOperation) {
    if (operation.action === 'search_web_memes') {
      // Network access is delegated to the caller/UI; this never mutates the world book.
      return `已准备使用${operation.engine}搜索“${operation.query.trim()}”，最多返回 ${operation.limit} 条候选；搜索结果需由调用层确认后再收录。`
    }
    if (
      operation.action === 'create_custom_module'
      || operation.action === 'create_custom_module_entry'
      || operation.action === 'update_custom_module_entry'
      || operation.action === 'delete_custom_module_entry'
    ) {
      return applyCustomModuleOperation(operation)
    }
    if (operation.action === 'create_resource_group') {
      const title = operation.title.trim()
      if (!title) throw new Error('折叠栏名称不能为空')
      const groups = store.value.resourceGroups[operation.collection]
      if (groups.some((group) => group.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase())) {
        throw new Error(`${collectionLabels[operation.collection]}中已存在名为“${title}”的折叠栏`)
      }
      let id = ''
      do {
        id = `${operation.collection}-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      } while (groups.some((group) => group.id === id))
      groups.push({ id, title, collapsed: false })
      return `已在${collectionLabels[operation.collection]}创建折叠栏“${title}”。`
    }
    if (operation.action === 'delete_resource_group') {
      const group = findGroup(operation.collection, operation.target)
      if (!group) throw new Error(`没有找到${collectionLabels[operation.collection]}折叠栏“${operation.target}”`)
      const resources = store.value[operation.collection] as Resource[]
      if (resources.some((resource) => resource.groupId === group.id && isLockedAll(resource))) {
        throw new Error(`无法删除折叠栏“${group.title}”：其中有已锁定条目，Agent 不能移动这些条目`)
      }
      for (const resource of resources) {
        if (resource.groupId === group.id) delete resource.groupId
      }
      store.value.resourceGroups[operation.collection] = store.value.resourceGroups[operation.collection].filter((item) => item.id !== group.id)
      if (selectedGroupIds.value[operation.collection] === group.id) selectedGroupIds.value[operation.collection] = ''
      return `已删除${collectionLabels[operation.collection]}折叠栏“${group.title}”；其中条目已保留并移回未分组。`
    }
    if (operation.action === 'move_resource_to_group') {
      const resource = findGroupedResource(operation.collection, operation.target)
      if (!resource) throw new Error(`没有找到${collectionLabels[operation.collection]}条目“${operation.target}”`)
      if (isLockedAll(resource)) throw new Error(`条目“${resource.title}”已整体锁定，Agent 不能移动分组`)
      if (operation.groupTarget === null) {
        delete resource.groupId
        return `已将${collectionLabels[operation.collection]}条目“${resource.title}”移回未分组。`
      }
      const group = findGroup(operation.collection, operation.groupTarget)
      if (!group) throw new Error(`没有找到${collectionLabels[operation.collection]}折叠栏“${operation.groupTarget}”`)
      resource.groupId = group.id
      return `已将${collectionLabels[operation.collection]}条目“${resource.title}”移入折叠栏“${group.title}”。`
    }
    if (operation.action === 'append_chapter') {
      const chapter = operation.chapterId
        ? store.value.chapters.find((item) => item.id === operation.chapterId)
        : activeChapter.value
      if (!chapter) throw new Error('当前没有可写入的章节')
      const nextContent = chapter.content ? `${chapter.content.trimEnd()}\n\n${operation.content.trim()}` : operation.content.trim()
      chapter.content = nextContent
      chapter.wordCount = nextContent.replace(/\s/g, '').length
      chapter.status = '草稿'
      return `已将内容追加到“${chapter.title}”。`
    }
    if (operation.action === 'create_volume') {
      const title = operation.title.trim()
      if (!title) throw new Error('分卷标题不能为空')
      let id = ''
      do {
        id = `volume-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      } while (store.value.volumes.some((volume) => volume.id === id))
      const volume: Volume = { id, title, collapsed: false }
      store.value.volumes.push(volume)
      selectedVolumeId.value = volume.id
      chapterSearch.value = ''
      return `已创建分卷“${volume.title}”，当前为展开状态。`
    }
    if (operation.action === 'create_chapter') {
      const title = operation.title.trim()
      if (!title) throw new Error('章节标题不能为空')
      const requestedVolume = operation.volumeId
        ? store.value.volumes.find((volume) => volume.id === operation.volumeId)
        : store.value.volumes.find((volume) => volume.id === selectedVolumeId.value)
          ?? store.value.volumes.find((volume) => volume.id === activeChapter.value?.volumeId)
          ?? store.value.volumes[0]
      if (!requestedVolume) throw new Error(operation.volumeId ? `指定分卷“${operation.volumeId}”不存在` : '当前作品没有可用分卷')
      const content = operation.content ?? ''
      let id = ''
      do {
        id = `chapter-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      } while (store.value.chapters.some((chapter) => chapter.id === id))
      const chapter: Chapter = {
        id,
        title,
        status: '草稿',
        content,
        wordCount: content.replace(/\s/g, '').length,
        volumeId: requestedVolume.id,
      }
      store.value.chapters.push(chapter)
      requestedVolume.collapsed = false
      selectedVolumeId.value = requestedVolume.id
      selectedChapterId.value = chapter.id
      chapterSearch.value = ''
      candidate.value = ''
      return `已在“${requestedVolume.title}”中创建章节“${chapter.title}”（${chapter.wordCount} 字），并切换为当前章节。`
    }
    if (operation.resourceType === 'world_event') {
      const engine = store.value.worldEngine ?? (store.value.worldEngine = createDefaultWorldEngineState())
      if (operation.action === 'create_resource') {
        const fields = normalizeAgentResourceFields(operation.resourceType, operation.fields)
        const kinds = ['trend', 'event', 'action', 'discovery', 'consequence'] as const
        const event: WorldEngineEvent = {
          id: `engine-event-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: kinds.includes(fields['类型'] as WorldEngineEvent['kind']) ? fields['类型'] as WorldEngineEvent['kind'] : 'event',
          title: operation.title.trim(),
          summary: operation.summary?.trim() || fields['摘要'] || fields['内容'] || '由 Agent 提出的世界引擎事件。',
          status: 'planned',
          actorIds: [],
          scheduledTime: fields['时间'] || fields['发生时间'] || undefined,
          chapterId: activeChapter.value?.id,
          consequences: fields['后果'] ? fields['后果'].split(/[、,，;；\n]+/).map((item) => item.trim()).filter(Boolean) : [],
          evidence: [activeChapter.value?.title].filter((item): item is string => Boolean(item)),
          creationSource: 'agent',
          updatedAt: Date.now(),
        }
        engine.events.unshift(event)
        engine.updatedAt = Date.now()
        return `已创建世界引擎事件“${event.title}”，当前状态为待推进。`
      }
      if (operation.action === 'update_resource') {
        const target = operation.target.trim()
        const eventById = engine.events.find((item) => item.id === target)
        const eventsByTitle = engine.events.filter((item) => item.title.trim() === target)
        if (!eventById && eventsByTitle.length > 1) throw new Error(`有多个世界引擎事件名为“${target}”，请使用事件 ID 指定目标`)
        const event = eventById ?? eventsByTitle[0]
        if (!event) throw new Error(`没有找到名为“${operation.target}”的世界引擎事件`)
        if (isLockedAll(event)) throw new Error(`世界引擎事件“${event.title}”已整体锁定，Agent 不能修改`)
        if (Object.prototype.hasOwnProperty.call(operation, 'title')) {
          const title = operation.title?.trim() ?? ''
          if (!title) throw new Error('世界引擎事件名称不能为空；如需清空描述，请只提交 summary: ""')
          event.title = title
        }
        if (Object.prototype.hasOwnProperty.call(operation, 'summary')) {
          event.summary = operation.summary?.trim() ?? ''
        }
        const fields = normalizeAgentResourceFields(operation.resourceType, operation.fields)
        for (const [field, value] of Object.entries(fields)) {
          const kinds = ['trend', 'event', 'action', 'discovery', 'consequence']
          const statuses = ['planned', 'active', 'resolved', 'discarded']
          if (field === '类型' && kinds.includes(value)) event.kind = value as WorldEngineEvent['kind']
          else if (field === '状态' && statuses.includes(value)) event.status = value as WorldEngineEvent['status']
          else if (field === '时间' || field === '发生时间') event.scheduledTime = value
          else if (field === '后果') event.consequences = value.split(/[、,，;；\n]+/).map((item) => item.trim()).filter(Boolean)
        }
        const skipped: string[] = []
        if (operation.reviewStatus !== undefined) {
          if (event.reviewStatusLocked) skipped.push('校对状态')
          else event.reviewStatus = operation.reviewStatus
        }
        event.updatedAt = Date.now()
        engine.updatedAt = Date.now()
        return skipped.length
          ? `已更新世界引擎事件“${event.title}”；已跳过锁定内容：${skipped.join('、')}。`
          : `已更新世界引擎事件“${event.title}”。`
      }
    }
    if (operation.action === 'create_resource') {
      const page = options.agentPageForType(operation.resourceType)
      const fields = normalizeAgentResourceFields(operation.resourceType, operation.fields)
      if (strictStandardResourceTypes.includes(operation.resourceType as (typeof strictStandardResourceTypes)[number])) {
        if (operation.includeAllFields !== true) {
          throw new Error(`创建${resourceLabels[operation.resourceType]}时必须显式设置 includeAllFields:true，并返回完整模板，不能只返回摘要`)
        }
        const missingTemplateFields = missingAgentResourceTemplateFields(operation.resourceType, fields)
        if (missingTemplateFields.length) {
          throw new Error(`创建${resourceLabels[operation.resourceType]}时必须返回完整结构；缺少字段：${missingTemplateFields.join('、')}。没有内容的字段也请填写空字符串。`)
        }
      }
      const unknownFields = unknownAgentResourceFields(operation.resourceType, fields)
      if (unknownFields.length) {
        throw new Error(`不能把新字段写入${resourceLabels[operation.resourceType]}：${unknownFields.join('、')}。如需独立结构，请使用自定义模块。`)
      }
      const holdingItems = operation.resourceType === 'character' && operation.holdingItems
        ? resolveHoldingReferences('items', operation.holdingItems)
        : undefined
      const holdingSkills = operation.resourceType === 'character' && operation.holdingSkills
        ? resolveHoldingReferences('skills', operation.holdingSkills)
        : undefined
      const item = options.insertResource(page, operation.title, operation.summary, fields)
      item.creationSource = 'agent'
      if (groupedResourcePages.has(page as GroupedResourcePage)) {
        const collection = page as GroupedResourcePage
        delete item.groupId
        if (operation.groupTarget) {
          const group = findGroup(collection, operation.groupTarget)
          if (!group) throw new Error(`没有找到${collectionLabels[collection]}折叠栏“${operation.groupTarget}”`)
          item.groupId = group.id
        }
      }
      if (holdingItems && page === 'characters') item.holdingItems = holdingItems
      if (holdingSkills && page === 'characters') item.holdingSkills = holdingSkills
      applyOutlineMetadata(item, operation)
      if (['world', 'character', 'item', 'skill'].includes(operation.resourceType)) normalizeResourceTriggers(item)
      if (page === 'characters' && item.fields['角色身份']) item.tag = item.fields['角色身份']
      if (page === 'skills' && item.fields['技能性质']) item.tag = item.fields['技能性质']
      const label = page === 'characters' ? '角色' : page === 'items' ? '道具' : page === 'skills' ? '技能' : page === 'world' ? '世界书条目' : page === 'outline' ? '大纲条目' : page === 'worldEngine' ? '世界引擎事件' : '文风规则'
      return `已创建${label}“${item.title}”，已写入 ${Object.keys(fields).length} 个模板字段。`
    }
    const item = findResource(operation.resourceType, operation.target)
    if (!item) throw new Error(`没有找到名为“${operation.target}”的${operation.resourceType === 'character' ? '角色' : '资料'}`)
    if (isLockedAll(item)) throw new Error(`${resourceLabels[operation.resourceType]}“${item.title}”已整体锁定，Agent 不能修改`)
    const holdingItems = operation.resourceType === 'character' && operation.holdingItems
      ? resolveHoldingReferences('items', operation.holdingItems)
      : undefined
    const holdingSkills = operation.resourceType === 'character' && operation.holdingSkills
      ? resolveHoldingReferences('skills', operation.holdingSkills)
      : undefined
    const skipped: string[] = []
    if (Object.prototype.hasOwnProperty.call(operation, 'title')) {
      const title = operation.title?.trim() ?? ''
      if (!title) throw new Error('条目名称不能为空；如需清空描述，请只提交 summary: ""')
      if (isFieldLocked(item, 'title')) skipped.push('名称')
      else item.title = title
    }
    if (Object.prototype.hasOwnProperty.call(operation, 'summary')) {
      if (isFieldLocked(item, 'summary')) skipped.push('摘要/角色信息')
      else item.summary = operation.summary?.trim() ?? ''
    }
    if (operation.fields) {
      const fields = normalizeAgentResourceFields(operation.resourceType, operation.fields)
      const unknownFields = unknownAgentResourceFields(operation.resourceType, fields, item.fields)
      if (unknownFields.length) {
        throw new Error(`不能向${resourceLabels[operation.resourceType]}新增字段：${unknownFields.join('、')}。如需独立结构，请使用自定义模块。`)
      }
      for (const [field, value] of Object.entries(fields)) {
        if (operation.resourceType === 'style' && legacyStyleMetadataFields.has(field)) continue
        if (isFieldLocked(item, field)) skipped.push(field)
        else if (['world', 'character', 'item', 'skill'].includes(operation.resourceType)
          && updateResourceTriggerField(item, field, value)) continue
        else item.fields[field] = value
      }
    }
    if (['world', 'character', 'item', 'skill'].includes(operation.resourceType)) normalizeResourceTriggers(item)
    if (operation.resourceType === 'skill') item.fields['技能性质'] = item.fields['技能性质'] === '被动' ? '被动' : '主动'
    if (operation.resourceType === 'character' && holdingItems) {
      if (isFieldLocked(item, 'holdingItems')) skipped.push('持有道具')
      else item.holdingItems = holdingItems
    }
    if (operation.resourceType === 'character' && holdingSkills) {
      if (isFieldLocked(item, 'holdingSkills')) skipped.push('持有技能')
      else item.holdingSkills = holdingSkills
    }
    applyOutlineMetadata(item, operation, skipped)
    if (operation.reviewStatus !== undefined) {
      if (item.reviewStatusLocked) skipped.push('校对状态')
      else item.reviewStatus = operation.reviewStatus
    }
    if (operation.resourceType === 'character' && item.fields['角色身份']) item.tag = item.fields['角色身份']
    if (operation.resourceType === 'skill' && item.fields['技能性质']) item.tag = item.fields['技能性质']
    return skipped.length ? `已更新${item.title}的资料；已跳过锁定内容：${[...new Set(skipped)].join('、')}。` : `已更新${item.title}的资料。`
  }

  function reviewValue(value: unknown, limit = 420): unknown {
    if (value === undefined) return undefined
    if (typeof value === 'string') {
      const normalized = value.replace(/\s+/g, ' ').trim()
      return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
    }
    if (Array.isArray(value)) {
      const normalized = value.map((item) => typeof item === 'string' ? item.trim() : item)
      return normalized.length > 30 ? [...normalized.slice(0, 30), `…（共 ${normalized.length} 项）`] : normalized
    }
    if (value && typeof value === 'object') {
      try {
        const text = JSON.stringify(value)
        return text.length > limit ? `${text.slice(0, limit)}…` : JSON.parse(text)
      } catch {
        return String(value)
      }
    }
    return value
  }

  function reviewValueIsEmpty(value: unknown) {
    return value === undefined || value === null || value === ''
      || (Array.isArray(value) && value.length === 0)
  }

  function reviewValuesEqual(before: unknown, after: unknown) {
    if (before === after) return true
    try {
      return JSON.stringify(before) === JSON.stringify(after)
    } catch {
      return false
    }
  }

  function makePlanDiff(field: string, before: unknown, after: unknown, locked = false): AgentPlanFieldDiff | undefined {
    if (!locked && reviewValuesEqual(before, after)) return undefined
    const hasBefore = before !== undefined
    const hasAfter = after !== undefined
    let status: AgentPlanFieldDiff['status'] = 'changed'
    if (locked) status = 'locked'
    else if (!hasBefore && hasAfter) status = 'added'
    else if (hasBefore && !hasAfter) status = 'removed'
    else if (!reviewValueIsEmpty(before) && reviewValueIsEmpty(after)) status = 'cleared'
    return {
      field,
      before: reviewValue(before),
      after: reviewValue(after),
      status,
      ...(locked ? { locked: true } : {}),
    }
  }

  function appendPlanDiff(
    diffs: AgentPlanFieldDiff[],
    field: string,
    before: unknown,
    after: unknown,
    locked = false,
  ) {
    const diff = makePlanDiff(field, before, after, locked)
    if (diff) diffs.push(diff)
  }

  function reviewResourceField(resourceType: AgentResourceType, resource: Resource | WorldEngineEvent | undefined, field: string): unknown {
    if (!resource) return undefined
    if (field === 'title') return resource.title
    if (field === 'summary') return resource.summary
    if (field === 'holdingItems') return 'holdingItems' in resource ? resource.holdingItems ?? [] : undefined
    if (field === 'holdingSkills') return 'holdingSkills' in resource ? resource.holdingSkills ?? [] : undefined
    if (field === 'reviewStatus') return 'reviewStatus' in resource ? resource.reviewStatus : undefined
    if (resourceType === 'world_event') {
      const event = resource as WorldEngineEvent
      if (field === '类型') return event.kind
      if (field === '状态') return event.status
      if (field === '时间' || field === '发生时间') return event.scheduledTime
      if (field === '后果') return event.consequences?.join('、') ?? ''
      if (field === '内容' || field === '摘要') return event.summary
      return undefined
    }
    if (field === 'outlineType') return (resource as Resource).outlineType
    if (field === 'outlineParentId') return (resource as Resource).outlineParentId
    if (field === 'outlineStartChapterId') return (resource as Resource).outlineStartChapterId
    if (field === 'outlineEndChapterId') return (resource as Resource).outlineEndChapterId
    if (field === 'outlineCollapsed') return (resource as Resource).outlineCollapsed
    return 'fields' in resource ? resource.fields?.[field] : undefined
  }

  function reviewResourceTarget(resourceType: AgentResourceType, target: string): Resource | WorldEngineEvent | undefined {
    try {
      if (resourceType === 'world_event') {
        const events = store.value.worldEngine?.events ?? []
        return events.find((event) => event.id === target)
          ?? events.find((event) => event.title.trim() === target.trim())
      }
      return findResource(resourceType, target)
    } catch {
      return undefined
    }
  }

  function normalizeReviewAfter(resourceType: AgentResourceType, field: string, value: unknown): unknown {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (field === '触发策略') return /^(always|常驻|永久|始终|全局|固定)$/i.test(trimmed) ? '常驻' : '关键词'
      if (field === '触发键') return [...new Set(trimmed.split(/[\s,，、;；|｜/]+/g).map((item) => item.trim()).filter(Boolean))].join('、')
      if (resourceType === 'skill' && field === '技能性质') return trimmed === '被动' ? '被动' : '主动'
      if (['title', 'summary', 'outlineParentId', 'outlineStartChapterId', 'outlineEndChapterId'].includes(field)) return trimmed
    }
    return value
  }

  function resolveReviewHolding(collection: 'items' | 'skills', values: readonly string[]) {
    try {
      return resolveHoldingReferences(collection, values)
    } catch {
      return values
    }
  }

  function reviewKind(action: AgentOperation['action']): AgentOperationReview['kind'] {
    if (action.startsWith('create_')) return 'create'
    if (action.startsWith('delete_')) return 'delete'
    if (action.startsWith('move_')) return 'move'
    if (action === 'append_chapter') return 'append'
    if (action === 'search_web_memes') return 'search'
    return 'update'
  }

  /**
   * Build a serializable, field-level review without mutating the Store.
   * This intentionally remains separate from `describeAgentOperation` so the
   * existing approval and history text stays backwards compatible.
   */
  function describeAgentOperationReview(operation: AgentOperation, operationIndex = 0, targetContext?: { portfolioId?: string; projectId?: string }): AgentOperationReview {
    const kind = reviewKind(operation.action)
    const diffs: AgentPlanFieldDiff[] = []
    let title = describeAgentOperation(operation)
    let target: string | undefined
    const resourceType = 'resourceType' in operation ? operation.resourceType : undefined
    const targetPath: AgentOperationReview['targetPath'] = {
      ...targetContext,
      collection: resourceType === 'character' ? 'characters'
        : resourceType === 'item' ? 'items'
          : resourceType === 'skill' ? 'skills'
            : resourceType === 'world' ? 'world'
              : resourceType === 'style' ? 'style'
                : resourceType === 'outline' ? 'outline'
                  : resourceType === 'world_event' ? 'worldEngine'
                    : undefined,
    }
    if (operation.action === 'search_web_memes') {
      appendPlanDiff(diffs, '搜索引擎', undefined, operation.engine)
      appendPlanDiff(diffs, '关键词', undefined, operation.query)
      appendPlanDiff(diffs, '最多条数', undefined, operation.limit)
      return { operationIndex, action: operation.action, kind, title, targetPath, diffs }
    }
    if (operation.action === 'create_resource') {
      appendPlanDiff(diffs, '名称', undefined, normalizeReviewAfter(operation.resourceType, 'title', operation.title))
      if (Object.prototype.hasOwnProperty.call(operation, 'summary')) appendPlanDiff(diffs, '摘要/角色信息', undefined, normalizeReviewAfter(operation.resourceType, 'summary', operation.summary ?? ''))
      const fields = normalizeAgentResourceFields(operation.resourceType, operation.fields)
      for (const [field, value] of Object.entries(fields)) {
        if (operation.resourceType === 'style' && legacyStyleMetadataFields.has(field)) continue
        appendPlanDiff(diffs, field, undefined, normalizeReviewAfter(operation.resourceType, field, value))
      }
      if (operation.holdingItems) appendPlanDiff(diffs, '持有道具', undefined, resolveReviewHolding('items', operation.holdingItems))
      if (operation.holdingSkills) appendPlanDiff(diffs, '持有技能', undefined, resolveReviewHolding('skills', operation.holdingSkills))
      if (operation.groupTarget !== undefined) appendPlanDiff(diffs, '折叠栏', undefined, operation.groupTarget ?? '未分组')
      if (operation.outlineType !== undefined) appendPlanDiff(diffs, '大纲层级', undefined, operation.outlineType)
      if (operation.outlineParentId !== undefined) appendPlanDiff(diffs, '上级大纲', undefined, operation.outlineParentId || '无')
      if (operation.outlineStartChapterId !== undefined) appendPlanDiff(diffs, '起始章节', undefined, operation.outlineStartChapterId || '无')
      if (operation.outlineEndChapterId !== undefined) appendPlanDiff(diffs, '结束章节', undefined, operation.outlineEndChapterId || '无')
      if (operation.outlineCollapsed !== undefined) appendPlanDiff(diffs, '折叠状态', undefined, operation.outlineCollapsed ? '折叠' : '展开')
      return { operationIndex, action: operation.action, kind, title, target: operation.title, targetPath, diffs }
    }
    if (operation.action === 'update_resource') {
      target = operation.target
      const resource = reviewResourceTarget(operation.resourceType, operation.target)
      const allLocked = Boolean(resource && isLockedAll(resource))
      title = describeAgentOperation(operation)
      if (Object.prototype.hasOwnProperty.call(operation, 'title')) {
        appendPlanDiff(diffs, '名称', reviewResourceField(operation.resourceType, resource, 'title'), normalizeReviewAfter(operation.resourceType, 'title', operation.title ?? ''), allLocked || Boolean(resource && isFieldLocked(resource as Resource, 'title')))
      }
      if (Object.prototype.hasOwnProperty.call(operation, 'summary')) {
        appendPlanDiff(diffs, '摘要/角色信息', reviewResourceField(operation.resourceType, resource, 'summary'), normalizeReviewAfter(operation.resourceType, 'summary', operation.summary ?? ''), allLocked || Boolean(resource && isFieldLocked(resource as Resource, 'summary')))
      }
      const fields = normalizeAgentResourceFields(operation.resourceType, operation.fields)
      for (const [field, value] of Object.entries(fields)) {
        if (operation.resourceType === 'style' && legacyStyleMetadataFields.has(field)) continue
        appendPlanDiff(diffs, field, reviewResourceField(operation.resourceType, resource, field), normalizeReviewAfter(operation.resourceType, field, value), allLocked || Boolean(resource && isFieldLocked(resource as Resource, field)))
      }
      if (operation.holdingItems) appendPlanDiff(diffs, '持有道具', reviewResourceField(operation.resourceType, resource, 'holdingItems'), resolveReviewHolding('items', operation.holdingItems), allLocked || Boolean(resource && isFieldLocked(resource as Resource, 'holdingItems')))
      if (operation.holdingSkills) appendPlanDiff(diffs, '持有技能', reviewResourceField(operation.resourceType, resource, 'holdingSkills'), resolveReviewHolding('skills', operation.holdingSkills), allLocked || Boolean(resource && isFieldLocked(resource as Resource, 'holdingSkills')))
      if (operation.reviewStatus !== undefined) appendPlanDiff(diffs, '校对状态', reviewResourceField(operation.resourceType, resource, 'reviewStatus'), operation.reviewStatus, allLocked || Boolean(resource && 'reviewStatusLocked' in resource && resource.reviewStatusLocked))
      const outlineFields: Array<[keyof typeof operation, string]> = [
        ['outlineType', '大纲层级'],
        ['outlineParentId', '上级大纲'],
        ['outlineStartChapterId', '起始章节'],
        ['outlineEndChapterId', '结束章节'],
        ['outlineCollapsed', '折叠状态'],
      ]
      for (const [key, label] of outlineFields) {
        if (operation[key] === undefined) continue
        const value = operation[key]
        const after = key === 'outlineCollapsed' ? (value ? '折叠' : '展开') : (value || '无')
        appendPlanDiff(diffs, label, reviewResourceField(operation.resourceType, resource, key), after, allLocked || Boolean(resource && isFieldLocked(resource as Resource, key)))
      }
      return { operationIndex, action: operation.action, kind, title, target, targetPath, diffs }
    }
    if (operation.action === 'create_resource_group') {
      appendPlanDiff(diffs, '折叠栏', undefined, operation.title)
      return { operationIndex, action: operation.action, kind, title, target: operation.title, targetPath: { collection: operation.collection }, diffs }
    }
    if (operation.action === 'delete_resource_group') {
      target = operation.target
      const group = (() => { try { return findGroup(operation.collection, operation.target) } catch { return undefined } })()
      appendPlanDiff(diffs, '折叠栏', group?.title ?? operation.target, undefined)
      const resources = group ? (store.value[operation.collection] as Resource[]).filter((item) => item.groupId === group.id) : []
      if (group) appendPlanDiff(diffs, '包含条目', resources.length, undefined)
      return { operationIndex, action: operation.action, kind, title, target, targetPath: { collection: operation.collection }, diffs }
    }
    if (operation.action === 'move_resource_to_group') {
      target = operation.target
      const resource = (() => { try { return findGroupedResource(operation.collection, operation.target) } catch { return undefined } })()
      const beforeGroup = resource?.groupId ? (store.value.resourceGroups[operation.collection] ?? []).find((group) => group.id === resource.groupId)?.title : '未分组'
      const afterGroup = operation.groupTarget === null ? '未分组' : operation.groupTarget
      appendPlanDiff(diffs, '折叠栏', beforeGroup, afterGroup)
      return { operationIndex, action: operation.action, kind, title, target, targetPath: { collection: operation.collection }, diffs }
    }
    if (operation.action === 'create_volume') {
      appendPlanDiff(diffs, '分卷名称', undefined, operation.title)
      return { operationIndex, action: operation.action, kind, title, target: operation.title, targetPath: { collection: 'volumes' }, diffs }
    }
    if (operation.action === 'create_chapter') {
      appendPlanDiff(diffs, '章节名称', undefined, operation.title)
      if (Object.prototype.hasOwnProperty.call(operation, 'content')) appendPlanDiff(diffs, '正文', undefined, operation.content ?? '')
      if (operation.volumeId) appendPlanDiff(diffs, '所属分卷', undefined, operation.volumeId)
      return { operationIndex, action: operation.action, kind, title, target: operation.title, targetPath: { collection: 'chapters' }, diffs }
    }
    if (operation.action === 'append_chapter') {
      const chapter = operation.chapterId
        ? store.value.chapters.find((item) => item.id === operation.chapterId)
        : activeChapter.value
      appendPlanDiff(diffs, '追加正文', chapter?.content ?? '', `${chapter?.content ? `${chapter.content.trimEnd()}\n\n` : ''}${operation.content.trim()}`)
      return { operationIndex, action: operation.action, kind, title, target: chapter?.title ?? operation.chapterId, targetPath: { collection: 'chapters' }, diffs }
    }
    if (operation.action === 'create_custom_module') {
      appendPlanDiff(diffs, '模块名称', undefined, operation.title)
      if (operation.type !== undefined) appendPlanDiff(diffs, '模块类型', undefined, operation.type)
      if (operation.description !== undefined) appendPlanDiff(diffs, '模块说明', undefined, operation.description)
      if (operation.fields) appendPlanDiff(diffs, '字段定义', undefined, operation.fields.map((field) => `${field.label || field.key}（${field.type}）`))
      return { operationIndex, action: operation.action, kind, title, target: operation.title, targetPath: { collection: 'customModules.schemas' }, diffs }
    }
    if (operation.action === 'create_custom_module_entry') {
      const schemaId = operationCustomSchemaId(operation) || '未指定模块'
      appendPlanDiff(diffs, '条目名称', undefined, operation.title ?? '')
      for (const [field, value] of Object.entries(operation.data ?? {})) appendPlanDiff(diffs, field, undefined, value)
      return { operationIndex, action: operation.action, kind, title, target: schemaId, targetPath: { collection: `customModules.${schemaId}` }, diffs }
    }
    if (operation.action === 'update_custom_module_entry' || operation.action === 'delete_custom_module_entry') {
      const schemaId = operationCustomSchemaId(operation) || '未指定模块'
      target = customEntryTarget(operation)
      let schema: CustomSchemaWithAgentLocks | undefined
      let entry: CustomEntryWithAgentLocks | undefined
      try {
        schema = findCustomSchema(operation)
        entry = target ? findCustomEntry(schema, target) : undefined
      } catch {
        schema = undefined
      }
      if (operation.action === 'delete_custom_module_entry') {
        appendPlanDiff(diffs, '条目名称', entry?.title ?? target, undefined)
        for (const [field, value] of Object.entries(entry?.data ?? {})) appendPlanDiff(diffs, field, value, undefined)
      } else {
        if (Object.prototype.hasOwnProperty.call(operation, 'title')) appendPlanDiff(diffs, '条目名称', entry?.title, operation.title ?? '', Boolean(entry?.lockedAll || entry?.lockedFields?.includes('title')))
        for (const [field, value] of Object.entries(operation.data ?? {})) {
          const definition = schema?.fields.find((candidate) => candidate.key === field || candidate.id === field)
          const canonical = definition?.key ?? field
          appendPlanDiff(diffs, canonical, entry?.data?.[canonical], value, Boolean(entry?.lockedAll || (entry && definition && customFieldIsLocked(entry, definition))))
        }
      }
      return { operationIndex, action: operation.action, kind, title, target: `${schemaId} / ${target ?? '未指定条目'}`, targetPath: { collection: `customModules.${schemaId}` }, diffs }
    }
    return { operationIndex, action: (operation as AgentOperation).action, kind, title, targetPath, diffs }
  }

  function describeAgentOperation(operation: AgentOperation, precedingOperations: AgentOperation[] = []) {
    if (operation.action === 'search_web_memes') return `拆分关键词并分批搜索、整理网络热梗（${operation.engine}）：${operation.query.trim()}（最多 ${operation.limit} 条），提炼后写入网络热梗栏目`
    const preview = (value: string, limit = 220) => {
      const normalized = value.trim().replace(/\s+/g, ' ')
      return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
    }
    if (operation.action === 'create_custom_module') {
      const fieldCount = operation.fields?.length ?? 0
      return `创建自定义模块“${operation.title.trim()}”（${fieldCount} 个字段）`
    }
    if (operation.action === 'create_custom_module_entry') {
      const schemaId = operationCustomSchemaId(operation) || '未指定模块'
      const details = Object.entries(operation.data ?? {}).map(([field, value]) => {
        const text = Array.isArray(value) ? value.join('、') : String(value)
        return `${field}：${preview(text)}`
      })
      return [`在自定义模块“${schemaId}”中创建条目${operation.title?.trim() ? `“${operation.title.trim()}”` : ''}`, ...details].join('\n')
    }
    if (operation.action === 'update_custom_module_entry') {
      const schemaId = operationCustomSchemaId(operation) || '未指定模块'
      const target = customEntryTarget(operation) || '未指定条目'
      const details = Object.entries(operation.data ?? {}).map(([field, value]) => {
        const text = Array.isArray(value) ? value.join('、') : String(value)
        return `${field}：${preview(text)}`
      })
      return [`更新自定义模块“${schemaId}”中的条目“${target}”`, operation.title?.trim() ? `名称：${preview(operation.title)}` : '', ...details].filter(Boolean).join('\n')
    }
    if (operation.action === 'delete_custom_module_entry') {
      return `删除自定义模块“${operationCustomSchemaId(operation) || '未指定模块'}”中的条目“${customEntryTarget(operation) || '未指定条目'}”`
    }
    if (operation.action === 'create_resource_group') return `在${collectionLabels[operation.collection]}创建折叠栏“${operation.title.trim()}”`
    if (operation.action === 'delete_resource_group') return `删除${collectionLabels[operation.collection]}折叠栏“${operation.target}”；其中条目会保留并移回未分组`
    if (operation.action === 'move_resource_to_group') return operation.groupTarget === null
      ? `将${collectionLabels[operation.collection]}条目“${operation.target}”移回未分组`
      : `将${collectionLabels[operation.collection]}条目“${operation.target}”移入折叠栏“${operation.groupTarget}”`
    if (operation.action === 'create_volume') return `创建分卷“${operation.title.trim()}”（默认展开）`
    if (operation.action === 'create_chapter') {
      const plannedVolume = [...precedingOperations].reverse().find((item) => item.action === 'create_volume')
      const volume = plannedVolume && !operation.volumeId
        ? undefined
        : operation.volumeId
          ? store.value.volumes.find((item) => item.id === operation.volumeId)
          : store.value.volumes.find((item) => item.id === selectedVolumeId.value)
            ?? store.value.volumes.find((item) => item.id === activeChapter.value?.volumeId)
            ?? store.value.volumes[0]
      const association = plannedVolume && !operation.volumeId
        ? `归入新建分卷“${plannedVolume.title.trim()}”`
        : volume ? `归入“${volume.title}”` : `分卷 ID 无效：${operation.volumeId}`
      const body = operation.content?.trim() ?? ''
      if (!body) return `创建章节“${operation.title.trim()}”，${association}，正文为空`
      return `创建章节“${operation.title.trim()}”，${association}，初始正文 ${body.replace(/\s/g, '').length} 字：\n${preview(body, 320)}`
    }
    if (operation.action === 'create_resource') {
      const details = [operation.summary?.trim() ? `摘要：${preview(operation.summary)}` : '', ...Object.entries(operation.fields ?? {}).filter(([field]) => operation.resourceType !== 'style' || !legacyStyleMetadataFields.has(field)).map(([field, value]) => `${field}：${preview(value)}`)].filter(Boolean)
      if (operation.groupTarget !== undefined) details.push(operation.groupTarget === null ? '分组：未分组' : `分组：${operation.groupTarget}`)
      return [`创建${resourceLabels[operation.resourceType]}“${operation.title}”`, ...details].join('\n')
    }
    if (operation.action === 'append_chapter') return `追加 ${operation.content.replace(/\s/g, '').length} 字到章节正文：\n${preview(operation.content, 320)}`
    const parts = [`更新${resourceLabels[operation.resourceType]}“${operation.target}”`]
    if (Object.prototype.hasOwnProperty.call(operation, 'title')) parts.push(`名称：${preview(operation.title ?? '') || '清空'}`)
    if (Object.prototype.hasOwnProperty.call(operation, 'summary')) parts.push(`摘要：${preview(operation.summary ?? '') || '清空'}`)
    if (operation.fields) {
      parts.push(...Object.entries(operation.fields)
        .filter(([field]) => operation.resourceType !== 'style' || !legacyStyleMetadataFields.has(field))
        .map(([field, value]) => `${field}：${preview(value) || '清空'}`))
    }
    if (operation.holdingItems) parts.push(`持有道具：${operation.holdingItems.join('、') || '清空'}`)
    if (operation.holdingSkills) parts.push(`持有技能：${operation.holdingSkills.join('、') || '清空'}`)
    if (operation.reviewStatus) parts.push(`校对状态：${operation.reviewStatus === 'complete' ? '完成' : '待修改'}`)
    if (operation.resourceType === 'world_event') {
      const event = store.value.worldEngine?.events.find((item) => item.id === operation.target)
        ?? store.value.worldEngine?.events.find((item) => item.title.trim() === operation.target.trim())
      if (event?.lockedAll) parts.push('整条目已锁定，Agent 无法修改')
      if (operation.reviewStatus && event?.reviewStatusLocked) parts.push('校对状态已锁定，不会切换')
    } else {
      const target = findResource(operation.resourceType, operation.target)
      if (target) {
        if (isLockedAll(target)) parts.push('整条目已锁定，Agent 无法修改')
        if (operation.reviewStatus && target.reviewStatusLocked) parts.push('校对状态已锁定，不会切换')
        const locked = [
          ...(operation.title ? ['title'] : []),
          ...(operation.summary ? ['summary'] : []),
          ...Object.keys(operation.fields ?? {}),
          ...(operation.holdingItems ? ['holdingItems'] : []),
          ...(operation.holdingSkills ? ['holdingSkills'] : []),
        ].filter((field) => isFieldLocked(target, field))
        if (locked.length) parts.push(`已锁定，不会修改：${[...new Set(locked)].join('、')}`)
      }
    }
    return parts.join('\n')
  }

  return { applyAgentOperation, describeAgentOperation, describeAgentOperationReview }
}
