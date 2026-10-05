import type {
  CustomModuleEntry,
  CustomModuleFieldDefinition,
  CustomModuleFieldType,
  CustomModuleFieldValue,
  CustomModuleSchema,
  CustomModuleStore,
} from '../types'

const fieldTypes: readonly CustomModuleFieldType[] = ['string', 'text', 'longText', 'number', 'enum', 'boolean', 'tags', 'characterIndex', 'itemIndex', 'skillIndex']

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nonEmptyString(value: unknown, fallback: string): string {
  const result = stringValue(value).trim()
  return result || fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))]
}

function fieldDefault(type: CustomModuleFieldType, options: readonly string[] = []): CustomModuleFieldValue {
  if (type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'tags' || type === 'characterIndex' || type === 'itemIndex' || type === 'skillIndex') return []
  if (type === 'enum') return options[0] ?? ''
  return ''
}

function normalizeFieldValue(
  value: unknown,
  field: CustomModuleFieldDefinition,
): CustomModuleFieldValue {
  const fallback = field.defaultValue ?? fieldDefault(field.type, field.options ?? [])
  switch (field.type) {
    case 'number':
      // An empty form value means “not filled yet”; keep it empty instead of
      // forcing the previous/default number back into the input.
      if (value === '') return ''
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
          ? Number(value)
          : typeof fallback === 'number' ? fallback : 0
    case 'boolean':
      return typeof value === 'boolean' ? value : typeof fallback === 'boolean' ? fallback : false
    case 'tags':
    case 'characterIndex':
    case 'itemIndex':
    case 'skillIndex':
      if (Array.isArray(value)) return uniqueStrings(value)
      if (typeof value === 'string') return uniqueStrings(value.split(/[,，、\n]/))
      return Array.isArray(fallback) ? uniqueStrings(fallback) : []
    case 'enum': {
      const options = field.options ?? []
      const candidate = typeof value === 'string' ? value : ''
      if (candidate === '') return ''
      if (candidate && options.includes(candidate)) return candidate
      const defaultValue = typeof fallback === 'string' ? fallback : ''
      return options.includes(defaultValue) ? defaultValue : options[0] ?? ''
    }
    case 'string':
    case 'text':
    case 'longText':
      if (typeof value === 'string') return value
      return typeof fallback === 'string' ? fallback : ''
  }
}

function normalizeField(value: unknown, index: number): CustomModuleFieldDefinition {
  const source = record(value)
  const fallbackKey = `field_${index + 1}`
  const key = nonEmptyString(source.key ?? source.id ?? source.label, fallbackKey)
  const id = nonEmptyString(source.id, key)
  const type = fieldTypes.includes(source.type as CustomModuleFieldType)
    ? source.type as CustomModuleFieldType
    : 'string'
  const options = type === 'enum' ? uniqueStrings(source.options) : undefined
  const defaultCandidate = source.defaultValue
  const field: CustomModuleFieldDefinition = {
    id,
    key,
    label: nonEmptyString(source.label, key),
    type,
    description: typeof source.description === 'string' ? source.description : undefined,
    promptHint: typeof source.promptHint === 'string' ? source.promptHint : undefined,
    required: source.required === true,
    options,
    placeholder: typeof source.placeholder === 'string' ? source.placeholder : undefined,
    locked: source.locked === true,
  }
  const defaultValue = normalizeFieldValue(defaultCandidate, {
    ...field,
    defaultValue: undefined,
  })
  if (defaultCandidate !== undefined) field.defaultValue = defaultValue
  return field
}

/** True when a value names one of the supported custom field primitives. */
export function isCustomModuleFieldType(value: unknown): value is CustomModuleFieldType {
  return typeof value === 'string' && fieldTypes.includes(value as CustomModuleFieldType)
}

