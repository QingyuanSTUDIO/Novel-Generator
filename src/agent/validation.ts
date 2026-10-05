import type {
  AgentOperation,
  AgentResourceType,
  AgentResponse,
  GroupedResourceCollection,
  WebSearchEngine,
} from './schema'
import type {
  CustomModuleFieldType,
  CustomModuleFieldValue,
  CustomModuleSchema,
} from '../types'
import { normalizeAgentResourceFields, unknownAgentResourceFields } from './resourceFieldPolicy.ts'

type ValidationResult =
  | { ok: true; value: AgentResponse }
  | { ok: false; error: string }

const resourceTypes: AgentResourceType[] = [
  'world',
  'character',
  'item',
  'skill',
  'outline',
  'world_event',
  'style',
]

const groupedResourceCollections: GroupedResourceCollection[] = ['world', 'characters', 'items', 'skills', 'style']
const groupedResourceTypes: AgentResourceType[] = ['world', 'character', 'item', 'skill', 'style']
const webSearchEngines: WebSearchEngine[] = ['bing', 'google', 'duckduckgo']
const customModuleFieldTypes: CustomModuleFieldType[] = [
  'string',
  'text',
  'longText',
  'number',
  'enum',
  'boolean',
  'tags',
  'characterIndex',
  'itemIndex',
  'skillIndex',
]

