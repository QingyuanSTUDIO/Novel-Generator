<script setup lang="ts">
import { ref } from 'vue'
import { Archive, Bot, Check, Cloud, FileText, LockKeyhole, Palette, Plug, Plus, RotateCcw, Server, Timer, Trash2, X } from 'lucide-vue-next'
import ProviderGenerationSettings from './ProviderGenerationSettings.vue'
import McpSettings from './McpSettings.vue'
import PortfolioFileSettings from './PortfolioFileSettings.vue'
import { themeColorFields } from '../data/theme'
import type { ThemeColorKey, ThemeSettings } from '../data/theme'
import type { AgentConversation } from '../types'

type Resource = {
  id: string
  title: string
  tag: string
  summary: string
  fields: Record<string, string>
  enabled?: boolean
}

const props = defineProps<{
  open: boolean
  desktopRuntime?: boolean
  resources: Resource[]
  selectedResource?: Resource
  modelOptions: Record<string, string[]>
  protocolOptions: readonly string[]
  statusLabel: (resource: Resource) => string
  providerTest: string
  apiError: string
  modelLimitsBusy?: boolean
  modelLimitsMessage?: string
  modelLimitsError?: string
  historyLimit: number
  autoSaveSeconds: number
  qyBackupCount: number
  qyFilePath?: string
  qyRestoreBusy?: boolean
  qyRestoreError?: string
  qyRestoreMessage?: string
  qyRestoredPath?: string
  themeSettings: ThemeSettings
  archivedConversations: AgentConversation[]
}>()

const emit = defineEmits<{
  close: []
  select: [id: string]
  add: []
  remove: []
  save: []
  updateField: [key: string, value: string]
  test: []
  fetch: []
  fetchModelLimits: []
  toggleProviderDefault: [id: string]
  updateHistoryLimit: [value: number]
  updateAutoSave: [value: number]
  updateQyBackupCount: [value: number]
  restoreQyBackup: [id: string]
  openRestoredQyBackup: [path: string]
  updateThemeColor: [mode: 'light' | 'dark', key: ThemeColorKey, value: string]
  resetTheme: []
  restoreConversation: [id: string]
  deleteArchivedConversation: [id: string]
}>()

const overlayPointerDownTarget = ref<EventTarget | null>(null)
const activeTab = ref<'api' | 'mcp' | 'agent' | 'archive' | 'autosave' | 'theme' | 'files'>('api')

function rememberOverlayPointerDown(event: PointerEvent) {
  overlayPointerDownTarget.value = event.target
}

function closeOnOverlay(event: MouseEvent) {
  const canClose = event.target === event.currentTarget && overlayPointerDownTarget.value === event.currentTarget
  overlayPointerDownTarget.value = null
  if (canClose) emit('close')
}

function modelsFor(resource: Resource | undefined) {
  return resource ? (props.modelOptions[resource.id] ?? []) : []
}

