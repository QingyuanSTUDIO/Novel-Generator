import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import type { Resource } from '../types.ts'
import type { ChatMessage } from '../api/chat.ts'
import { prepareContextBudget } from '../api/contextBudget.ts'
import { currentChatMetricsId, subscribeChatMetrics, type ChatMetrics } from '../api/chatMetrics.ts'
import { readModelSettings } from '../api/modelSettings.ts'

type ContextMetricsOptions = {
  provider: Readonly<Ref<Resource | undefined>>
  scopeKey: Readonly<Ref<string>>
  purposes: readonly string[]
  messages: () => ChatMessage[] | null
}

/**
 * Current-input estimates and last-response statistics remain separate.
 * Scope switches clear the view, and old in-flight responses cannot repopulate
 * it. Only labels/counts are observed, never prompts or credentials.
 */
export function useContextMetrics(options: ContextMetricsOptions) {
  let scopeWatermark = currentChatMetricsId()
  const latest = shallowRef<ChatMetrics | null>(null)
  const acceptedRequests = new Set<number>()
  const preview = computed(() => {
    const provider = options.provider.value
    if (!provider) return { budget: null, error: '' }
    try {
      const settings = readModelSettings(provider)
      const messages = options.messages()
      return { budget: messages ? prepareContextBudget(messages, settings).report : null, error: '' }
    } catch (error) {
      return { budget: null, error: error instanceof Error ? error.message : '无法估算上下文。' }
    }
  })
  const unsubscribe = subscribeChatMetrics((metrics) => {
    if (metrics.requestId <= scopeWatermark) return
    if (metrics.providerId !== options.provider.value?.id || !options.purposes.includes(metrics.purpose)) return
    if (metrics.status === 'running') acceptedRequests.add(metrics.requestId)
    else if (!acceptedRequests.delete(metrics.requestId)) return
    if (latest.value && metrics.requestId < latest.value.requestId) return
    latest.value = metrics
  })
  const stopWatch = watch([
    options.scopeKey,
    () => options.provider.value?.id,
    () => options.provider.value?.fields['模型'],
    () => options.provider.value?.fields['协议'],
    () => options.provider.value?.fields['接口地址'],
  ], () => {
    scopeWatermark = currentChatMetricsId()
    latest.value = null
    acceptedRequests.clear()
  }, { flush: 'sync' })
  if (getCurrentScope()) onScopeDispose(() => {
    unsubscribe()
    stopWatch()
    acceptedRequests.clear()
  })
  const budget = computed(() => latest.value?.status === 'running' ? latest.value.budget : preview.value.budget)
  const usage = computed(() => latest.value?.usage ?? null)
  const status = computed(() => latest.value?.status ?? 'preview')
  const budgetLabel = computed(() => latest.value?.status === 'running' ? '本次请求上下文预算' : '当前输入上下文预算')
  const error = computed(() => preview.value.error)
  return { latest, budget, usage, status, budgetLabel, error }
}
