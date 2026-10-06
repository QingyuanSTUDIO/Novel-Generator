<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, Database, FileText, LockKeyhole, MessageSquare, X } from 'lucide-vue-next'
import type { ContextBudgetReport } from '../api/contextBudget'
import type { ContextPreviewSnapshot } from '../context/contextPreview'

const props = withDefaults(defineProps<{
  preview: ContextPreviewSnapshot | null | undefined
  budget?: ContextBudgetReport | null
  compact?: boolean
  title?: string
}>(), {
  preview: null,
  budget: null,
  compact: false,
  title: '本次上下文资料',
})

const open = ref(false)
const purposeLabel = computed(() => props.preview?.purpose === 'agent' ? 'Agent' : props.preview?.purpose === 'worldEngine' ? '世界引擎' : '正文')
const effectiveBudget = computed(() => props.budget ?? props.preview?.budget ?? null)
const shownSkipped = computed(() => props.preview?.skipped ?? [])
const shownParts = computed(() => props.preview?.parts ?? [])
const usedTokens = computed(() => props.preview?.estimatedInputTokens ?? effectiveBudget.value?.estimatedInputTokens ?? 0)
const retrievalTokens = computed(() => props.preview?.retrievalTokens ?? 0)
const budgetPercent = computed(() => {
  const budget = effectiveBudget.value
  if (!budget || !Number.isFinite(budget.contextTokens) || budget.contextTokens <= 0) return null
  return Math.min(100, Math.max(0, usedTokens.value / budget.contextTokens * 100))
})
function formatTokens(value: number | undefined | null) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : '—'
}
function roleLabel(role: string) {
  return role === 'system' ? '系统' : role === 'user' ? '用户' : '助手'
}
function skipLabel(reason: string) {
  if (reason === 'disabled') return '已禁用'
  if (reason === 'max-results') return '条数预算'
  if (reason === 'max-tokens') return '资料 Token 预算'
  if (reason === 'layout-disabled') return '编排中关闭'
  return reason
}
</script>

<template>
  <section v-if="props.preview" class="context-preview" :class="{ compact: props.compact }">
    <button class="context-preview-toggle" type="button" :aria-expanded="open" @click="open = !open">
      <span class="context-preview-toggle-main"><Database :size="14" /><span class="context-preview-toggle-title"><strong>{{ props.title }}</strong><small>{{ purposeLabel }}</small></span></span>
      <span class="context-preview-toggle-stats">{{ props.preview.resources.length }} 条命中 · {{ formatTokens(usedTokens) }} Token <ChevronDown :size="14" :class="{ rotated: open }" /></span>
    </button>
    <div v-if="open" class="context-preview-body">
      <div class="context-preview-summary">
        <span>命中资料 <b>{{ props.preview.resources.length }}</b></span>
        <span>检索资料 <b>{{ formatTokens(retrievalTokens) }}</b></span>
        <span>跳过 <b>{{ shownSkipped.length }}</b></span>
        <span>消息 <b>{{ props.preview.messages.length }}</b></span>
      </div>
      <div v-if="effectiveBudget" class="context-preview-budget">
        <div class="context-preview-budget-head"><span>上下文预算</span><strong>{{ formatTokens(usedTokens) }} / {{ formatTokens(effectiveBudget.contextTokens) }} Token</strong></div>
        <div class="context-preview-progress"><i :style="{ width: `${budgetPercent ?? 0}%` }"></i></div>
        <small>输入预算 {{ formatTokens(effectiveBudget.inputBudget) }} · 预留回复 {{ formatTokens(effectiveBudget.maxTokens) }} · 安全余量 {{ formatTokens(effectiveBudget.safetyTokens) }}</small>
      </div>
      <div class="context-preview-section">
        <div class="context-preview-section-head"><span><Database :size="12" />实际注入资料</span><small>按编排顺序</small></div>
        <div v-if="props.preview.resources.length" class="context-preview-resources">
          <div v-for="resource in props.preview.resources" :key="`${resource.collection}:${resource.id}`" class="context-preview-resource">
            <span class="context-preview-resource-icon"><FileText :size="12" /></span>
            <div><strong>{{ resource.title }}</strong><small>{{ resource.collection }} · {{ resource.matchType === 'direct' ? '直接命中' : `递归 ${resource.depth} 层` }} · {{ resource.matchedKeys.join('、') || '常驻' }}</small></div>
            <b>{{ formatTokens(resource.estimatedTokens) }}</b>
          </div>
        </div>
        <p v-else class="context-preview-empty">本次没有命中的卡片资料。</p>
      </div>
      <div v-if="shownSkipped.length" class="context-preview-section">
        <div class="context-preview-section-head"><span><LockKeyhole :size="12" />未注入候选</span><small>{{ shownSkipped.length }} 条</small></div>
        <div class="context-preview-skipped">
          <div v-for="resource in shownSkipped" :key="`${resource.collection}:${resource.id}:${resource.reason}`" class="context-preview-skipped-item"><span>{{ resource.title }}</span><small>{{ skipLabel(resource.reason) }} · {{ resource.matchedKeys.join('、') || '命中' }} · {{ formatTokens(resource.estimatedTokens) }} Token</small></div>
        </div>
      </div>
      <details class="context-preview-details">
        <summary><MessageSquare :size="12" />查看发送分段（{{ props.preview.messages.length }} 段）</summary>
        <div class="context-preview-messages">
          <article v-for="(message, index) in props.preview.messages" :key="`${message.role}-${index}`"><header><strong>{{ roleLabel(message.role) }}</strong><b>{{ formatTokens(message.estimatedTokens) }} Token</b></header><p>{{ message.preview || '（空）' }}</p></article>
        </div>
      </details>
      <div v-if="shownParts.length" class="context-preview-parts"><span v-for="part in shownParts" :key="`${part.collection}:${part.rank}:${part.label}`" :title="part.text">{{ part.label }} · {{ formatTokens(part.estimatedTokens) }}</span></div>
    </div>
  </section>
  <div v-else class="context-preview-placeholder"><X :size="13" />尚未生成本次上下文预览</div>
