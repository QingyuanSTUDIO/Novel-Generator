import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { Resource } from '../types.ts'
import { requestModelLimits } from '../api/modelLimits.ts'
import { applyModelLimits } from '../api/applyModelLimits.ts'

type Options = {
  provider: Readonly<Ref<Resource | undefined>>
  localApiUrl: (path: string) => string
  persist: () => void
}

function queryIdentity(provider: Resource | undefined) {
  if (!provider) return ''
  const fields = provider.fields
  // Used for comparison only, never logged or displayed.
  return JSON.stringify([provider.id, ...[
    '协议', '接口地址', '模型', 'API Key', '使用代理', '代理地址', '代理端口',
  ].map((key) => fields[key] ?? '')])
}

/** A late metadata response must never overwrite another preset or manual edits. */
export function useModelLimits(options: Options) {
  const busy = ref(false)
  const message = ref('')
  const error = ref('')
  let epoch = 0
  let controller: AbortController | undefined
  function reset() {
    epoch += 1
    controller?.abort()
    controller = undefined
    busy.value = false
    message.value = ''
    error.value = ''
  }
  const stopWatch = watch([
    () => options.provider.value,
    () => queryIdentity(options.provider.value),
  ], reset, { flush: 'sync' })
  if (getCurrentScope()) onScopeDispose(() => { reset(); stopWatch() })

  async function fetchLimits() {
    if (busy.value) return
    const provider = options.provider.value
    if (!provider) return
    const fields = { ...provider.fields }
    const identity = queryIdentity(provider)
    const id = ++epoch
    const currentController = new AbortController()
    controller = currentController
    busy.value = true
    message.value = ''
    error.value = ''
    try {
      const result = await requestModelLimits(options.localApiUrl, { fields }, currentController.signal)
      if (id !== epoch || currentController.signal.aborted || provider !== options.provider.value || identity !== queryIdentity(options.provider.value)) return
      const parts = [result.message]
      if (result.maxOutputTokens) parts.push(`服务器最大输出：${result.maxOutputTokens.toLocaleString()} Token。`)
      if (result.maxInputTokens) parts.push(`服务器独立输入上限：${result.maxInputTokens.toLocaleString()} Token。`)
      if (!result.contextTokens) {
        message.value = parts.join(' ')
        return
      }
      if (result.contextKind === 'input_limit') {
        parts.push('返回的是输入上限，先以此值作为保守上下文预算，并继续预留回复空间。')
      }
      if (provider.fields['上下文长度'] !== fields['上下文长度'] || provider.fields['最大回复长度'] !== fields['最大回复长度']) {
        parts.push(`查询期间你修改了预算，已保留修改。服务器返回的上限为 ${result.contextTokens.toLocaleString()} Token。`)
        message.value = parts.join(' ')
        return
      }
      const applied = applyModelLimits(provider.fields, {
        contextTokens: result.contextTokens,
        maxInputTokens: result.maxInputTokens,
        maxOutputTokens: result.maxOutputTokens,
      })
      Object.assign(provider.fields, applied.patch)
      parts.push(`上下文预算已填入 ${applied.contextTokens.toLocaleString()} Token。`, ...applied.notices)
      message.value = parts.join(' ')
      options.persist()
    } catch (value) {
      if (id !== epoch || currentController.signal.aborted) return
      error.value = value instanceof Error ? value.message : '获取模型上限失败。'
    } finally {
      if (id === epoch) {
        busy.value = false
        controller = undefined
      }
    }
  }
  return { busy, message, error, fetchLimits }
}