const operationProperties: Record<AgentOperation['action'], string[]> = {
  search_web_memes: ['action', 'engine', 'query', 'limit'],
  create_resource: ['action', 'resourceType', 'title', 'summary', 'fields', 'includeAllFields', 'holdingItems', 'holdingSkills', 'groupTarget'],
  update_resource: ['action', 'resourceType', 'target', 'title', 'summary', 'fields', 'holdingItems', 'holdingSkills', 'reviewStatus'],
  create_resource_group: ['action', 'collection', 'title'],
  delete_resource_group: ['action', 'collection', 'target'],
  move_resource_to_group: ['action', 'collection', 'target', 'groupTarget'],
  create_chapter: ['action', 'title', 'volumeId', 'content'],
  create_volume: ['action', 'title'],
  append_chapter: ['action', 'chapterId', 'content'],
  create_custom_module: ['action', 'title', 'id', 'type', 'description', 'fields', 'titleField'],
  create_custom_module_entry: ['action', 'schemaId', 'moduleId', 'id', 'title', 'data'],
  update_custom_module_entry: ['action', 'schemaId', 'moduleId', 'target', 'id', 'title', 'data'],
  delete_custom_module_entry: ['action', 'schemaId', 'moduleId', 'target', 'id'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every((item) => item.trim().length > 0)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

function isCustomModuleValue(value: unknown): value is CustomModuleFieldValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function validateCustomValueForType(
  value: unknown,
  fieldType: CustomModuleFieldType,
  options: readonly string[] | undefined,
  path: string,
): string | null {
  if (fieldType === 'number') {
    if (value === '') return null
    return typeof value === 'number' && Number.isFinite(value)
      ? null
      : `${path} 必须是有限数字`
  }
  if (fieldType === 'boolean') {
    return typeof value === 'boolean' ? null : `${path} 必须是布尔值`
  }
  if (fieldType === 'tags' || fieldType === 'characterIndex' || fieldType === 'itemIndex' || fieldType === 'skillIndex') {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? null
      : `${path} 必须是字符串数组`
  }
  if (fieldType === 'enum') {
    if (typeof value !== 'string') return `${path} 必须是字符串`
    if (value === '') return null
    if (options?.length && !options.includes(value)) {
      return `${path} 必须是枚举选项之一`
    }
    return null
  }
  return typeof value === 'string' ? null : `${path} 必须是字符串`
}

function validateCustomModuleFieldDefinition(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} 必须是对象`
  const allowed = ['id', 'key', 'label', 'type', 'description', 'promptHint', 'required', 'defaultValue', 'options', 'placeholder', 'locked']
  if (!hasOnlyKeys(value, allowed)) return `${path} 包含不支持的属性`
  if (typeof value.key !== 'string' || !value.key.trim()) return `${path}.key 必须是非空字符串`
  if (typeof value.type !== 'string' || !customModuleFieldTypes.includes(value.type as CustomModuleFieldType)) {
    return `${path}.type 不是支持的自定义字段类型`
  }
  for (const key of ['id', 'label', 'description', 'promptHint', 'placeholder']) {
    const error = validateOptionalString(value, key, path)
    if (error) return error
    if (typeof value[key] === 'string' && !value[key].trim()) return `${path}.${key} 不能是空字符串`
  }
  for (const key of ['required', 'locked']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return `${path}.${key} 必须是布尔值`
  }
  if (value.options !== undefined) {
    if (!isStringArray(value.options)) return `${path}.options 必须是字符串数组`
    if (value.type !== 'enum') return `${path}.options 只有 enum 字段可以使用`
    if (value.options.some((option) => !option.trim())) return `${path}.options 不能包含空字符串`
    if (new Set(value.options).size !== value.options.length) return `${path}.options 不能包含重复选项`
  }
  if (value.type === 'enum' && (!Array.isArray(value.options) || value.options.length === 0)) {
    return `${path}.options 必须为 enum 字段提供至少一个选项`
  }
  if (value.defaultValue !== undefined) {
    const error = validateCustomValueForType(
      value.defaultValue,
      value.type as CustomModuleFieldType,
      value.options as string[] | undefined,
      `${path}.defaultValue`,
    )
    if (error) return error
  }
  return null
}

function validateCustomModuleReference(
  operation: Record<string, unknown>,
  path: string,
  schemas?: readonly CustomModuleSchema[],
): { id?: string; schema?: CustomModuleSchema; error?: string } {
  for (const key of ['schemaId', 'moduleId']) {
    const error = validateOptionalString(operation, key, path)
    if (error) return { error }
    if (typeof operation[key] === 'string' && !operation[key].trim()) {
      return { error: `${path}.${key} 不能是空字符串` }
    }
  }
  const schemaId = typeof operation.schemaId === 'string' ? operation.schemaId.trim() : undefined
  const moduleId = typeof operation.moduleId === 'string' ? operation.moduleId.trim() : undefined
  if (!schemaId && !moduleId) {
    return { error: `${path}.schemaId 或 ${path}.moduleId 至少提供一个` }
  }
  if (schemaId && moduleId && schemaId !== moduleId) {
    return { error: `${path}.schemaId 与 ${path}.moduleId 不能指向不同模块` }
  }
  const id = schemaId ?? moduleId
  const schema = schemas?.find((candidate) => candidate.id === id)
  if (schemas && !schema) return { error: `${path} 指向的自定义模块不存在` }
  return { id, schema }
}

function validateCustomModuleData(
  value: unknown,
  path: string,
  schema?: CustomModuleSchema,
  requireRequiredFields = false,
): string | null {
  if (!isRecord(value)) return `${path} 必须是对象`
  const fieldsByKey = new Map((schema?.fields ?? []).map((field) => [field.key, field]))
  for (const [key, item] of Object.entries(value)) {
    if (!isCustomModuleValue(item)) {
      return `${path}.${key} 必须是字符串、数字、布尔值或字符串数组`
    }
    const field = fieldsByKey.get(key)
    if (schema && !field) return `${path}.${key} 不是当前自定义模块定义的字段`
    if (field) {
      const error = validateCustomValueForType(item, field.type, field.options, `${path}.${key}`)
      if (error) return error
    }
  }
  if (schema && requireRequiredFields) {
    for (const field of schema.fields) {
      if (field.required && !Object.prototype.hasOwnProperty.call(value, field.key)) {
        return `${path}.${field.key} 是必填字段`
      }
    }
  }
  return null
}

function validateOptionalString(operation: Record<string, unknown>, key: string, path: string): string | null {
  if (operation[key] !== undefined && typeof operation[key] !== 'string') {
    return `${path}.${key} 必须是字符串`
  }
  return null
}

function validateGroupTarget(value: unknown, path: string): string | null {
  if (value !== null && (typeof value !== 'string' || !value.trim())) {
    return `${path}.groupTarget 必须是非空字符串或 null`
  }
  return null
}

function validateOperation(
  value: unknown,
  index: number,
  validVolumeIds?: ReadonlySet<string>,
  validCustomModuleSchemas?: readonly CustomModuleSchema[],
): string | null {
  const path = `operations[${index}]`
  if (!isRecord(value)) return `${path} 必须是对象`
  if (typeof value.action !== 'string' || !Object.prototype.hasOwnProperty.call(operationProperties, value.action)) {
    return `${path}.action 不受支持`
  }

  const action = value.action as AgentOperation['action']
  if (action === 'search_web_memes') {
    if (!hasOnlyKeys(value, operationProperties[action])) {
      return `${path} 包含不支持的属性`
    }
    if (!['bing', 'google', 'duckduckgo'].includes(value.engine as string)) return `${path}.engine 不是支持的搜索引擎`
    if (typeof value.query !== 'string' || !value.query.trim()) return `${path}.query 必须是非空字符串`
    if (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 30) return `${path}.limit 必须是 1 到 30 的整数`
    return null
  }
  if (!hasOnlyKeys(value, operationProperties[action])) {
    return `${path} 包含不支持的属性`
  }

  if (action === 'create_custom_module') {
    if (typeof value.title !== 'string' || !value.title.trim()) return `${path}.title 必须是非空字符串`
    for (const key of ['id', 'type', 'description', 'titleField']) {
      const error = validateOptionalString(value, key, path)
      if (error) return error
      if (typeof value[key] === 'string' && !value[key].trim()) return `${path}.${key} 不能是空字符串`
    }
    if (value.fields === undefined) return `${path}.fields 必须至少定义一个字段`
    if (!Array.isArray(value.fields)) return `${path}.fields 必须是数组`
    if (value.fields.length === 0) return `${path}.fields 必须至少定义一个字段`
    const keys = new Set<string>()
    const ids = new Set<string>()
    for (let fieldIndex = 0; fieldIndex < value.fields.length; fieldIndex += 1) {
      const field = value.fields[fieldIndex]
      const error = validateCustomModuleFieldDefinition(field, `${path}.fields[${fieldIndex}]`)
      if (error) return error
      const key = ((field as Record<string, unknown>).key as string).trim()
      if (keys.has(key)) return `${path}.fields 不允许重复 key：${key}`
      keys.add(key)
      const fieldId = (field as Record<string, unknown>).id
      if (typeof fieldId === 'string' && fieldId.trim()) {
        if (ids.has(fieldId.trim())) return `${path}.fields 不允许重复 id：${fieldId.trim()}`
        ids.add(fieldId.trim())
      }
    }
    if (value.titleField !== undefined && !keys.has((value.titleField as string).trim())) {
      return `${path}.titleField 必须引用 fields 中存在的 key`
    }
    return null
  }

  if (
    action === 'create_custom_module_entry'
    || action === 'update_custom_module_entry'
    || action === 'delete_custom_module_entry'
  ) {
    const moduleReference = validateCustomModuleReference(value, path, validCustomModuleSchemas)
    if (moduleReference.error) return moduleReference.error
    if (action === 'delete_custom_module_entry') {
      const target = typeof value.target === 'string' ? value.target.trim() : ''
      const id = typeof value.id === 'string' ? value.id.trim() : ''
      if (!target && !id) return `${path}.target 或 ${path}.id 至少提供一个`
      if (target && id && target !== id) return `${path}.target 与 ${path}.id 不能指向不同条目`
      return null
    }
    if (action === 'create_custom_module_entry') {
      if (value.id !== undefined && (typeof value.id !== 'string' || !value.id.trim())) return `${path}.id 必须是非空字符串`
      if (value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim())) return `${path}.title 必须是非空字符串`
      if (!Object.prototype.hasOwnProperty.call(value, 'data')) return `${path}.data 必填`
      return validateCustomModuleData(value.data, `${path}.data`, moduleReference.schema, true)
    }
    const target = typeof value.target === 'string' ? value.target.trim() : ''
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    if (!target && !id) return `${path}.target 或 ${path}.id 至少提供一个`
    if (target && id && target !== id) return `${path}.target 与 ${path}.id 不能指向不同条目`
    if (value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim())) return `${path}.title 必须是非空字符串`
    if (value.data === undefined && value.title === undefined) return `${path} 至少提供 title 或 data 之一`
    if (value.data === undefined) return null
    return validateCustomModuleData(value.data, `${path}.data`, moduleReference.schema)
  }

  if (action === 'append_chapter') {
    if (typeof value.content !== 'string' || !value.content.trim()) return `${path}.content 必须是非空字符串`
    return validateOptionalString(value, 'chapterId', path)
  }

  if (action === 'create_chapter' || action === 'create_volume') {
    if (typeof value.title !== 'string' || !value.title.trim()) return `${path}.title 必须是非空字符串`
    if (action === 'create_volume') return null
    const volumeError = validateOptionalString(value, 'volumeId', path)
    if (volumeError) return volumeError
    if (typeof value.volumeId === 'string' && validVolumeIds && !validVolumeIds.has(value.volumeId)) {
      return `${path}.volumeId 不是当前作品中的有效分卷 ID`
    }
    return validateOptionalString(value, 'content', path)
  }

  if (action === 'create_resource_group' || action === 'delete_resource_group' || action === 'move_resource_to_group') {
    if (typeof value.collection !== 'string' || !groupedResourceCollections.includes(value.collection as GroupedResourceCollection)) {
      return `${path}.collection 不是支持折叠栏的资源栏目`
    }
    if (action === 'create_resource_group') {
      if (typeof value.title !== 'string' || !value.title.trim()) return `${path}.title 必须是非空字符串`
      return null
    }
    if (typeof value.target !== 'string' || !value.target.trim()) return `${path}.target 必须是非空字符串`
    if (action === 'delete_resource_group') return null
    if (!Object.prototype.hasOwnProperty.call(value, 'groupTarget')) {
      return `${path}.groupTarget 必须是非空字符串或 null`
    }
    return validateGroupTarget(value.groupTarget, path)
  }

  if (typeof value.resourceType !== 'string' || !resourceTypes.includes(value.resourceType as AgentResourceType)) {
    return `${path}.resourceType 不是支持的资源类型`
  }

  const identityKey = action === 'create_resource' ? 'title' : 'target'
  if (typeof value[identityKey] !== 'string') return `${path}.${identityKey} 必须是字符串`
  if (action === 'create_resource' && typeof value.title === 'string' && !value.title.trim()) return `${path}.title 必须是非空字符串`

  for (const key of ['summary', 'title', 'target']) {
    const error = validateOptionalString(value, key, path)
    if (error) return error
  }

  if (value.fields !== undefined && !isStringRecord(value.fields)) {
    return `${path}.fields 必须是字符串到字符串的对象`
  }
  if (value.includeAllFields !== undefined && typeof value.includeAllFields !== 'boolean') {
    return `${path}.includeAllFields 必须是布尔值`
  }
  const normalizedFields = value.fields === undefined
    ? undefined
    : normalizeAgentResourceFields(value.resourceType as AgentResourceType, value.fields)
  if (action === 'create_resource' && normalizedFields !== undefined) {
    const unknownFields = unknownAgentResourceFields(value.resourceType as AgentResourceType, normalizedFields)
    if (unknownFields.length) {
      return `${path}.fields 包含标准${value.resourceType === 'world' ? '世界书' : '卡片'}不支持的字段：${unknownFields.join('、')}。如需独立字段结构，请先使用 create_custom_module，再使用 create_custom_module_entry。`
    }
  }
  if (value.holdingItems !== undefined && !isStringArray(value.holdingItems)) {
    return `${path}.holdingItems 必须是字符串数组`
  }
  if (value.holdingSkills !== undefined && !isStringArray(value.holdingSkills)) {
    return `${path}.holdingSkills 必须是字符串数组`
  }
  if (value.holdingItems !== undefined && !isNonEmptyStringArray(value.holdingItems)) {
    return `${path}.holdingItems 不能包含空字符串`
  }
  if (value.holdingSkills !== undefined && !isNonEmptyStringArray(value.holdingSkills)) {
    return `${path}.holdingSkills 不能包含空字符串`
  }
  if (
    (value.holdingItems !== undefined || value.holdingSkills !== undefined)
    && value.resourceType !== 'character'
  ) {
    return `${path}.holdingItems/holdingSkills 只有角色资源可以使用`
  }
  if (value.reviewStatus !== undefined && value.reviewStatus !== 'pending' && value.reviewStatus !== 'complete') {
    return `${path}.reviewStatus 只允许“pending”或“complete”`
  }
  if (value.groupTarget !== undefined) {
    const groupTargetError = validateGroupTarget(value.groupTarget, path)
    if (groupTargetError) return groupTargetError
    if (!groupedResourceTypes.includes(value.resourceType as AgentResourceType)) {
      return `${path}.groupTarget 仅支持世界书、角色、道具、技能和文风规则`
    }
  }

  const fields = normalizedFields
  if (value.resourceType === 'character' && fields?.['角色身份'] !== undefined
    && !['主角', '配角', '路人'].includes(fields['角色身份'])) {
    return `${path}.fields.角色身份 只允许“主角”“配角”或“路人”`
  }
  if (value.resourceType === 'skill' && fields?.['技能性质'] !== undefined
    && !['主动', '被动'].includes(fields['技能性质'])) {
    return `${path}.fields.技能性质 只允许“主动”或“被动”`
  }

  return null
}

function operationReference(
  operation: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = operation[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function customSchemaReference(operation: Record<string, unknown>): string {
  return operationReference(operation, ['schemaId', 'moduleId'])
}

function customEntryReference(operation: Record<string, unknown>): string {
  return operationReference(operation, ['target', 'id'])
}

/**
 * Reject plans that contain two operations which target the same concrete
 * object but cannot be safely ordered. The executor is intentionally
 * sequential, so silently applying e.g. an update after a delete would make
 * the final state depend on model ordering rather than the user's intent.
 */
function validateOperationConflicts(operations: unknown[]): string | null {
  const records = operations.filter(isRecord)
  for (let firstIndex = 0; firstIndex < records.length; firstIndex += 1) {
    const first = records[firstIndex]
    for (let secondIndex = firstIndex + 1; secondIndex < records.length; secondIndex += 1) {
      const second = records[secondIndex]
      const firstAction = first.action
      const secondAction = second.action

      if (
        firstAction === 'create_custom_module'
        && secondAction === 'create_custom_module'
        && typeof first.id === 'string'
        && typeof second.id === 'string'
        && first.id.trim()
        && first.id.trim() === second.id.trim()
      ) {
        return `operations[${secondIndex}] 与 operations[${firstIndex}] 重复创建同一个自定义模块 ID`
      }

      const firstSchema = customSchemaReference(first)
      const secondSchema = customSchemaReference(second)
      const sameSchema = Boolean(firstSchema && secondSchema && firstSchema === secondSchema)
      if (sameSchema) {
        const firstEntry = customEntryReference(first)
        const secondEntry = customEntryReference(second)
        const sameEntry = Boolean(firstEntry && secondEntry && firstEntry === secondEntry)
        if (sameEntry) {
          const deletes = firstAction === 'delete_custom_module_entry' || secondAction === 'delete_custom_module_entry'
          if (deletes) {
            return `operations[${secondIndex}] 与 operations[${firstIndex}] 同时修改/删除自定义模块条目“${firstEntry}”，计划存在冲突`
          }
          if (
            firstAction === 'create_custom_module_entry'
            && secondAction === 'create_custom_module_entry'
          ) {
            return `operations[${secondIndex}] 与 operations[${firstIndex}] 重复创建自定义模块条目“${firstEntry}”`
          }
        }
      }

      if (
        firstAction === 'search_web_memes'
        && secondAction === 'search_web_memes'
        && first.engine === second.engine
        && typeof first.query === 'string'
        && typeof second.query === 'string'
        && first.query.trim().toLocaleLowerCase() === second.query.trim().toLocaleLowerCase()
      ) {
        return `operations[${secondIndex}] 与 operations[${firstIndex}] 重复搜索相同关键词`
      }
    }
  }
  return null
}

function schemaFromCreateOperation(operation: Record<string, unknown>): CustomModuleSchema | undefined {
  const id = typeof operation.id === 'string' ? operation.id.trim() : ''
  const title = typeof operation.title === 'string' ? operation.title.trim() : ''
  if (!id || !title) return undefined
  const rawFields = Array.isArray(operation.fields) ? operation.fields : []
  const fields = rawFields
    .filter(isRecord)
    .map((field, index) => ({
      id: typeof field.id === 'string' && field.id.trim() ? field.id.trim() : field.key as string || `field_${index + 1}`,
      key: (field.key as string).trim(),
      label: typeof field.label === 'string' && field.label.trim() ? field.label.trim() : (field.key as string).trim(),
      type: field.type as CustomModuleFieldType,
      description: typeof field.description === 'string' ? field.description : undefined,
      promptHint: typeof field.promptHint === 'string' ? field.promptHint : undefined,
      required: field.required === true,
      defaultValue: field.defaultValue as CustomModuleFieldValue | undefined,
      options: Array.isArray(field.options) ? field.options.filter((option): option is string => typeof option === 'string') : undefined,
      placeholder: typeof field.placeholder === 'string' ? field.placeholder : undefined,
      locked: field.locked === true,
    }))
  return {
    id,
    type: typeof operation.type === 'string' && operation.type.trim() ? operation.type.trim() : title,
    title,
    description: typeof operation.description === 'string' ? operation.description : '',
    fields,
    titleField: typeof operation.titleField === 'string' ? operation.titleField.trim() : undefined,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** Validate an unknown model response without dropping malformed operations. */
export function validateAgentResponse(
  value: unknown,
  validVolumeIds?: ReadonlySet<string>,
  validCustomModuleSchemas?: readonly CustomModuleSchema[],
): ValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'Agent 响应必须是对象' }
  if (!hasOnlyKeys(value, ['message', 'operations'])) {
    return { ok: false, error: 'Agent 响应包含不支持的属性' }
  }
  if (typeof value.message !== 'string' || !value.message.trim()) {
    return { ok: false, error: 'message 必须是非空字符串' }
  }
  if (!Array.isArray(value.operations)) {
    return { ok: false, error: 'operations 必须是数组' }
  }
  if (value.operations.length > 50) {
    return { ok: false, error: 'operations 最多允许 50 项，请拆分任务后再执行' }
  }

  // Keep a local view so a single response may create a schema and then create
  // entries in that schema. If no schemas were supplied by the caller, values
  // remain generically validated until a response creates a schema with an ID.
  const customSchemaContextEnabled = validCustomModuleSchemas !== undefined
  const customSchemas = validCustomModuleSchemas ? [...validCustomModuleSchemas] : []
  for (let index = 0; index < value.operations.length; index += 1) {
    const schemaContext = customSchemaContextEnabled || customSchemas.length ? customSchemas : undefined
    const error = validateOperation(value.operations[index], index, validVolumeIds, schemaContext)
    if (error) return { ok: false, error }
    const operation = value.operations[index]
    if (isRecord(operation) && operation.action === 'create_custom_module') {
      const schema = schemaFromCreateOperation(operation)
      if (schema && !customSchemas.some((candidate) => candidate.id === schema.id)) customSchemas.push(schema)
    }
  }

  const conflict = validateOperationConflicts(value.operations)
  if (conflict) return { ok: false, error: conflict }

  return { ok: true, value: value as AgentResponse }
}

