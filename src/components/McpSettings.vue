<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, Copy, KeyRound, Link, LoaderCircle, LockKeyhole, RefreshCw, Save, Server } from 'lucide-vue-next'
import type { DesktopMcpBridge, McpConnectionConfigKind, McpInfo, McpStatus } from '../mcp/types'
import '../mcp/settings.css'

const live = ref<McpInfo | null>(null)
const draftEnabled = ref(false)
const draftPort = ref('43127')
const available = ref(false)
const loading = ref(true)
const saving = ref(false)
const rotating = ref(false)
const copying = ref<'address' | McpConnectionConfigKind | ''>('')
const operationError = ref('')
const savedFeedback = ref('')
const clipboardFeedback = ref('')
const clipboardFailed = ref(false)
const clientKind = ref<Exclude<McpConnectionConfigKind, 'token'>>('generic')
const connectionChoices = [
  { kind: 'generic', label: 'HTTP 通用配置', hint: '复制后，将配置中的 <QY_MCP_TOKEN> 替换为下方“复制认证令牌”取得的值。' },
  { kind: 'stdio', label: 'stdio 通用配置', hint: '将 command 和 args 添加到客户端的 MCP 配置中。适配器自动读取本机的认证设置。' },
  { kind: 'codex', label: 'Codex', hint: '将 TOML 配置添加到 Codex 的 config.toml。stdio 适配器自动读取本机的认证设置。' },
  { kind: 'claude', label: 'Claude Code', hint: '将配置添加到 Claude Code 的 .mcp.json。stdio 适配器自动读取本机的认证设置。' },
  { kind: 'dsh', label: 'DSH', hint: '作为 Cordis overlay 导入 DSH，配置使用 @deepseek-ai/dsh-mcp-client 的 stdio 传输。' },
  { kind: 'zcode', label: 'Zcode', hint: '合并到 Zcode 的 ~/.zcode/cli/config.json，保留 mcp.servers 结构。' },
] as const
const selectedClient = computed(() => connectionChoices.find((choice) => choice.kind === clientKind.value)!)
const statusLabels: Record<McpStatus, string> = {
  disabled: '已关闭', starting: '启动中', running: '运行中', error: '连接异常',
}
const statusLabel = computed(() => live.value ? statusLabels[live.value.status] : loading.value ? '正在读取' : '未连接')
const portValue = computed(() => Number(draftPort.value))
const validPort = computed(() => Boolean(draftPort.value.trim()) && Number.isInteger(portValue.value) && portValue.value >= 1024 && portValue.value <= 65535)
const dirty = computed(() => Boolean(live.value && (live.value.enabled !== draftEnabled.value || !validPort.value || live.value.port !== portValue.value)))
const modifying = computed(() => saving.value || rotating.value)
const canApply = computed(() => Boolean(available.value && live.value && validPort.value && !loading.value && !modifying.value && !copying.value && (dirty.value || live.value.status === 'error')))
const serviceError = computed(() => live.value?.status === 'error' ? live.value.error || 'MCP 连接出现错误，请检查设置后重新应用。' : '')

let bridge: DesktopMcpBridge | undefined
let unsubscribe: (() => void) | undefined
let draftHydrated = false
let disposed = false
let revision = 0
let feedbackTimer: ReturnType<typeof setTimeout> | undefined

watch(clientKind, () => {
  clipboardFeedback.value = ''
})

function failureText(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback
}

function receiveInfo(info: McpInfo, syncDraft = false) {
  if (disposed) return
  const preserveDraft = draftHydrated && dirty.value
  live.value = {
    enabled: info.enabled, port: info.port, url: info.url, status: info.status,
    error: info.error, tokenConfigured: info.tokenConfigured,
    connected: info.connected === true,
    connectionCount: info.connectionCount ?? 0,
    lastSeenAt: info.lastSeenAt ?? null,
    connectionLeaseMs: info.connectionLeaseMs ?? 90000,
  }
  if (!draftHydrated || syncDraft || (!preserveDraft && !modifying.value)) {
    draftEnabled.value = info.enabled
    draftPort.value = String(info.port)
  }
  draftHydrated = true
}

async function refresh() {
  if (!bridge || modifying.value || disposed) return
  loading.value = true
  operationError.value = ''
  const before = revision
  try {
    const info = await bridge.info()
    if (disposed) return
    // A service event received during the request is more recent than a
    // possibly delayed reply. Never paint an older state over that event.
    if (!live.value || revision === before) receiveInfo(info)
  } catch (failure) {
    if (!disposed) operationError.value = failureText(failure, '无法读取 MCP 设置。')
  } finally {
    if (!disposed) loading.value = false
  }
}

function clearSavedFeedback() {
  savedFeedback.value = ''
}

