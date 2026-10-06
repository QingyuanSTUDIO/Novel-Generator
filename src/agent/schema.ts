import type {
  CustomModuleFieldDefinition,
  CustomModuleFieldType,
  CustomModuleFieldValue,
  OutlineNodeType,
} from '../types'

export type AgentResourceType = 'world' | 'character' | 'item' | 'skill' | 'outline' | 'world_event' | 'style'
export type GroupedResourceCollection = 'world' | 'characters' | 'items' | 'skills' | 'style'
export type WebSearchEngine = 'bing' | 'google' | 'duckduckgo'

/** Field definitions accepted when an Agent creates a custom module schema. */
export type AgentCustomModuleField = Partial<Omit<CustomModuleFieldDefinition, 'key' | 'type'>> & {
  key: string
  type: CustomModuleFieldType
}

/** Values in a custom-module row. Nested objects are deliberately not supported. */
export type AgentCustomModuleData = Record<string, CustomModuleFieldValue>

export type AgentOperation =
  | {
      /** Search the public web, summarize current meme results, and save them to the dedicated meme table. */
      action: 'search_web_memes'
      engine: WebSearchEngine
      query: string
      limit: number
    }
  | {
      action: 'create_resource'
      resourceType: AgentResourceType
      title: string
      summary?: string
      fields?: Record<string, string>
      /** Explicit full-template hint. When true, the model should return every standard field. */
      includeAllFields?: boolean
      holdingItems?: string[]
      holdingSkills?: string[]
      groupTarget?: string | null
      outlineType?: OutlineNodeType
      outlineParentId?: string
      outlineStartChapterId?: string
      outlineEndChapterId?: string
      outlineCollapsed?: boolean
    }
  | {
      action: 'update_resource'
      resourceType: AgentResourceType
      target: string
      title?: string
      summary?: string
      fields?: Record<string, string>
      holdingItems?: string[]
      holdingSkills?: string[]
      reviewStatus?: 'pending' | 'complete'
      outlineType?: OutlineNodeType
      outlineParentId?: string
      outlineStartChapterId?: string
      outlineEndChapterId?: string
      outlineCollapsed?: boolean
    }
  | {
      action: 'create_resource_group'
      collection: GroupedResourceCollection
      title: string
    }
  | {
      action: 'delete_resource_group'
      collection: GroupedResourceCollection
      target: string
    }
  | {
      action: 'move_resource_to_group'
      collection: GroupedResourceCollection
      target: string
      groupTarget: string | null
    }
  | {
      action: 'create_chapter'
      title: string
      volumeId?: string
      content?: string
    }
  | {
      action: 'create_volume'
      title: string
    }
  | {
      action: 'append_chapter'
      chapterId?: string
      content: string
    }
  | {
      /** Create a user-defined JSON/table schema for later custom-module entries. */
      action: 'create_custom_module'
      title: string
      id?: string
      type?: string
      description?: string
      fields?: AgentCustomModuleField[]
      titleField?: string
    }
  | {
      /** Create one row/card using an existing custom-module schema. */
      action: 'create_custom_module_entry'
      schemaId?: string
      moduleId?: string
      id?: string
      title?: string
      data: AgentCustomModuleData
    }
  | {
      /** Update an existing custom-module row/card. Data is partial so a title-only edit is valid. */
      action: 'update_custom_module_entry'
      schemaId?: string
      moduleId?: string
      target?: string
      id?: string
      title?: string
      data?: AgentCustomModuleData
    }
  | {
      /** Delete an existing custom-module row/card. */
      action: 'delete_custom_module_entry'
      schemaId?: string
      moduleId?: string
      target?: string
      id?: string
    }

export type AgentResponse = {
  message: string
  operations: AgentOperation[]
}

const customModuleValueSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array', items: { type: 'string' } },
  ],
  description: '自定义模块字段值：字符串、数字、布尔值或字符串数组',
} as const

const customModuleFieldSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'type'],
  properties: {
    id: { type: 'string', minLength: 1, description: '字段稳定 ID；省略时由桌面端生成' },
    key: { type: 'string', minLength: 1, description: '写入条目 data 的字段名' },
    label: { type: 'string', minLength: 1, description: '界面显示名称；省略时使用 key' },
    type: {
      enum: ['string', 'text', 'longText', 'number', 'enum', 'boolean', 'tags', 'characterIndex', 'itemIndex', 'skillIndex'],
      description: '字段类型',
    },
    description: { type: 'string' },
    promptHint: { type: 'string', description: '作者提供给 AI 的字段填写强化提示' },
    required: { type: 'boolean' },
    defaultValue: customModuleValueSchema,
    options: { type: 'array', items: { type: 'string' }, description: 'enum 字段的选项' },
    placeholder: { type: 'string' },
    locked: { type: 'boolean', description: '锁定后 Agent 不得改写此字段' },
  },
} as const

