<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { Info, X } from 'lucide-vue-next'
import type { ContextBudgetReport } from '../api/contextBudget'
import type { ChatUsage } from '../api/chatUsage'

const props = withDefaults(defineProps<{
  budget: ContextBudgetReport | null
  usage?: ChatUsage | null
  label?: string
  budgetLabel?: string
  status?: 'preview' | 'running' | 'done' | 'error'
}>(), {
  usage: null,
  label: '上下文',
  budgetLabel: '当前上下文预算',
  status: 'preview',
})

const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const open = ref(false)
const panelPosition = ref({ left: 12, top: 12, maxHeight: 500 })
const panelId = useId()
let pointerStartedOutside = false
const circumference = 2 * Math.PI * 8
const percent = computed(() => {
  const value = props.budget?.usedPercent
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
})
const ringOffset = computed(() => circumference * (1 - Math.min(percent.value ?? 0, 100) / 100))
const percentageLabel = computed(() => percent.value === null ? '尚未估算' : `约 ${Math.round(percent.value)}%`)
const remainingLabel = computed(() => {
  const remaining = props.budget?.remainingTokens
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return ''
  return remaining >= 0 ? `输入余量 ${compactTokens(remaining)}` : `输入超出 ${compactTokens(-remaining)}`
})
const indicatorLabel = computed(() => `${props.label} · 输入占窗口 ${percentageLabel.value}${remainingLabel.value ? ` · ${remainingLabel.value} Token` : ''}`)
const warning = computed(() => Boolean(props.budget && props.budget.remainingTokens <= props.budget.inputBudget * 0.15))
const overBudget = computed(() => (props.budget?.remainingTokens ?? 0) < 0)
const panelStyle = computed(() => ({
  left: `${panelPosition.value.left}px`,
  top: `${panelPosition.value.top}px`,
  maxHeight: `${panelPosition.value.maxHeight}px`,
}))

function formatTokens(value: number | undefined | null, missing = '未知') {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : missing
}

function compactTokens(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
  return String(Math.round(value))
}

function updatePanelPosition() {
  if (!open.value || !trigger.value) return
  const anchor = trigger.value.getBoundingClientRect()
  const panelWidth = Math.min(330, window.innerWidth - 24)
  const panelHeight = Math.min(panel.value?.scrollHeight ?? 500, window.innerHeight - 24)
  const below = window.innerHeight - anchor.bottom - 16
  const above = anchor.top - 16
  const placeBelow = below >= panelHeight || below >= above
  const available = Math.max(80, placeBelow ? below : above)
  const visibleHeight = Math.min(panelHeight, available)
  const left = Math.max(12, Math.min(anchor.right - panelWidth, window.innerWidth - panelWidth - 12))
  const top = placeBelow ? anchor.bottom + 8 : Math.max(12, anchor.top - visibleHeight - 8)
  panelPosition.value = { left, top, maxHeight: available }
}

async function togglePanel() {
  open.value = !open.value
  if (open.value) {
    updatePanelPosition()
    await nextTick()
    updatePanelPosition()
  }
}

function isInside(target: EventTarget | null) {
  return target instanceof Node && Boolean(trigger.value?.contains(target) || panel.value?.contains(target))
}

function rememberPointerDown(event: PointerEvent) {
  pointerStartedOutside = !isInside(event.target)
}

function closeOnOutsideClick(event: MouseEvent) {
  if (open.value && pointerStartedOutside && !isInside(event.target)) open.value = false
  pointerStartedOutside = false
}

function closeOnEscape(event: KeyboardEvent) {
  if (!open.value || event.key !== 'Escape') return
  event.preventDefault()
  open.value = false
  trigger.value?.focus()
}

