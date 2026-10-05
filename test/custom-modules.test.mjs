import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAgentResponse } from '../src/agent/validation.ts'
import {
  customModulePromptContract,
  normalizeCustomModuleData,
  normalizeCustomModuleEntry,
  normalizeCustomModuleSchema,
} from '../src/data/customModules.ts'

function createSchema() {
  return normalizeCustomModuleSchema({
    id: 'custom-test',
    title: '测试模块',
    type: '测试模块',
    titleField: '名称',
    fields: [
      { id: 'name', key: '名称', label: '名称', type: 'string' },
      { id: 'count', key: '数量', label: '数量', type: 'number', defaultValue: 3 },
      { id: 'kind', key: '类型', label: '类型', type: 'enum', options: ['甲', '乙'] },
    ],
  }, 1)
}

test('keeps explicit empty custom-module values editable', () => {
  const schema = createSchema()
  assert.deepEqual(normalizeCustomModuleData({
    名称: '',
    数量: '',
    类型: '',
  }, schema), {
    名称: '',
    数量: '',
    类型: '',
  })
})

test('keeps an explicitly cleared entry title empty', () => {
  const schema = createSchema()
  const entry = normalizeCustomModuleEntry({
    id: 'entry-1',
    schemaId: schema.id,
    title: '',
    data: { 名称: '仍有字段值', 数量: 1, 类型: '甲' },
  }, schema, 1)
  assert.equal(entry.title, '')
})

test('describes empty number and enum values in the custom-module contract', () => {
  const schema = createSchema()
  const properties = customModulePromptContract(schema).schema.properties
  assert.deepEqual(properties.数量.type, ['number', 'string'])
  assert.deepEqual(properties.类型.enum, ['', '甲', '乙'])
})

test('preserves and exposes field reinforcement hints to the custom-module AI contract', () => {
  const schema = normalizeCustomModuleSchema({
    id: 'hinted-module',
    title: '势力卡',
    fields: [{
      key: '主要人物',
      type: 'tags',
      description: '势力的关键人物',
      promptHint: '只填写已经在作品中登场的人物姓名；没有则留空。',
    }],
  }, 1)
  const contract = customModulePromptContract(schema).schema.properties['主要人物']
  assert.equal(schema.fields[0].promptHint, '只填写已经在作品中登场的人物姓名；没有则留空。')
  assert.equal(contract['x-promptHint'], schema.fields[0].promptHint)
  assert.match(contract.description, /强化提示：只填写已经在作品中登场的人物姓名/)
})

test('accepts empty number and enum values in Agent module operations', () => {
  const result = validateAgentResponse({
    message: '清空未填写字段',
    operations: [
      {
        action: 'create_custom_module',
        id: 'empty-values',
        title: '可留白模块',
        fields: [
          { key: '数量', type: 'number' },
          { key: '类型', type: 'enum', options: ['甲', '乙'] },
        ],
      },
      {
        action: 'create_custom_module_entry',
        schemaId: 'empty-values',
        data: { 数量: '', 类型: '' },
      },
    ],
  })
  assert.equal(result.ok, true)
})
