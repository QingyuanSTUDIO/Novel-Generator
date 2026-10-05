import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAgentResponse } from '../src/agent/validation.ts'

test('accepts valid card operations and a no-change response', () => {
  assert.equal(validateAgentResponse({
    message: '已准备角色卡',
    operations: [{
      action: 'create_resource',
      resourceType: 'character',
      title: '青源',
      fields: { 角色身份: '配角', 性别: '女' },
    }],
  }).ok, true)
  assert.deepEqual(validateAgentResponse({ message: '这是建议', operations: [] }), {
    ok: true,
    value: { message: '这是建议', operations: [] },
  })
})

test('rejects the whole response when an operation has an invalid enum or extra field', () => {
  const invalidRole = validateAgentResponse({
    message: '创建角色',
    operations: [{ action: 'create_resource', resourceType: 'character', title: '青源', fields: { 角色身份: '重要人物' } }],
  })
  assert.equal(invalidRole.ok, false)

  const extraProperty = validateAgentResponse({
    message: '创建角色',
    operations: [
      { action: 'create_resource', resourceType: 'character', title: '青源' },
      { action: 'create_resource', resourceType: 'item', title: '钥匙', overwriteAll: true },
    ],
  })
  assert.equal(extraProperty.ok, false)
  if (!extraProperty.ok) assert.match(extraProperty.error, /不支持的属性/)
})

test('rejects non-string fields and invalid chapter volume references', () => {
  const badField = validateAgentResponse({
    message: '更新资料',
    operations: [{ action: 'update_resource', resourceType: 'item', target: '铜钥匙', fields: { 用途: 42 } }],
  })
  assert.equal(badField.ok, false)

  const badVolume = validateAgentResponse({
    message: '创建章节',
    operations: [{ action: 'create_chapter', title: '新章', volumeId: 'missing-volume' }],
  }, new Set(['volume-1']))
  assert.equal(badVolume.ok, false)
})

test('keeps independent custom structures out of standard world-book resources', () => {
  const result = validateAgentResponse({
    message: '创建势力卡',
    operations: [{
      action: 'create_resource',
      resourceType: 'world',
      title: '天玄宗',
      fields: {
        世界定义: '修仙宗门',
        世界层级: '五级',
        登记规模: '大型',
        核心大世界: '归元界',
      },
    }],
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /不支持的字段/)
    assert.match(result.error, /create_custom_module/)
  }

  const customResult = validateAgentResponse({
    message: '创建势力结构和条目',
    operations: [
      {
        action: 'create_custom_module',
        id: 'faction',
        title: '势力卡',
        titleField: '名称',
        fields: [
          { key: '名称', type: 'string', required: true },
          { key: '势力等级', type: 'number' },
        ],
      },
      {
        action: 'create_custom_module_entry',
        schemaId: 'faction',
        id: 'tianxuan',
        data: { 名称: '天玄宗', 势力等级: 5 },
      },
    ],
  })
  assert.equal(customResult.ok, true)
})

test('accepts the English aliases used by common model JSON for standard cards', () => {
  const result = validateAgentResponse({
    message: '创建全局世界书',
    operations: [{
      action: 'create_resource',
      resourceType: 'world',
      title: '天玄宗',
      fields: {
        triggerStrategy: 'always',
        triggerKeys: '天玄宗, 宗门',
        content: '一个隐世宗门。',
        scope: '全书',
        status: '稳定',
      },
    }],
  })
  assert.equal(result.ok, true)
})

test('accepts review status changes but rejects invalid values and agent-controlled lock/source fields', () => {
  const validStatus = validateAgentResponse({
    message: '完成校对',
    operations: [{ action: 'update_resource', resourceType: 'character', target: '青源', reviewStatus: 'complete' }],
  })
  assert.equal(validStatus.ok, true)

  for (const reviewStatus of ['draft', null, true]) {
    const invalidStatus = validateAgentResponse({
      message: '修改状态',
      operations: [{ action: 'update_resource', resourceType: 'item', target: '铜钥匙', reviewStatus }],
    })
    assert.equal(invalidStatus.ok, false)
    if (!invalidStatus.ok) assert.match(invalidStatus.error, /reviewStatus/)
  }

  for (const protectedField of ['creationSource', 'lockedAll', 'reviewStatusLocked']) {
    const attemptedOverride = validateAgentResponse({
      message: '绕过保护',
      operations: [{ action: 'update_resource', resourceType: 'character', target: '青源', [protectedField]: 'agent' }],
    })
    assert.equal(attemptedOverride.ok, false)
    if (!attemptedOverride.ok) assert.match(attemptedOverride.error, /不支持的属性/)
  }
})