</template>

<style scoped>
.context-preview { min-width: 0; border: 1px solid var(--theme-border); border-radius: 7px; color: var(--theme-font); background: var(--theme-surface); }
.context-preview-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border: 0; color: var(--theme-font); background: transparent; cursor: pointer; text-align: left; }
.context-preview-toggle-main, .context-preview-toggle-stats, .context-preview-section-head, .context-preview-budget-head { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }\n.context-preview-toggle-title { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; gap: 1px; writing-mode: horizontal-tb; }
.context-preview-toggle-main svg, .context-preview-section-head svg { flex: 0 0 auto; color: var(--theme-button); }
.context-preview-toggle-main strong { display: block; overflow: hidden; max-width: 100%; font-size: 11px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.context-preview-toggle-main small, .context-preview-toggle-stats, .context-preview-section-head small { color: var(--theme-muted); font-size: 9px; }
.context-preview-toggle-stats { flex: 0 0 auto; }
.context-preview-toggle-stats svg { transition: transform .16s ease; }
.context-preview-toggle-stats svg.rotated { transform: rotate(180deg); }
.context-preview-body { display: grid; gap: 10px; padding: 0 10px 10px; border-top: 1px solid var(--theme-border-soft); }
.context-preview-summary { display: flex; flex-wrap: wrap; gap: 5px 14px; padding-top: 9px; color: var(--theme-muted); font-size: 9px; }
.context-preview-summary b { color: var(--theme-font); font-weight: 600; }
.context-preview-budget { display: grid; gap: 5px; }
.context-preview-budget-head { justify-content: space-between; color: var(--theme-muted); font-size: 9px; }
.context-preview-budget-head strong { color: var(--theme-font); font-size: 10px; }
.context-preview-progress { height: 4px; overflow: hidden; border-radius: 4px; background: var(--theme-border); }
.context-preview-progress i { display: block; height: 100%; border-radius: inherit; background: var(--theme-button); }
.context-preview-budget small { color: var(--theme-muted); font-size: 9px; }
.context-preview-section { display: grid; gap: 6px; min-width: 0; }
.context-preview-section-head { justify-content: space-between; color: var(--theme-font); font-size: 10px; font-weight: 600; }
.context-preview-resources, .context-preview-skipped, .context-preview-messages { display: grid; gap: 4px; }
.context-preview-resource { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 4px; background: var(--theme-surface-soft); }
.context-preview-resource-icon { display: grid; place-items: center; color: var(--theme-button); }
.context-preview-resource div { min-width: 0; }
.context-preview-resource strong, .context-preview-resource small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-preview-resource strong { color: var(--theme-font); font-size: 10px; }
.context-preview-resource small, .context-preview-resource > b { color: var(--theme-muted); font-size: 9px; }
.context-preview-resource > b { font-variant-numeric: tabular-nums; }
.context-preview-skipped-item { display: flex; justify-content: space-between; gap: 8px; padding: 4px 6px; color: var(--theme-muted); background: var(--theme-neutral-soft); font-size: 9px; }
.context-preview-skipped-item span { min-width: 0; overflow: hidden; color: var(--theme-font); text-overflow: ellipsis; white-space: nowrap; }
.context-preview-skipped-item small { flex: 0 0 auto; }
.context-preview-empty, .context-preview-placeholder { display: inline-flex; align-items: center; gap: 5px; margin: 0; color: var(--theme-muted); font-size: 9px; }
.context-preview-details { border-top: 1px solid var(--theme-border-soft); padding-top: 7px; }
.context-preview-details summary { display: inline-flex; align-items: center; gap: 5px; color: var(--theme-button); font-size: 9px; cursor: pointer; }
.context-preview-messages article { padding: 6px; border-radius: 4px; background: var(--theme-surface-soft); }
.context-preview-messages header { display: flex; justify-content: space-between; gap: 8px; color: var(--theme-muted); font-size: 9px; }
.context-preview-messages header strong { color: var(--theme-font); }
.context-preview-messages p { max-height: 90px; overflow: auto; margin: 4px 0 0; color: var(--theme-muted); font-size: 9px; line-height: 1.45; white-space: pre-wrap; }
.context-preview-parts { display: flex; flex-wrap: wrap; gap: 4px; }
.context-preview-parts span { padding: 2px 5px; border-radius: 3px; color: var(--theme-muted); background: var(--theme-neutral-soft); font-size: 8px; }
.context-preview-placeholder { padding: 8px; }
.context-preview.compact .context-preview-body { max-height: 440px; overflow: auto; }
</style>


