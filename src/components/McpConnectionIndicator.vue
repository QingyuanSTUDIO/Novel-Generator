<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { McpInfo } from '../mcp/types'
import '../mcp/indicator.css'

const info = ref({
  enabled: false,
  status: 'disabled' as McpInfo['status'],
  connected: false,
  connectionCount: 0,
  connectionLeaseMs: 90000,
})
let removeListener: (() => void) | undefined
let updates = 0
let disposed = false

function update(value: McpInfo) {
  // Retain only public state used by this indicator, never connection configs.
  info.value = {
    enabled: value.enabled === true,
    status: value.status,
    connected: value.connected === true,
    connectionCount: Number.isFinite(value.connectionCount) ? Math.max(0, value.connectionCount) : 0,
    connectionLeaseMs: Number.isFinite(value.connectionLeaseMs) ? value.connectionLeaseMs : 90000,
  }
}

const connected = computed(() => info.value.connected && info.value.connectionCount > 0)
const label = computed(() => connected.value ? 'MCP 已连接' : 'MCP 未连接')
const tooltip = computed(() => {
  const seconds = Math.round(info.value.connectionLeaseMs / 1000)
  const details = `按认证成功的 MCP 请求判断活跃，${seconds} 秒无请求会显示未连接。stdio 接入每 20 秒发送心跳，退出后立即撤销；直接 HTTP 没有心跳时按最近请求判断，未提供客户端 ID 的请求合为一组。`
  if (connected.value) return `${info.value.connectionCount} 个活跃连接组。${details}`
  if (info.value.status === 'starting') return `MCP 服务正在启动。${details}`
  if (info.value.status === 'error') return `MCP 服务当前不可用，请检查“设置 → MCP 连接”。${details}`
  if (!info.value.enabled || info.value.status === 'disabled') return `MCP 未启用，请在“设置 → MCP 连接”中开启。${details}`
  return `MCP 服务已启动，尚未检测到外部客户端活跃请求。${details}`
})

onMounted(async () => {
  const bridge = window.desktopMcp
  if (!bridge) return
  try {
    removeListener = bridge.onUpdate((value) => {
      if (disposed) return
      updates += 1
      update(value)
    })
    const requestedAt = updates
    const snapshot = await bridge.info()
    // A later push notification is newer than the in-flight IPC snapshot.
    if (!disposed && updates === requestedAt) update(snapshot)
  } catch {
    if (!disposed && updates === 0) info.value.status = 'error'
  }
})

onBeforeUnmount(() => {
  disposed = true
  removeListener?.()
})
</script>

<template>
  <span :class="['mcp-connection-indicator', { connected }]" role="status" aria-live="polite" :aria-label="label" :title="tooltip">
    <span class="mcp-connection-dot" aria-hidden="true"></span>
    <span>{{ label }}</span>
  </span>
</template>