function formatConversationTime(timestamp: number) {
  return new Date(timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function conversationPreview(conversation: AgentConversation) {
  const latest = [...conversation.messages].reverse().find((message) => message.role === 'user' && message.content.trim())
  return latest?.content.replace(/\s+/g, ' ').trim().slice(0, 80) || '尚未发送消息'
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" :class="['settings-overlay', { 'settings-overlay-desktop': props.desktopRuntime }]" role="presentation" @pointerdown="rememberOverlayPointerDown" @click.self="closeOnOverlay">
      <aside class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header class="settings-head">
          <div>
            <span class="eyebrow">全局设置</span>
            <h2 id="settings-title">设置</h2>
          </div>
          <button class="icon-button" type="button" title="关闭设置" aria-label="关闭设置" @click="emit('close')"><X :size="18" /></button>
        </header>

        <nav class="settings-nav" aria-label="设置分类">
          <button :class="['settings-nav-item', { selected: activeTab === 'api' }]" type="button" @click="activeTab = 'api'"><Plug :size="16" /><span>API 设置</span><small>连接与模型</small></button>
          <button :class="['settings-nav-item', { selected: activeTab === 'mcp' }]" type="button" @click="activeTab = 'mcp'"><Server :size="16" /><span>MCP 连接</span><small>本机客户端</small></button>
          <button :class="['settings-nav-item', { selected: activeTab === 'agent' }]" type="button" @click="activeTab = 'agent'"><Bot class="settings-agent-icon" :size="16" /><span>Agent 设置</span><small>记录与撤销</small></button>
          <button :class="['settings-nav-item', { selected: activeTab === 'archive' }]" type="button" @click="activeTab = 'archive'"><Archive :size="16" /><span>归档对话</span><small>恢复与删除</small></button>
          <button :class="['settings-nav-item', { selected: activeTab === 'autosave' }]" type="button" @click="activeTab = 'autosave'"><Timer :size="16" /><span>自动保存</span><small>保存间隔</small></button>
          <button :class="['settings-nav-item', { selected: activeTab === 'files' }]" type="button" @click="activeTab = 'files'"><FileText :size="16" /><span>作品文件</span><small>.qy 与备份</small></button>
          <button :class="['settings-nav-item', { selected: activeTab === 'theme' }]" type="button" @click="activeTab = 'theme'"><Palette :size="16" /><span>主题颜色</span><small>白天与夜间</small></button>
        </nav>

        <div class="settings-body" :class="{ 'settings-body-api': activeTab === 'api' }">
          <McpSettings v-show="activeTab === 'mcp'" />
          <div v-if="activeTab === 'agent'" class="settings-section-head agent-settings-section">
            <div>
              <span class="eyebrow">Agent 记录</span>
              <h3>修改记录与撤销</h3>
              <p>记录保存在本机。撤销会恢复最近一次 Agent 执行前的作品资料。</p>
            </div>
            <label class="form-field settings-history-limit"><span>保留记录数量</span><select :value="props.historyLimit" @change="emit('updateHistoryLimit', Number(($event.target as HTMLSelectElement).value))"><option :value="10">最近 10 条</option><option :value="20">最近 20 条</option><option :value="50">最近 50 条</option><option :value="100">最近 100 条</option></select></label>
          </div>

          <div v-if="activeTab === 'autosave'" class="settings-section-head agent-settings-section">
            <div>
              <span class="eyebrow">本地持久化</span>
              <h3>自动保存</h3>
              <p>作品、章节、卡片、API 配置和 Agent 记录会按设定间隔写入本机。</p>
            </div>
            <label class="form-field settings-history-limit"><span>保存间隔</span><select :value="props.autoSaveSeconds" @change="emit('updateAutoSave', Number(($event.target as HTMLSelectElement).value))"><option :value="0">关闭自动保存</option><option :value="5">每 5 秒</option><option :value="10">每 10 秒</option><option :value="30">每 30 秒</option><option :value="60">每 1 分钟</option><option :value="300">每 5 分钟</option></select></label>
          </div>

          <div v-if="activeTab === 'autosave'" class="agent-settings-info">
            <div class="source-note"><Timer :size="15" /><span>修改内容会先标记为待保存，到达间隔后自动保存。关闭应用时仍会执行最后一次保存。</span></div>
            <div class="source-note"><FileText :size="15" /><span>保存内容包含当前作品、全局 API 配置、模型列表和 Agent 修改记录。</span></div>
          </div>

          <PortfolioFileSettings
            v-if="activeTab === 'files'"
            :file-path="props.qyFilePath || ''" :backup-count="props.qyBackupCount"
            :restoring="props.qyRestoreBusy" :restore-error="props.qyRestoreError"
            :restore-message="props.qyRestoreMessage" :restored-path="props.qyRestoredPath"
            @update-backup-count="emit('updateQyBackupCount', $event)"
            @restore-backup="emit('restoreQyBackup', $event)"
            @open-restored-backup="emit('openRestoredQyBackup', $event)"
          />

          <section v-if="activeTab === 'theme'" class="theme-settings">
            <div class="settings-section-head theme-settings-head">
              <div>
                <span class="eyebrow">外观</span>
                <h3>主题颜色</h3>
                <p>主色控制正文工作区背景，配色控制侧栏与辅助区域；两套颜色分别保存。</p>
              </div>
              <button class="button secondary" type="button" title="只恢复白天和夜间的颜色设置，不改变当前模式" @click="emit('resetTheme')"><RotateCcw :size="14" />恢复默认颜色</button>
            </div>
            <div class="theme-mode-grid">
              <fieldset v-for="mode in (['light', 'dark'] as const)" :key="mode" class="theme-mode-card">
                <legend>{{ mode === 'light' ? '白天颜色' : '夜间颜色' }}</legend>
                <p>{{ mode === props.themeSettings.mode ? '当前正在使用' : '点击标题栏的日夜按钮可切换' }}</p>
                <label v-for="field in themeColorFields" :key="field.key" class="theme-color-field">
                  <span><strong>{{ field.label }}</strong><small>{{ field.description }}</small></span>
                  <span class="theme-color-control">
                    <input
                      type="color"
                      :value="props.themeSettings[mode][field.key]"
                      :aria-label="`${mode === 'light' ? '白天' : '夜间'}${field.label}`"
                      @input="emit('updateThemeColor', mode, field.key as ThemeColorKey, ($event.target as HTMLInputElement).value)"
                    />
                    <code>{{ props.themeSettings[mode][field.key] }}</code>
                  </span>
                </label>
              </fieldset>
            </div>
          </section>

          <div v-if="activeTab === 'api'" class="settings-section-head">
            <div>
              <span class="eyebrow">模型连接</span>
              <h3>API 预设</h3>
              <p>统一管理中转站地址、模型、密钥和本地代理。</p>
            </div>
            <button class="button primary" type="button" @click="emit('add')"><Plus :size="15" />新建预设</button>
          </div>

          <div v-if="activeTab === 'api'" class="settings-api-layout">
            <div class="settings-resource-list">
              <div v-for="item in props.resources" :key="item.id" :class="['resource-item', 'settings-resource-card', { selected: props.selectedResource?.id === item.id }]" role="button" tabindex="0" @click="emit('select', item.id)" @keydown.enter.prevent="emit('select', item.id)" @keydown.space.prevent="emit('select', item.id)">
                <div class="resource-item-top"><button class="settings-resource-select" type="button" @click.stop="emit('select', item.id)"><strong>{{ item.title }}</strong></button><span class="provider-card-actions"><span :class="['tag', props.statusLabel(item) === '可用' ? 'status-tag-available' : 'status-tag-unconfigured']">{{ props.statusLabel(item) }}</span><label class="provider-default-control" title="设为默认 API" @click.stop><input type="checkbox" :checked="item.enabled === true" @change="emit('toggleProviderDefault', item.id)" /><span>默认</span></label></span></div>
                <button class="settings-resource-summary" type="button" @click.stop="emit('select', item.id)">{{ item.summary }}</button>
              </div>
              <div v-if="!props.resources.length" class="settings-empty">还没有 API 预设</div>
            </div>

            <article v-if="props.selectedResource" class="settings-detail">
                <div class="settings-detail-head">
                <div><span class="eyebrow">API 预设 · 可编辑</span><h3>{{ props.selectedResource.title }}</h3></div>
                <div class="detail-actions"><button class="button primary" type="button" :disabled="props.providerTest === '保存中'" @click="emit('save')"><Check :size="15" />{{ props.providerTest === '保存中' ? '保存中…' : props.providerTest === '已保存' ? '已保存' : '保存配置' }}</button><button class="button secondary" type="button" :disabled="props.providerTest === '测试中' || props.providerTest === '保存中'" @click="emit('test')"><Plug :size="15" />{{ props.providerTest === '测试中' ? '测试中…' : '测试连接' }}</button><button class="icon-button danger" type="button" title="删除 API 预设" aria-label="删除 API 预设" @click="emit('remove')"><Trash2 :size="16" /></button></div>
              </div>

              <label class="form-field"><span>预设名称</span><input :value="props.selectedResource.title" @input="(event) => (props.selectedResource!.title = (event.target as HTMLInputElement).value)" /></label>
              <label class="form-field"><span>用途说明</span><textarea :value="props.selectedResource.summary" rows="2" @input="(event) => (props.selectedResource!.summary = (event.target as HTMLTextAreaElement).value)" /></label>

              <div class="api-form-grid">
                <label class="form-field"><span>协议</span><select :value="props.selectedResource.fields['协议']" @change="emit('updateField', '协议', ($event.target as HTMLSelectElement).value)"><option v-for="protocol in props.protocolOptions" :key="protocol" :value="protocol">{{ protocol }}</option></select></label>
                <label class="form-field"><span>模型</span><div class="model-row"><select v-if="modelsFor(props.selectedResource).length" :value="props.selectedResource.fields['模型']" @change="emit('updateField', '模型', ($event.target as HTMLSelectElement).value)"><option value="" disabled>请选择模型</option><option v-for="model in modelsFor(props.selectedResource)" :key="model" :value="model">{{ model }}</option></select><input v-else :value="props.selectedResource.fields['模型']" placeholder="暂未提供模型列表，可手动填写" @input="emit('updateField', '模型', ($event.target as HTMLInputElement).value)" /><button class="button secondary fetch-button" type="button" :disabled="props.providerTest === '拉取中'" @click="emit('fetch')"><Cloud :size="15" />{{ props.providerTest === '拉取中' ? '拉取中…' : '获取模型' }}</button></div><small v-if="!modelsFor(props.selectedResource).length" class="form-hint">部分中转站不提供模型列表，手动填写模型名称后可以直接保存。</small><small v-if="props.providerTest === '模型已更新'" class="form-success"><Check :size="12" />模型列表已更新</small></label>
              </div>

              <label class="form-field"><span>接口地址</span><input :value="props.selectedResource.fields['接口地址']" placeholder="https://api.example.com/v1" @input="emit('updateField', '接口地址', ($event.target as HTMLInputElement).value)" /></label>
              <label class="form-field"><span>API Key</span><input type="password" :value="props.selectedResource.fields['API Key']" placeholder="输入后仅显示掩码" @input="emit('updateField', 'API Key', ($event.target as HTMLInputElement).value)" /><small><LockKeyhole :size="12" />当前配置保存于本机应用数据，请求时经本机 Node 代理转发。</small></label>

              <div class="api-status"><span>配置状态</span><strong>{{ props.selectedResource.fields['状态'] }}</strong></div>
              <small v-if="props.providerTest === '已保存'" class="form-success"><Check :size="12" />配置已保存，可用状态已更新</small>
              <div v-if="props.apiError" class="settings-error">{{ props.apiError }}</div>

              <div class="settings-proxy settings-streaming">
                <div class="settings-proxy-head">
                  <div><span class="eyebrow">响应方式</span><h4>流式输出</h4><p>模型生成时逐段显示结果，写作和 Agent 都会实时更新。</p></div>
                  <label class="switch-label"><input type="checkbox" :checked="props.selectedResource.fields['流式输出'] !== 'false'" @change="emit('updateField', '流式输出', ($event.target as HTMLInputElement).checked ? 'true' : 'false')" /><span>启用流式</span></label>
                </div>
              </div>

              <ProviderGenerationSettings
                :fields="props.selectedResource.fields"
                :model-limits-busy="props.modelLimitsBusy"
                :model-limits-message="props.modelLimitsMessage"
                :model-limits-error="props.modelLimitsError"
                @update-field="(key, value) => emit('updateField', key, value)"
                @fetch-model-limits="emit('fetchModelLimits')"
              />

              <div class="settings-proxy">
                <div class="settings-proxy-head"><div><span class="eyebrow">本地代理</span><h4>代理设置</h4><p>只影响本机 Node 代理访问中转站的出口。</p></div><label class="switch-label"><input type="checkbox" :checked="props.selectedResource.fields['使用代理'] === 'true'" @change="emit('updateField', '使用代理', ($event.target as HTMLInputElement).checked ? 'true' : 'false')" /><span>使用代理</span></label></div>
                <div v-if="props.selectedResource.fields['使用代理'] === 'true'" class="proxy-grid"><label class="form-field"><span>代理地址</span><input :value="props.selectedResource.fields['代理地址']" placeholder="127.0.0.1" @input="emit('updateField', '代理地址', ($event.target as HTMLInputElement).value)" /></label><label class="form-field"><span>代理端口</span><input type="number" min="1" max="65535" step="1" :value="props.selectedResource.fields['代理端口']" inputmode="numeric" placeholder="7890" @input="emit('updateField', '代理端口', ($event.target as HTMLInputElement).value)" /></label></div>
              </div>

              <div class="source-note"><FileText :size="15" /><span>API 预设保存连接、模型和生成参数。正文与 Agent 会按所选预设、当前上下文和模式生成。</span></div>
            </article>
            <div v-else class="settings-detail settings-empty-detail">选择一个 API 预设开始配置。</div>
          </div>

          <div v-else-if="activeTab === 'agent'" class="agent-settings-info">
            <div class="source-note"><Bot :size="15" /><span>Agent 修改默认先生成计划，只有点击“确认执行”后才会写入作品。</span></div>
            <div class="source-note"><Check :size="15" /><span>执行后的记录会显示在 Agent 栏目右侧，可撤销最近一笔未撤销修改。</span></div>
          </div>

          <section v-if="activeTab === 'archive'" class="archived-conversations-settings">
            <div class="settings-section-head">
              <div>
                <span class="eyebrow">Agent 对话</span>
                <h3>归档对话管理</h3>
                <p>归档对话不会出现在 Agent 左侧列表中，但仍会保留在当前作品里。你可以恢复或永久删除。</p>
              </div>
            </div>
            <div v-if="props.archivedConversations.length" class="archived-conversation-list">
              <article v-for="conversation in props.archivedConversations" :key="conversation.id" class="archived-conversation-item">
                <div class="archived-conversation-copy">
                  <strong>{{ conversation.title }}</strong>
                  <small>归档于 {{ formatConversationTime(conversation.archivedAt ?? conversation.updatedAt) }} · {{ conversation.messages.length }} 条消息</small>
                  <span>{{ conversationPreview(conversation) }}</span>
                </div>
                <div class="archived-conversation-actions">
                  <button class="button secondary" type="button" @click="emit('restoreConversation', conversation.id)"><RotateCcw :size="14" />恢复</button>
                  <button class="button danger-button" type="button" @click="emit('deleteArchivedConversation', conversation.id)"><Trash2 :size="14" />永久删除</button>
                </div>
              </article>
            </div>
            <div v-else class="settings-empty archived-conversation-empty"><Archive :size="18" /><span>当前作品没有归档对话。</span></div>
          </section>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