/** Normalize a schema loaded from local storage or an AI response. */
export function normalizeCustomModuleSchema(input: unknown, now = Date.now()): CustomModuleSchema {
  const source = record(input)
  const rawFields = Array.isArray(source.fields)
    ? source.fields
    : Object.entries(record(source.fields)).map(([key, value]) => ({
        key,
        ...(record(value)),
        ...(value !== null && typeof value !== 'object' ? { defaultValue: value } : {}),
      }))
  const fields: CustomModuleFieldDefinition[] = []
  const keys = new Set<string>()
  rawFields.forEach((value, index) => {
    const field = normalizeField(value, index)
    if (keys.has(field.key)) return
    keys.add(field.key)
    fields.push(field)
  })
  const id = nonEmptyString(source.id, `custom-module-${now}`)
  const title = nonEmptyString(source.title ?? source.name ?? source.type, '未命名模块')
  const type = nonEmptyString(source.type, title)
  const requestedTitleField = typeof source.titleField === 'string' ? source.titleField : undefined
  const titleField = requestedTitleField && fields.some((field) => field.key === requestedTitleField)
    ? requestedTitleField
    : fields[0]?.key
  return {
    id,
    type,
    title,
    description: stringValue(source.description),
    fields,
    titleField,
    version: Math.max(1, Math.floor(numberValue(source.version, 1))),
    createdAt: numberValue(source.createdAt, now),
    updatedAt: numberValue(source.updatedAt, now),
    lockedAll: source.lockedAll === true,
  }
}

/** Return the value a form should show before a user has filled a field. */
export function defaultCustomModuleFieldValue(field: CustomModuleFieldDefinition): CustomModuleFieldValue {
  return field.defaultValue === undefined
    ? fieldDefault(field.type, field.options ?? [])
    : normalizeFieldValue(field.defaultValue, field)
}

/** Normalize data against a schema, including defaults and enum validation. */
export function normalizeCustomModuleData(
  input: unknown,
  schema: CustomModuleSchema,
): Record<string, CustomModuleFieldValue> {
  const source = record(input)
  return Object.fromEntries(schema.fields.map((field) => [
    field.key,
    normalizeFieldValue(source[field.key], field),
  ]))
}

/** Normalize one concrete row/card loaded from storage or returned by an AI. */
export function normalizeCustomModuleEntry(
  input: unknown,
  schema: CustomModuleSchema,
  now = Date.now(),
): CustomModuleEntry {
  const source = record(input)
  const data = normalizeCustomModuleData(source.data, schema)
  const titleValue = schema.titleField ? data[schema.titleField] : undefined
  const title = typeof source.title === 'string'
    ? source.title.trim()
    : typeof titleValue === 'string' && titleValue.trim()
      ? titleValue.trim()
      : undefined
  return {
    id: nonEmptyString(source.id, `custom-entry-${now}`),
    schemaId: nonEmptyString(source.schemaId, schema.id),
    title,
    data,
    createdAt: numberValue(source.createdAt, now),
    updatedAt: numberValue(source.updatedAt, now),
    lockedAll: source.lockedAll === true,
    lockedFields: uniqueStrings(source.lockedFields),
  }
}

/** Create an empty row/card using all schema defaults. */
export function createCustomModuleEntry(
  schema: CustomModuleSchema,
  values: Record<string, unknown> = {},
  now = Date.now(),
): CustomModuleEntry {
  return normalizeCustomModuleEntry({
    id: `custom-entry-${now}-${Math.random().toString(36).slice(2, 8)}`,
    schemaId: schema.id,
    data: values,
    createdAt: now,
    updatedAt: now,
  }, schema, now)
}

/** Build the compact JSON payload shown to an AI when it must fill a module. */
export function customModuleExamplePayload(
  schema: CustomModuleSchema,
  values: Record<string, unknown> = {},
  id = 'example-entry',
): { type: string; id: string; data: Record<string, CustomModuleFieldValue> } {
  const entry = normalizeCustomModuleEntry({ id, schemaId: schema.id, data: values }, schema)
  return { type: schema.type, id: entry.id, data: entry.data }
}