onMounted(() => {
  document.addEventListener('pointerdown', rememberPointerDown, true)
  document.addEventListener('click', closeOnOutsideClick, true)
  document.addEventListener('keydown', closeOnEscape)
  window.addEventListener('resize', updatePanelPosition)
  window.addEventListener('scroll', updatePanelPosition, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', rememberPointerDown, true)
  document.removeEventListener('click', closeOnOutsideClick, true)
  document.removeEventListener('keydown', closeOnEscape)
  window.removeEventListener('resize', updatePanelPosition)
  window.removeEventListener('scroll', updatePanelPosition, true)
})
</script>

<template>
  <div class="context-usage-indicator" :class="{ running: props.status === 'running', warning, error: props.status === 'error' || overBudget }">
    <button ref="trigger" class="context-usage-trigger" type="button" :title="`${indicatorLabel}；点击查看详情`" :aria-label="`${indicatorLabel}，查看上下文与接口用量`" :aria-expanded="open" :aria-controls="panelId" @click.stop="togglePanel">
      <svg class="context-usage-ring" viewBox="0 0 20 20" aria-hidden="true">
        <circle class="context-usage-ring-track" cx="10" cy="10" r="8" />
        <circle class="context-usage-ring-fill" cx="10" cy="10" r="8" :stroke-dasharray="circumference" :stroke-dashoffset="ringOffset" />
      </svg>
      <span class="context-usage-label">{{ props.label }}</span>
      <strong>{{ percentageLabel }}</strong>
      <span v-if="remainingLabel" class="context-usage-remaining">{{ remainingLabel }} <small>Token</small></span>
    </button>
    <Teleport to="body">
      <section v-if="open" :id="panelId" ref="panel" class="context-usage-popover" :style="panelStyle" role="region" :aria-label="`${props.label}用量详情`" @click.stop>
        <div class="context-usage-head"><strong>上下文与用量</strong><button type="button" title="关闭用量详情" aria-label="关闭用量详情" @click="open = false"><X :size="14" /></button></div>
        <div class="context-usage-section-title">{{ props.budgetLabel }} <span>估算</span></div>
        <div v-if="props.budget" class="context-usage-progress" :class="{ warning, error: overBudget }"><span :style="{ width: `${Math.min(percent ?? 0, 100)}%` }"></span></div>
        <dl v-if="props.budget" class="context-usage-values">
          <div><dt>设定上下文总量</dt><dd>{{ formatTokens(props.budget?.contextTokens) }}</dd></div>
          <div><dt>估算输入</dt><dd>约 {{ formatTokens(props.budget?.estimatedInputTokens) }}</dd></div>
          <div><dt>预留回复</dt><dd>{{ formatTokens(props.budget?.maxTokens) }}</dd></div>
          <div><dt>安全余量</dt><dd>{{ formatTokens(props.budget?.safetyTokens) }}</dd></div>
          <div><dt>对话记忆已用</dt><dd>约 {{ formatTokens(props.budget?.historyTokensUsed) }}</dd></div>
          <div><dt>裁掉旧历史消息</dt><dd>{{ formatTokens(props.budget?.trimmedMessages) }} 条</dd></div>
          <div class="context-usage-emphasis"><dt>{{ (props.budget?.remainingTokens ?? 0) < 0 ? '输入超出预算' : '剩余输入余量' }}</dt><dd>约 {{ formatTokens(props.budget ? Math.abs(props.budget.remainingTokens) : undefined) }} Token</dd></div>
        </dl>
        <p v-else class="context-usage-note">尚未生成当前输入的上下文预算。</p>
        <p class="context-usage-note"><Info :size="12" /><span>使用率指估算输入占所设窗口的比例。输入余量已扣除预留回复和安全空间；实际 Token 数以接口统计为准。</span></p>
        <div class="context-usage-section-title context-usage-server-title">上次请求接口统计</div>
        <dl class="context-usage-values">
          <div><dt>输入 Token</dt><dd>{{ formatTokens(props.usage?.inputTokens, '接口未返回') }}</dd></div>
          <div><dt>输出 Token</dt><dd>{{ formatTokens(props.usage?.outputTokens, '接口未返回') }}</dd></div>
          <div><dt>合计 Token</dt><dd>{{ formatTokens(props.usage?.totalTokens, '接口未返回') }}</dd></div>
          <div><dt>缓存命中</dt><dd>{{ formatTokens(props.usage?.cachedInputTokens, '未知') }}</dd></div>
          <div><dt>缓存写入</dt><dd>{{ formatTokens(props.usage?.cacheWriteTokens, '未知') }}</dd></div>
          <div v-if="props.usage?.reasoningTokens !== undefined"><dt>思考 Token</dt><dd>{{ formatTokens(props.usage.reasoningTokens, '未知') }}</dd></div>
        </dl>
        <p class="context-usage-note">接口统计属于上次请求，不代表当前输入的精确占用；未返回缓存数据时不能判断是否命中缓存。</p>
      </section>
    </Teleport>
  </div>
</template>

<style scoped>
.context-usage-indicator { min-width: 0; display: inline-flex; color: var(--theme-font); }
.context-usage-trigger { min-width: 0; display: inline-flex; align-items: center; gap: 5px; padding: 4px 6px; border: 0; border-radius: 5px; color: var(--theme-font); background: transparent; cursor: pointer; font-size: 10px; line-height: 1.4; white-space: nowrap; }
.context-usage-trigger:hover, .context-usage-trigger[aria-expanded="true"] { background: var(--theme-hover); }
.context-usage-trigger:focus-visible { outline: 2px solid var(--theme-button); outline-offset: 2px; }
.context-usage-trigger strong { color: var(--theme-font); font-weight: 500; }
.context-usage-label, .context-usage-remaining { color: var(--theme-muted); }
.context-usage-remaining small { font-size: 9px; }
.context-usage-ring { width: 20px; height: 20px; flex: 0 0 auto; transform: rotate(-90deg); }
.context-usage-ring circle { fill: none; stroke-width: 2; }
.context-usage-ring-track { stroke: var(--theme-border); }
.context-usage-ring-fill { stroke: var(--theme-button); stroke-linecap: round; transition: stroke-dashoffset .18s ease; }
.context-usage-indicator.warning .context-usage-ring-fill { stroke: var(--theme-warning); }
.context-usage-indicator.error .context-usage-ring-fill { stroke: var(--theme-danger); }
.context-usage-popover { position: fixed; z-index: 1600; width: min(330px, calc(100vw - 24px)); min-width: 0; overflow: auto; overscroll-behavior: contain; padding: 13px 14px; border: 1px solid var(--theme-border); border-radius: 9px; color: var(--theme-font); background: var(--theme-surface); box-shadow: 0 8px 26px color-mix(in srgb, var(--theme-font) 14%, transparent); font-size: 11px; -webkit-app-region: no-drag; }
.context-usage-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.context-usage-head > strong { color: var(--theme-font); font-size: 12px; font-weight: 600; }
.context-usage-head button { display: grid; place-items: center; padding: 3px; border: 0; border-radius: 4px; color: var(--theme-button); background: transparent; cursor: pointer; }
.context-usage-head button:hover { background: var(--theme-hover); }
.context-usage-section-title { display: flex; align-items: center; gap: 6px; color: var(--theme-font); font-size: 11px; font-weight: 500; }
.context-usage-section-title > span { padding: 1px 4px; border-radius: 3px; color: var(--theme-muted); background: var(--theme-neutral-soft); font-size: 9px; font-weight: 400; }
.context-usage-progress { height: 4px; margin: 9px 0 11px; overflow: hidden; border-radius: 5px; background: var(--theme-border); }
.context-usage-progress > span { display: block; height: 100%; border-radius: inherit; background: var(--theme-button); }
.context-usage-progress.warning > span { background: var(--theme-warning); }
.context-usage-progress.error > span { background: var(--theme-danger); }
.context-usage-values { display: flex; flex-direction: column; gap: 7px; margin: 10px 0 0; }
.context-usage-values > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.context-usage-values dt { color: var(--theme-muted); font-size: 10px; }
.context-usage-values dd { margin: 0; color: var(--theme-font); font-size: 10px; text-align: right; font-variant-numeric: tabular-nums; }
.context-usage-values .context-usage-emphasis { margin-top: 3px; padding-top: 8px; border-top: 1px solid var(--theme-border); }
.context-usage-values .context-usage-emphasis dt, .context-usage-values .context-usage-emphasis dd { color: var(--theme-button); font-weight: 500; }
.context-usage-note { display: flex; align-items: flex-start; gap: 5px; margin: 10px 0 0; color: var(--theme-muted); font-size: 9px; line-height: 1.6; }
.context-usage-note svg { flex: 0 0 auto; margin-top: 1px; color: var(--theme-button); }
.context-usage-server-title { margin-top: 15px; padding-top: 12px; border-top: 1px solid var(--theme-border); }
@media (max-width: 700px) {
  .context-usage-label { display: none; }
  .context-usage-trigger { gap: 4px; padding-inline: 4px; }
}
@media (prefers-reduced-motion: reduce) {
  .context-usage-ring-fill { transition: none; }
}
</style>