test('rejects group targets for resources without foldable collections', () => {
  const invalidGroupTarget = validateAgentResponse({
    message: '创建大纲',
    operations: [{ action: 'create_resource', resourceType: 'outline', title: '追查线索', groupTarget: '规划中' }],
  })
  assert.equal(invalidGroupTarget.ok, false)
  if (!invalidGroupTarget.ok) assert.match(invalidGroupTarget.error, /groupTarget.*仅支持/)

  assert.equal(validateAgentResponse({
    message: '创建角色',
    operations: [{ action: 'create_resource', resourceType: 'character', title: '青源', groupTarget: '主角组' }],
  }).ok, true)
})

test('requires usable custom module schemas and strict search operations', () => {
  const emptySchema = validateAgentResponse({
    message: '创建空结构',
    operations: [{ action: 'create_custom_module', title: '空模块', fields: [] }],
  })
  assert.equal(emptySchema.ok, false)
  if (!emptySchema.ok) assert.match(emptySchema.error, /fields.*至少定义一个字段/)

  const duplicateFieldIds = validateAgentResponse({
    message: '创建结构',
    operations: [{
      action: 'create_custom_module',
      title: '重复 ID',
      fields: [
        { id: 'same', key: '名称', type: 'string' },
        { id: 'same', key: '说明', type: 'text' },
      ],
    }],
  })
  assert.equal(duplicateFieldIds.ok, false)
  if (!duplicateFieldIds.ok) assert.match(duplicateFieldIds.error, /重复 id/)

  const extraSearchProperty = validateAgentResponse({
    message: '搜索',
    operations: [{ action: 'search_web_memes', engine: 'bing', query: '近期热梗', limit: 3, unsafe: true }],
  })
  assert.equal(extraSearchProperty.ok, false)

  const tooManyOperations = validateAgentResponse({
    message: '批量任务',
    operations: Array.from({ length: 51 }, (_, index) => ({
      action: 'create_resource',
      resourceType: 'item',
      title: `道具 ${index + 1}`,
    })),
  })
  assert.equal(tooManyOperations.ok, false)
  if (!tooManyOperations.ok) assert.match(tooManyOperations.error, /最多允许 50 项/)
})

test('accepts reinforcement instructions on custom-module field definitions', () => {
  const result = validateAgentResponse({
    message: '建立带字段提示的势力结构',
    operations: [{
      action: 'create_custom_module',
      id: 'hinted-faction',
      title: '势力卡',
      fields: [{
        key: '主要人物',
        type: 'tags',
        promptHint: '仅列出已登场人物；不确定时留空。',
      }],
    }],
  })
  assert.equal(result.ok, true)
})

test('rejects invalid holding references and conflicting operations before execution', () => {
  const blankHolding = validateAgentResponse({
    message: '创建角色',
    operations: [{
      action: 'create_resource',
      resourceType: 'character',
      title: '青源',
      holdingItems: [''],
    }],
  })
  assert.equal(blankHolding.ok, false)
  if (!blankHolding.ok) assert.match(blankHolding.error, /不能包含空字符串/)

  const itemHolding = validateAgentResponse({
    message: '创建道具',
    operations: [{
      action: 'create_resource',
      resourceType: 'item',
      title: '铜钥匙',
      holdingSkills: ['skill-1'],
    }],
  })
  assert.equal(itemHolding.ok, false)
  if (!itemHolding.ok) assert.match(itemHolding.error, /只有角色资源/)

  const conflictingModules = validateAgentResponse({
    message: '创建结构',
    operations: [
      { action: 'create_custom_module', id: 'same-module', title: '势力卡', fields: [{ key: '名称', type: 'string' }] },
      { action: 'create_custom_module', id: 'same-module', title: '人物卡', fields: [{ key: '名称', type: 'string' }] },
    ],
  })
  assert.equal(conflictingModules.ok, false)
  if (!conflictingModules.ok) assert.match(conflictingModules.error, /重复创建/)
})