/** Build a JSON-serializable contract containing field descriptions and an example. */
export function customModulePromptContract(
  schema: CustomModuleSchema,
  values: Record<string, unknown> = {},
  options: { includePromptHints?: boolean } = {},
): { schema: UnknownRecord; example: { type: string; id: string; data: Record<string, CustomModuleFieldValue> } } {
  const includePromptHints = options.includePromptHints !== false
  return {
    schema: {
      type: 'object',
      moduleType: schema.type,
      moduleId: schema.id,
      description: schema.description,
      additionalProperties: false,
      required: schema.fields.filter((field) => field.required).map((field) => field.key),
      properties: Object.fromEntries(schema.fields.map((field) => {
        const baseDescription = field.description || field.label
        const promptHint = includePromptHints ? field.promptHint?.trim() : ''
        const property: UnknownRecord = {
            type: field.type === 'tags' || field.type === 'characterIndex' || field.type === 'itemIndex' || field.type === 'skillIndex'
            ? 'array'
            : field.type === 'enum'
              ? 'string'
              : field.type === 'number' || field.type === 'boolean'
                ? field.type
                : 'string',
          description: promptHint
            ? `${baseDescription}；强化提示：${promptHint}`
            : baseDescription,
        }
        if (promptHint) property['x-promptHint'] = promptHint
        if (field.type === 'number') {
          property.type = ['number', 'string']
          property.description = `${property.description}；空字符串表示未填写`
        }
        if (field.type === 'tags') property.items = { type: 'string', description: '用户自定义标签' }
        if (field.type === 'characterIndex') {
          property.items = { type: 'string', description: '角色卡 ID' }
          property['x-referenceCollection'] = 'characters'
        }
        if (field.type === 'itemIndex') {
          property.items = { type: 'string', description: '道具卡 ID' }
          property['x-referenceCollection'] = 'items'
        }
        if (field.type === 'skillIndex') {
          property.items = { type: 'string', description: '技能卡 ID' }
          property['x-referenceCollection'] = 'skills'
        }
        if (field.type === 'enum') {
          property.enum = ['', ...(field.options ?? [])]
          property.description = `${property.description}；空字符串表示未选择`
        }
        return [field.key, property]
      })),
    },
    example: customModuleExamplePayload(schema, values),
  }
}

/** Pretty JSON text suitable for a prompt, preview, or copy button. */
export function customModulePromptJson(
  schema: CustomModuleSchema,
  values: Record<string, unknown> = {},
): string {
  return JSON.stringify(customModulePromptContract(schema, values), null, 2)
}

/** A ready-to-use experimental schema matching the user's 势力卡 example. */
export const defaultCustomModuleSchema: CustomModuleSchema = normalizeCustomModuleSchema({
  id: 'custom-faction',
  type: '势力卡',
  title: '势力卡',
  description: '用于记录宗门、家族、组织、皇朝等势力及其当前状态。',
  titleField: '名称',
  fields: [
    { id: 'name', key: '名称', label: '势力名称', type: 'string', required: true, description: '这里填势力名称' },
    { id: 'scale', key: '势力等级', label: '势力规模', type: 'number', description: '这里填势力规模' },
    { id: 'kind', key: '势力性质', label: '势力类型', type: 'enum', options: ['宗门', '皇朝', '家族', '组织', '商会', '其他'], description: '这里填势力类型' },
    { id: 'status', key: '当前状态', label: '势力状态', type: 'text', description: '这里填势力状态' },
    { id: 'major-characters', key: '主要人物', label: '主要人物', type: 'tags', description: '这里填势力主要人物' },
  ],
}, 0)

export const defaultCustomModuleEntry: CustomModuleEntry = normalizeCustomModuleEntry({
  id: 'tianxuan',
  schemaId: defaultCustomModuleSchema.id,
  data: { 名称: '天玄宗', 势力等级: 5, 势力性质: '宗门', 当前状态: '正在封山', 主要人物: ['叶青', '沈寒'] },
}, defaultCustomModuleSchema, 0)

/** Start an experimental custom-module collection with the example schema. */
export function createDefaultCustomModuleStore(now = Date.now()): CustomModuleStore {
  const schema = {
    ...normalizeCustomModuleSchema(defaultCustomModuleSchema, now),
    createdAt: now,
    updatedAt: now,
  }
  const entry = {
    ...normalizeCustomModuleEntry(defaultCustomModuleEntry, schema, now),
    createdAt: now,
    updatedAt: now,
  }
  return { schemas: [schema], entries: [entry] }
}

/** Normalize the aggregate shape at persistence boundaries. */
export function normalizeCustomModuleStore(input: unknown, now = Date.now()): CustomModuleStore {
  const source = record(input)
  const rawSchemas = Array.isArray(source.schemas) ? source.schemas : []
  const schemas = rawSchemas.map((schema, index) => normalizeCustomModuleSchema(schema, now + index))
  const entries: CustomModuleEntry[] = []
  const rawEntries = Array.isArray(source.entries) ? source.entries : []
  rawEntries.forEach((entry, index) => {
    const raw = record(entry)
    const schema = schemas.find((candidate) => candidate.id === raw.schemaId)
    if (!schema) return
    entries.push(normalizeCustomModuleEntry(entry, schema, now + index))
  })
  return { schemas, entries }
}

