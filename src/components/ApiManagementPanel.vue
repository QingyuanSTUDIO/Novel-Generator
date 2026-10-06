<script setup lang="ts">
import {
  Check,
  Cloud,
  FileText,
  LockKeyhole,
  Plug,
  Plus,
  Trash2,
} from 'lucide-vue-next'
import type { Resource } from '../types'

defineProps<{
  resources: Resource[]
  selectedResource?: Resource
  protocolOptions: string[]
  providerTest: string
  isConfigured: (resource: Resource) => boolean
  statusLabel: (resource: Resource) => string
  modelOptions: (resource?: Resource) => string[]
}>()

const emit = defineEmits<{
  add: []
  select: [id: string]
  remove: []
  test: []
  fetch: []
  'update-title': [value: string]
  'update-summary': [value: string]
  'update-field': [key: string, value: string]
}>()

function updateField(key: string, event: Event) {
  emit('update-field', key, (event.target as HTMLInputElement | HTMLSelectElement).value)
}
</script>

<template>
  <section class="page-view api-view">
    <div class="page-header">
      <div>
        <span class="eyebrow">全局连接配置</span>
        <h1>API 管理</h1>
        <p>管理可复用的 API 预设。协议、地址和模型独立保存，写作任务按预设调用。</p>
      </div>
      <div class="header-actions">
        <span class="header-tag">{{ resources.length }} 个预设</span>
        <button class="button primary" type="button" @click="emit('add')">
          <Plus :size="15" />
          新建 API 预设
        </button>
      </div>
    </div>

    <div class="resource-grid">
      <div class="resource-list">
        <button
          v-for="item in resources"
          :key="item.id"
          :class="['resource-item', { selected: selectedResource?.id === item.id }]"
          type="button"
          @click="emit('select', item.id)"
        >
          <div class="resource-item-top">
            <strong>{{ item.title }}</strong>
            <span :class="['tag', isConfigured(item) ? 'status-tag-available' : 'status-tag-unconfigured']">
              {{ statusLabel(item) }}
            </span>
          </div>
          <p>{{ item.summary }}</p>
        </button>
      </div>

      <article v-if="selectedResource" class="detail-panel api-detail">
        <div class="detail-head">
          <div>
            <span class="eyebrow">API 预设 · 可编辑</span>
            <h2>{{ selectedResource.title }}</h2>
          </div>
          <div class="detail-actions">
            <button class="button secondary" type="button" @click="emit('test')">
              <Plug :size="15" />
              {{ providerTest === '测试中' ? '测试中…' : '测试连接' }}
            </button>
            <button class="icon-button danger" type="button" title="删除 API 预设" @click="emit('remove')">
              <Trash2 :size="16" />
            </button>
          </div>
        </div>

        <label class="form-field">
          <span>预设名称</span>
          <input
            :value="selectedResource.title"
            @input="emit('update-title', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="form-field">
          <span>用途说明</span>
          <textarea
            :value="selectedResource.summary"
            rows="2"
            @input="emit('update-summary', ($event.target as HTMLTextAreaElement).value)"
          />
        </label>

        <div class="api-form-grid">
          <label class="form-field">
            <span>协议</span>
            <select :value="selectedResource.fields['协议']" @change="updateField('协议', $event)">
              <option v-for="protocol in protocolOptions" :key="protocol" :value="protocol">{{ protocol }}</option>
            </select>
          </label>
          <label class="form-field">
            <span>模型</span>
            <div class="model-row">
              <select v-if="modelOptions(selectedResource).length" :value="selectedResource.fields['模型']" @change="updateField('模型', $event)">
                <option value="" disabled>请选择模型</option>
                <option v-for="model in modelOptions(selectedResource)" :key="model" :value="model">{{ model }}</option>
              </select>
              <input v-else :value="selectedResource.fields['模型']" placeholder="暂未提供模型列表，可手动填写" @input="updateField('模型', $event)" />
              <button class="button secondary fetch-button" type="button" :disabled="providerTest === '拉取中'" @click="emit('fetch')">
                <Cloud :size="15" />
                {{ providerTest === '拉取中' ? '拉取中…' : '获取模型' }}
              </button>
            </div>
            <small v-if="!modelOptions(selectedResource).length" class="form-hint">部分中转站不提供模型列表，手动填写模型名称后可以直接保存。</small>
            <small v-if="providerTest === '模型已更新'" class="form-success"><Check :size="12" />模型列表已更新</small>
          </label>
        </div>

        <label class="form-field">
          <span>接口地址</span>
          <input
            :value="selectedResource.fields['接口地址']"
            placeholder="https://api.example.com/v1"
            @input="updateField('接口地址', $event)"
          />
        </label>
        <label class="form-field">
          <span>API Key</span>
          <input
            type="password"
            :value="selectedResource.fields['API Key']"
            placeholder="输入后仅显示掩码"
            @input="updateField('API Key', $event)"
          />
          <small><LockKeyhole :size="12" />当前配置保存于本机应用数据；请求时经本机 Node 代理转发。</small>
        </label>
        <div class="api-status"><span>连接状态</span><strong>{{ selectedResource.fields['状态'] }}</strong></div>
        <div class="proxy-panel-head streaming-panel-head">
          <div>
            <span class="eyebrow">响应方式</span>
            <h2>流式输出</h2>
            <p>模型生成时逐段显示结果，写作和 Agent 都会实时更新。</p>
          </div>
          <label class="switch-label">
            <input
              type="checkbox"
              :checked="selectedResource.fields['流式输出'] !== 'false'"
              @change="emit('update-field', '流式输出', ($event.target as HTMLInputElement).checked ? 'true' : 'false')"
            />
            <span>启用流式</span>
          </label>
        </div>
        <div class="source-note">
          <FileText :size="15" />
          <span>API 配置只描述连接与模型，正文与 Agent 会按当前上下文和模式生成。</span>
        </div>
      </article>
    </div>
  </section>

  <section v-if="selectedResource" class="proxy-panel">
    <div class="proxy-panel-head">
      <div>
        <span class="eyebrow">本地代理</span>
        <h2>代理设置</h2>
        <p>只影响本机 Node 代理访问中转站的出口。</p>
      </div>
      <label class="switch-label">
        <input
          type="checkbox"
          :checked="selectedResource.fields['使用代理'] === 'true'"
          @change="emit('update-field', '使用代理', ($event.target as HTMLInputElement).checked ? 'true' : 'false')"
        />
        <span>使用代理</span>
      </label>
    </div>
    <div v-if="selectedResource.fields['使用代理'] === 'true'" class="proxy-grid">
      <label class="form-field">
        <span>代理地址</span>
        <input
          :value="selectedResource.fields['代理地址']"
          placeholder="127.0.0.1"
          @input="updateField('代理地址', $event)"
        />
      </label>
      <label class="form-field">
        <span>代理端口</span>
        <input
          type="number"
          min="1"
          max="65535"
          step="1"
          :value="selectedResource.fields['代理端口']"
          inputmode="numeric"
          placeholder="7890"
          @input="updateField('代理端口', $event)"
        />
      </label>
    </div>
  </section>
</template>