const customModuleDataSchema = {
  type: 'object',
  additionalProperties: customModuleValueSchema,
  description: '字段名到字段值的映射；字段名应来自对应自定义模块 schema',
} as const

const customModuleReferenceProperties = {
  schemaId: { type: 'string', minLength: 1, description: '自定义模块 schema ID' },
  moduleId: { type: 'string', minLength: 1, description: 'schemaId 的兼容别名' },
} as const

/**
 * The response contract sent to a model. Keep this JSON-serializable so it can
 * be embedded directly in a system prompt or used by a future JSON-schema validator.
 */
export const agentResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'operations'],
  properties: {
    message: { type: 'string', description: '给用户看的简短执行结果' },
    operations: {
      type: 'array',
      maxItems: 50,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'engine', 'query', 'limit'],
            properties: {
              action: { const: 'search_web_memes' },
              engine: { enum: ['bing', 'google', 'duckduckgo'], description: '搜索引擎' },
              query: { type: 'string', minLength: 1, description: '搜索关键词；建议包含“网络热梗”“近期”等限定词' },
              limit: { type: 'integer', minimum: 1, maximum: 30, description: '最多返回候选数量' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'title'],
            properties: {
              action: { const: 'create_chapter' },
              title: { type: 'string', minLength: 1, description: '章节标题' },
              volumeId: { type: 'string', description: '有效分卷 ID；省略时归入当前分卷' },
              content: { type: 'string', description: '可选初始正文' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'collection', 'title'],
            properties: {
              action: { const: 'create_resource_group' },
              collection: { enum: ['world', 'characters', 'items', 'skills', 'style'] },
              title: { type: 'string', minLength: 1, description: '折叠栏名称，不能为空' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'collection', 'target'],
            properties: {
              action: { const: 'delete_resource_group' },
              collection: { enum: ['world', 'characters', 'items', 'skills', 'style'] },
              target: { type: 'string', minLength: 1, description: '折叠栏 ID 或名称；删除后其中的卡片保留并变为未分组' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'collection', 'target', 'groupTarget'],
            properties: {
              action: { const: 'move_resource_to_group' },
              collection: { enum: ['world', 'characters', 'items', 'skills', 'style'] },
              target: { type: 'string', minLength: 1, description: '条目 ID 或名称' },
              groupTarget: { type: ['string', 'null'], description: '目标折叠栏 ID 或名称；null 表示移回未分组' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'title'],
            properties: {
              action: { const: 'create_volume' },
              title: { type: 'string', minLength: 1, description: '分卷标题，不能为空' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'resourceType', 'title'],
            properties: {
              action: { const: 'create_resource' },
              resourceType: { enum: ['world', 'character', 'item', 'skill', 'outline', 'world_event', 'style'] },
              title: { type: 'string' },
              summary: { type: 'string' },
              fields: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: '固定模板字段。创建标准卡时必须返回完整模板字段（没有内容也要返回空字符串）；规范格式使用中文字段名，兼容接受 camelCase 别名。世界书只能使用触发策略、触发键、内容、适用范围、状态及已有兼容字段；独立字段集合必须使用 create_custom_module。',
              },
              includeAllFields: { type: 'boolean', description: '创建标准卡时固定为 true，表示 fields 必须覆盖该卡片模板的全部字段' },
              holdingItems: { type: 'array', items: { type: 'string' } },
              holdingSkills: { type: 'array', items: { type: 'string' } },
              groupTarget: { type: ['string', 'null'], description: '仅世界书、角色、道具、技能、文风规则可用；填写折叠栏 ID 或名称，null 表示创建为未分组' },
              outlineType: { enum: ['book', 'volume', 'chapterRange', 'scene'], description: '大纲层级；全书→卷→章节范围→场景' },
              outlineParentId: { type: 'string', description: '上级大纲节点 ID；省略时为根层级' },
              outlineStartChapterId: { type: 'string', description: '章节范围的起始章节 ID' },
              outlineEndChapterId: { type: 'string', description: '章节范围的结束章节 ID' },
              outlineCollapsed: { type: 'boolean', description: '是否默认折叠子大纲' },
            },
            allOf: [
              {
                if: {
                  properties: { resourceType: { enum: ['world', 'character', 'item', 'skill'] } },
                  required: ['resourceType'],
                },
                then: {
                  required: ['fields', 'includeAllFields'],
                  properties: {
                    includeAllFields: {
                      const: true,
                      description: '标准世界书、角色、道具、技能创建必须显式确认返回完整模板',
                    },
                  },
                },
              },
            ],
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'resourceType', 'target'],
            properties: {
              action: { const: 'update_resource' },
              resourceType: { enum: ['world', 'character', 'item', 'skill', 'outline', 'world_event', 'style'] },
              target: { type: 'string', description: '目标资源 ID 或名称' },
              title: { type: 'string', minLength: 1, description: '新的条目名称；不能设为空字符串' },
              summary: { type: 'string', description: '新的摘要；显式传入空字符串表示清空摘要' },
              fields: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: '只能更新固定模板字段或目标条目中已经存在的字段；规范格式使用中文字段名，兼容接受 triggerStrategy/triggerKeys/content/scope/status 等常见 camelCase 别名并会自动归一化；字段值允许为空字符串，表示清空该字段；不要凭空新增自定义结构字段。',
              },
              holdingItems: { type: 'array', items: { type: 'string' } },
              holdingSkills: { type: 'array', items: { type: 'string' } },
              reviewStatus: { enum: ['pending', 'complete'], description: '切换条目的校对状态；锁定校对状态时不会生效' },
              outlineType: { enum: ['book', 'volume', 'chapterRange', 'scene'] },
              outlineParentId: { type: 'string' },
              outlineStartChapterId: { type: 'string' },
              outlineEndChapterId: { type: 'string' },
              outlineCollapsed: { type: 'boolean' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'content'],
            properties: {
              action: { const: 'append_chapter' },
              chapterId: { type: 'string' },
              content: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'title'],
            properties: {
              action: { const: 'create_custom_module' },
              title: { type: 'string', minLength: 1, description: '自定义模块在界面中的名称' },
              id: { type: 'string', minLength: 1, description: '可选稳定模块 ID；省略时由桌面端生成' },
              type: { type: 'string', minLength: 1, description: '写入 JSON type 的模块类型；省略时使用 title' },
              description: { type: 'string', description: '模块用途说明' },
               fields: { type: 'array', minItems: 1, items: customModuleFieldSchema, description: '模块字段定义' },
              titleField: { type: 'string', minLength: 1, description: '用作条目标题的字段 key' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'data'],
            anyOf: [{ required: ['schemaId'] }, { required: ['moduleId'] }],
            properties: {
              action: { const: 'create_custom_module_entry' },
              ...customModuleReferenceProperties,
              id: { type: 'string', minLength: 1, description: '可选条目 ID；省略时由桌面端生成' },
              title: { type: 'string', minLength: 1, description: '可选条目显示名称' },
              data: customModuleDataSchema,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            allOf: [
              { anyOf: [{ required: ['schemaId'] }, { required: ['moduleId'] }] },
              { anyOf: [{ required: ['target'] }, { required: ['id'] }] },
            ],
            properties: {
              action: { const: 'update_custom_module_entry' },
              ...customModuleReferenceProperties,
              target: { type: 'string', minLength: 1, description: '条目 ID 或名称' },
              id: { type: 'string', minLength: 1, description: 'target 的兼容别名' },
              title: { type: 'string', minLength: 1, description: '新的条目显示名称' },
              data: customModuleDataSchema,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            allOf: [
              { anyOf: [{ required: ['schemaId'] }, { required: ['moduleId'] }] },
              { anyOf: [{ required: ['target'] }, { required: ['id'] }] },
            ],
            properties: {
              action: { const: 'delete_custom_module_entry' },
              ...customModuleReferenceProperties,
              target: { type: 'string', minLength: 1, description: '条目 ID 或名称' },
              id: { type: 'string', minLength: 1, description: 'target 的兼容别名' },
            },
          },
        ],
      },
    },
  },
} as const

export const resourceTypeLabels: Record<AgentResourceType, string> = {
  world: '世界书条目',
  character: '角色',
  item: '道具',
  skill: '技能',
  outline: '大纲条目',
  world_event: '世界引擎事件',
  style: '文风规则',
}