function updatePort(event: Event) {
  // Vue coerces number-input v-model values to numbers even without .number.
  // Keep this draft as text so blank/partial input can be validated safely.
  draftPort.value = (event.target as HTMLInputElement).value
  clearSavedFeedback()
}

async function apply() {
  if (!bridge || !canApply.value) return
  const configuration = { enabled: draftEnabled.value, port: portValue.value }
  saving.value = true
  operationError.value = ''
  savedFeedback.value = ''
  try {
    const info = await bridge.configure(configuration)
    if (disposed) return
    receiveInfo(info, info.status !== 'error')
    if (info.status !== 'error') savedFeedback.value = '设置已保存并应用。'
  } catch (failure) {
    if (!disposed) operationError.value = failureText(failure, '保存 MCP 设置失败，输入已保留。')
  } finally {
    if (!disposed) saving.value = false
  }
}

async function regenerateToken() {
  if (!bridge || !live.value || modifying.value || loading.value || copying.value) return
  rotating.value = true
  operationError.value = ''
  savedFeedback.value = ''
  clipboardFeedback.value = ''
  try {
    const info = await bridge.regenerateToken()
    if (disposed) return
    receiveInfo(info)
    if (info.status === 'error') {
      if (!info.error) operationError.value = '认证设置操作未完成，请重试。'
      return
    }
    if (!info.tokenConfigured) {
      operationError.value = '未能生成认证令牌，请重试。'
      return
    }
    savedFeedback.value = '认证令牌已重置。HTTP 客户端请更新令牌；stdio 连接会自动读取最新设置。'
  } catch (failure) {
    if (!disposed) operationError.value = failureText(failure, '重置认证令牌失败，请重试。')
  } finally {
    if (!disposed) rotating.value = false
  }
}

function showClipboardFeedback(message: string, failed = false) {
  clipboardFeedback.value = message
  clipboardFailed.value = failed
  if (feedbackTimer) clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => { clipboardFeedback.value = '' }, 3500)
}

async function copy(kind: 'address' | McpConnectionConfigKind) {
  if (!bridge || copying.value || loading.value || modifying.value || !live.value) return
  if (kind !== 'address' && !live.value.tokenConfigured) return
  copying.value = kind
  clipboardFeedback.value = ''
  try {
    if (kind === 'address') {
      if (!live.value.url) throw new Error('当前 MCP 地址尚未生成。')
      await navigator.clipboard.writeText(live.value.url)
    } else {
      // Secrets exist only in this explicit copy operation's local variable.
      // They are never rendered, logged, or stored in component/app state.
      const configuration = await bridge.connectionConfig(kind)
      if (disposed) return
      if (!configuration.text) throw new Error('连接配置为空，请重新应用设置。')
      await navigator.clipboard.writeText(configuration.text)
      if (disposed) return
    }
    if (disposed) return
    const label = kind === 'address' ? 'MCP 地址' : kind === 'token' ? '认证令牌' : `${connectionChoices.find((choice) => choice.kind === kind)?.label ?? '连接'}配置`
    showClipboardFeedback(`${label}已复制。`)
  } catch (failure) {
    if (!disposed) showClipboardFeedback(failureText(failure, '复制失败，请检查剪贴板权限后重试。'), true)
  } finally {
    if (!disposed) copying.value = ''
  }
}

onMounted(async () => {
  bridge = (window as Window & { desktopMcp?: DesktopMcpBridge }).desktopMcp
  available.value = Boolean(bridge)
  if (!bridge) { loading.value = false; return }
  unsubscribe = bridge.onUpdate((info) => {
    revision += 1
    receiveInfo(info)
  })
  await refresh()
})

onBeforeUnmount(() => {
  disposed = true
  unsubscribe?.()
  if (feedbackTimer) clearTimeout(feedbackTimer)
})
</script>

<template>
  <section class="mcp-settings" aria-label="MCP 连接设置">
    <header class="mcp-settings-heading">
      <div><span class="mcp-eyebrow">本机 AI 客户端</span><h3><Server :size="19" />MCP 连接</h3><p>让支持 MCP 的客户端读取作品资料、提交创作任务并查看进度。修改计划由你在桌面端确认。</p></div>
      <button class="mcp-icon-button" type="button" title="刷新 MCP 服务状态" aria-label="刷新 MCP 服务状态" :disabled="!available || loading || modifying" @click="refresh"><RefreshCw :size="15" :class="{ spin: loading }" /></button>
    </header>

    <div v-if="!available && !loading" class="mcp-unavailable"><Server :size="23" /><strong>MCP 连接需要桌面环境</strong><span>请通过桌面程序打开设置。</span></div>
    <template v-else>
      <section class="mcp-settings-card">
        <div class="mcp-card-heading"><h4>服务设置</h4><span :class="['mcp-status', `mcp-status-${live?.status ?? 'unknown'}`]" role="status"><LoaderCircle v-if="loading || live?.status === 'starting'" :size="12" class="spin" /><span v-else class="mcp-status-dot" />{{ statusLabel }}</span></div>
        <form class="mcp-service-form" @submit.prevent="apply">
          <label class="mcp-enable-switch"><input v-model="draftEnabled" type="checkbox" role="switch" :aria-checked="draftEnabled" :disabled="loading || modifying" @change="clearSavedFeedback" /><span>启用 MCP 连接</span></label>
          <label class="mcp-port-field"><span>本机端口</span><input :value="draftPort" type="number" min="1024" max="65535" step="1" inputmode="numeric" aria-label="MCP 本机端口" :disabled="loading || modifying" @input="updatePort" /></label>
          <button class="mcp-button mcp-button-primary" type="submit" :disabled="!canApply"><LoaderCircle v-if="saving" :size="14" class="spin" /><Save v-else :size="14" />{{ saving ? '正在应用…' : live?.status === 'error' && !dirty ? '重试应用' : '保存并应用' }}</button>
        </form>
        <p v-if="!loading && !validPort" class="mcp-message mcp-message-error" role="alert">端口必须是 1024～65535 之间的整数。</p>
        <p v-if="dirty" class="mcp-draft-note">更改尚未应用，当前服务状态以右上角标识为准。</p>
        <p v-else class="mcp-helper">设置独立保存在本机，关闭和重启软件后保留，不随 .qy 作品集导出。</p>
      </section>

      <p v-if="operationError" class="mcp-message mcp-message-error" role="alert">{{ operationError }}</p>
      <p v-if="serviceError && serviceError !== operationError" class="mcp-message mcp-message-error" role="alert">{{ serviceError }}</p>
      <p v-if="savedFeedback" class="mcp-message mcp-message-success" role="status"><Check :size="13" />{{ savedFeedback }}</p>

      <section class="mcp-settings-card">
        <div class="mcp-card-heading"><h4><Link :size="14" />客户端连接</h4><small>只接受本机连接</small></div>
        <div class="mcp-address-field"><span>{{ live?.status === 'running' ? '当前 MCP 地址' : 'MCP 配置地址' }}</span><div><code>{{ live?.url || (loading ? '正在读取…' : '尚未生成') }}</code><button class="mcp-icon-button" type="button" title="复制 MCP 地址" aria-label="复制 MCP 地址" :disabled="!live?.url || Boolean(copying) || loading || modifying" @click="copy('address')"><Copy :size="14" /></button></div></div>
        <div class="mcp-client-config">
          <label><span>客户端类型</span><select v-model="clientKind" aria-label="MCP 客户端类型" :disabled="Boolean(copying)"><option v-for="choice in connectionChoices" :key="choice.kind" :value="choice.kind">{{ choice.label }}</option></select></label>
          <button class="mcp-button" type="button" title="复制当前已保存的连接配置" :disabled="!live?.tokenConfigured || Boolean(copying) || loading || modifying" @click="copy(clientKind)"><LoaderCircle v-if="copying === clientKind" :size="13" class="spin" /><Copy v-else :size="13" />复制连接配置</button>
        </div>
        <p class="mcp-helper">{{ selectedClient.hint }}</p>
      </section>

      <section class="mcp-settings-card">
        <div class="mcp-card-heading"><h4><LockKeyhole :size="14" />连接认证</h4><span class="mcp-token-state">{{ loading ? '正在读取…' : live?.tokenConfigured ? '令牌已生成' : '尚未生成令牌' }}</span></div>
        <div class="mcp-copy-actions">
          <button class="mcp-button" type="button" :disabled="!live?.tokenConfigured || Boolean(copying) || loading || modifying" @click="copy('token')"><LoaderCircle v-if="copying === 'token'" :size="13" class="spin" /><KeyRound v-else :size="13" />复制认证令牌</button>
          <button class="mcp-button" type="button" :disabled="!live || Boolean(copying) || loading || modifying" @click="regenerateToken"><LoaderCircle v-if="rotating" :size="13" class="spin" /><RefreshCw v-else :size="13" />{{ live?.tokenConfigured ? '重置认证令牌' : '生成认证令牌' }}</button>
        </div>
        <p class="mcp-helper">令牌仅在点击复制时写入系统剪贴板。重置后，HTTP 客户端需要更新令牌，stdio 连接会自动读取最新设置。</p>
      </section>

      <p v-if="clipboardFeedback" :class="['mcp-message', clipboardFailed ? 'mcp-message-error' : 'mcp-message-success']" :role="clipboardFailed ? 'alert' : 'status'"><Check v-if="!clipboardFailed" :size="13" />{{ clipboardFeedback }}</p>
      <p class="mcp-footer-note">保持软件运行后，客户端才能通过 MCP 访问当前作品。任务进度和修改计划可在控制台查看。</p>
    </template>
  </section>
</template>
