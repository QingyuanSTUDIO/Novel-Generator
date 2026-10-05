<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown, Download, Info, LoaderCircle, RotateCcw, SlidersHorizontal } from 'lucide-vue-next'
import { defaultModelSettings, readModelSettings } from '../api/modelSettings'

const props = defineProps<{
  fields: Record<string, string>
  modelLimitsBusy?: boolean
  modelLimitsMessage?: string
  modelLimitsError?: string
}>()
const emit = defineEmits<{
  updateField: [key: string, value: string]
  fetchModelLimits: []
}>()

const protocol = computed(() => props.fields['协议'] || 'OpenAI Compatible')
const isAnthropic = computed(() => protocol.value === 'Anthropic')
const isOpenAICompatible = computed(() => ['OpenAI Compatible', '自定义 HTTP'].includes(protocol.value))

const tokenFields = [
  { key: '上下文长度', fallback: defaultModelSettings.contextTokens, min: 1024, max: 10000000, hint: '模型能接收的输入与输出总量' },
  { key: '最大回复长度', fallback: defaultModelSettings.maxTokens, min: 1, max: 1000000, hint: '为每次回复预留的 Token 上限' },
  { key: '对话记忆预算', fallback: defaultModelSettings.historyTokens, min: 0, max: 10000000, hint: '由你设置旧对话的预算；0 表示不带旧对话' },
] as const

const samplingFields = computed(() => [
  { key: '温度', min: 0, max: isAnthropic.value ? 1 : 2, step: 0.01, initial: 0.7, hint: '较低更稳定，较高更发散', unsupported: false },
  { key: 'Top P', min: 0, max: 1, step: 0.01, initial: 0.9, hint: '限制采样候选范围，可只调整温度', unsupported: false },
  { key: '频率惩罚', min: -2, max: 2, step: 0.01, initial: 0, hint: '正值降低反复使用相同词语的倾向', unsupported: isAnthropic.value },
  { key: '存在惩罚', min: -2, max: 2, step: 0.01, initial: 0, hint: '正值鼓励使用尚未出现的内容', unsupported: isAnthropic.value },
])

function isCustom(key: string) {
  return Boolean(props.fields[key]?.trim())
}

function setCustom(key: string, enabled: boolean, initial: number) {
  emit('updateField', key, enabled ? String(initial) : '')
}

function resetSampling() {
  for (const key of ['温度', 'Top P', '频率惩罚', '存在惩罚']) emit('updateField', key, '')
}

const settingsError = computed(() => {
  try {
    const settings = readModelSettings({ fields: props.fields })
    if (isAnthropic.value && settings.temperature !== undefined && settings.temperature > 1) {
      return 'Anthropic 的温度范围为 0～1，请调整温度或使用模型默认值。'
    }
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : '生成参数有误，请检查后保存。'
  }
})
</script>

<template>
  <section class="provider-generation-settings" aria-label="模型生成设置">
    <div class="generation-section-heading">
      <div class="generation-section-heading-copy">
        <SlidersHorizontal :size="15" />
        <div><h4>上下文与回复</h4><p>每个 API 预设分别保存，写作与 Agent 共用所选预设的参数。</p></div>
      </div>
      <button class="button secondary generation-limits-fetch" type="button" :disabled="props.modelLimitsBusy" :aria-busy="props.modelLimitsBusy === true" @click="!props.modelLimitsBusy && emit('fetchModelLimits')">
        <LoaderCircle v-if="props.modelLimitsBusy" class="spin" :size="13" /><Download v-else :size="13" />
        {{ props.modelLimitsBusy ? '查询中…' : '获取模型上限' }}
      </button>
    </div>
    <p v-if="props.modelLimitsError" class="generation-model-limits-result generation-model-limits-error" role="alert">{{ props.modelLimitsError }}</p>
    <p v-else-if="props.modelLimitsMessage" class="generation-model-limits-result" role="status">{{ props.modelLimitsMessage }}</p>
    <div class="generation-token-grid">
      <label v-for="field in tokenFields" :key="field.key" class="form-field generation-token-field">
        <span>{{ field.key }} <small>Token</small></span>
        <input
          type="number"
          :min="field.min"
          :max="field.max"
          step="1"
          inputmode="numeric"
          :value="props.fields[field.key] ?? field.fallback"
          :placeholder="String(field.fallback)"
          :aria-label="field.key"
          @input="emit('updateField', field.key, ($event.target as HTMLInputElement).value)"
        />
        <small>{{ field.hint }}</small>
      </label>
    </div>
    <p class="generation-helper"><Info :size="12" />按模型实际容量填写。超出预算会先裁掉较旧的对话；填写更大数值不会增加模型容量。</p>
    <p v-if="settingsError" class="generation-parameter-error" role="alert">{{ settingsError }}</p>

    <details class="generation-sampling-details">
      <summary><span>采样参数</span><small>留空时使用模型默认值</small><ChevronDown :size="14" /></summary>
      <div class="generation-sampling-body">
        <div class="generation-sampling-toolbar"><p>参数只在启用自定义且填写数值时发送。</p><button type="button" @click="resetSampling"><RotateCcw :size="12" />全部使用默认</button></div>
        <div class="generation-sampling-grid">
          <div v-for="field in samplingFields" :key="field.key" :class="['generation-sampling-field', { unsupported: field.unsupported }]">
            <div class="generation-sampling-label">
              <strong>{{ field.key }}</strong>
              <label :title="field.unsupported ? 'Anthropic 不支持此参数' : '关闭后使用模型默认值'">
                <input type="checkbox" :checked="!field.unsupported && isCustom(field.key)" :disabled="field.unsupported" @change="setCustom(field.key, ($event.target as HTMLInputElement).checked, field.initial)" />
                <span>{{ field.unsupported ? '不支持' : '自定义' }}</span>
              </label>
            </div>
            <div class="generation-sampling-controls">
              <input
                type="range"
                :min="field.min"
                :max="field.max"
                :step="field.step"
                :value="isCustom(field.key) ? props.fields[field.key] : field.initial"
                :disabled="field.unsupported || !isCustom(field.key)"
                :aria-label="`${field.key}滑块`"
                @input="emit('updateField', field.key, ($event.target as HTMLInputElement).value)"
              />
              <input
                type="number"
                :min="field.min"
                :max="field.max"
                :step="field.step"
                :value="field.unsupported ? '' : (props.fields[field.key] ?? '')"
                :disabled="field.unsupported"
                placeholder="默认"
                :aria-label="field.key"
                @input="emit('updateField', field.key, ($event.target as HTMLInputElement).value)"
              />
            </div>
            <small>{{ field.unsupported ? 'Anthropic 不支持频率惩罚和存在惩罚，不会发送。' : field.hint }}</small>
          </div>
        </div>
      </div>
    </details>

    <label v-if="isOpenAICompatible" class="form-field generation-output-parameter">
      <span>输出长度参数</span>
      <select :value="props.fields['输出长度参数'] || defaultModelSettings.outputTokenParameter" aria-label="输出长度参数" @change="emit('updateField', '输出长度参数', ($event.target as HTMLSelectElement).value)">
        <option value="max_tokens">max_tokens</option>
        <option value="max_completion_tokens">max_completion_tokens</option>
      </select>
      <small>兼容接口与模型的字段要求可能不同；若提示不支持 max_tokens，可按接口文档切换。</small>
    </label>

    <div class="generation-usage-option">
      <div><strong>流式用量统计</strong><p>向支持的接口请求 Token 用量；接口未返回时显示未知。</p></div>
      <label class="switch-label">
        <input type="checkbox" :checked="props.fields['流式用量统计'] !== 'false'" :disabled="props.fields['流式输出'] === 'false'" @change="emit('updateField', '流式用量统计', ($event.target as HTMLInputElement).checked ? 'true' : 'false')" />
        <span>请求统计</span>
      </label>
    </div>
    <p v-if="props.fields['流式输出'] === 'false'" class="generation-helper">开启流式输出后可请求流式用量统计。此设置不控制模型服务的缓存。</p>
  </section>
</template>

<style scoped>
.provider-generation-settings { min-width: 0; margin-top: 22px; padding-top: 18px; color: var(--theme-font); border-top: 1px solid var(--theme-border); }
.generation-section-heading { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; justify-content: space-between; }
.generation-section-heading-copy { min-width: 0; flex: 1 1 250px; display: flex; align-items: flex-start; gap: 8px; }
.generation-section-heading-copy > svg { flex: 0 0 auto; margin-top: 2px; color: var(--theme-button); }
.generation-section-heading h4 { margin: 0; color: var(--theme-font); font-size: 14px; }
.generation-section-heading p { margin: 5px 0 0; color: var(--theme-muted); font-size: 11px; line-height: 1.6; }
.generation-limits-fetch { flex: 0 0 auto; padding: 7px 9px; font-size: 11px; white-space: nowrap; }
.generation-limits-fetch:disabled { opacity: .65; cursor: default; }
.generation-model-limits-result { margin: 10px 0 0; color: var(--theme-muted); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.generation-model-limits-error { color: var(--theme-danger); }
.generation-token-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 15px; }
.generation-token-field { min-width: 0; margin: 0; }
.generation-token-field > span { color: var(--theme-font); }
.generation-token-field > span small { color: var(--theme-muted); font-size: 10px; font-weight: 400; }
.generation-token-field > small { min-height: 30px; color: var(--theme-muted); font-size: 10px; line-height: 1.5; }
.generation-helper { display: flex; align-items: flex-start; gap: 5px; margin: 10px 0 0; color: var(--theme-muted); font-size: 10px; line-height: 1.6; }
.generation-helper svg { flex: 0 0 auto; margin-top: 2px; color: var(--theme-button); }
.generation-parameter-error { margin: 10px 0 0; color: var(--theme-danger); font-size: 11px; line-height: 1.6; }
.generation-sampling-details { margin-top: 17px; border: 1px solid var(--theme-border); border-radius: 7px; overflow: hidden; }
.generation-sampling-details summary { min-width: 0; display: flex; align-items: center; gap: 8px; padding: 10px 12px; color: var(--theme-font); cursor: pointer; list-style: none; }
.generation-sampling-details summary::-webkit-details-marker { display: none; }
.generation-sampling-details summary > span { font-size: 12px; font-weight: 500; }
.generation-sampling-details summary small { flex: 1; color: var(--theme-muted); font-size: 10px; }
.generation-sampling-details summary svg { color: var(--theme-button); transition: transform .15s ease; }
.generation-sampling-details[open] summary svg { transform: rotate(180deg); }
.generation-sampling-body { padding: 0 12px 12px; }
.generation-sampling-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 7px; margin-bottom: 12px; }
.generation-sampling-toolbar p { margin: 0; color: var(--theme-muted); font-size: 10px; line-height: 1.5; }
.generation-sampling-toolbar button { display: inline-flex; align-items: center; gap: 4px; padding: 3px 0; border: 0; background: transparent; color: var(--theme-button); font-size: 10px; cursor: pointer; }
.generation-sampling-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px 20px; }
.generation-sampling-field { min-width: 0; }
.generation-sampling-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.generation-sampling-label strong { color: var(--theme-font); font-size: 11px; font-weight: 500; }
.generation-sampling-label label { display: inline-flex; align-items: center; gap: 4px; color: var(--theme-muted); font-size: 10px; }
.generation-sampling-label input { width: 12px; height: 12px; accent-color: var(--theme-button); }
.generation-sampling-controls { min-width: 0; display: flex; align-items: center; gap: 8px; }
.generation-sampling-controls input[type="range"] { width: 100%; min-width: 0; flex: 1; accent-color: var(--theme-button); }
.generation-sampling-controls input[type="number"] { width: 73px; flex: 0 0 73px; padding: 6px 7px; border: 1px solid var(--theme-border); border-radius: 5px; outline: none; color: var(--theme-font); background: var(--theme-input-bg); font-size: 11px; }
.generation-sampling-controls input[type="number"]:focus { border-color: var(--theme-button); box-shadow: 0 0 0 2px var(--theme-focus-ring); }
.generation-sampling-controls input::placeholder { color: var(--theme-muted); }
.generation-sampling-field > small { display: block; margin-top: 6px; color: var(--theme-muted); font-size: 10px; line-height: 1.5; }
.generation-sampling-field.unsupported { opacity: .7; }
.generation-sampling-field input:disabled { cursor: default; }
.generation-output-parameter { margin-top: 17px; }
.generation-output-parameter > small { color: var(--theme-muted); font-size: 10px; line-height: 1.5; }
.generation-usage-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 17px; }
.generation-usage-option strong { color: var(--theme-font); font-size: 12px; font-weight: 500; }
.generation-usage-option p { margin: 4px 0 0; color: var(--theme-muted); font-size: 10px; line-height: 1.5; }
.generation-usage-option .switch-label { color: var(--theme-font); font-size: 11px; }
.generation-usage-option .switch-label input { accent-color: var(--theme-button); }
@media (max-width: 1200px) {
  .generation-token-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 700px) {
  .generation-token-grid, .generation-sampling-grid { grid-template-columns: minmax(0, 1fr); }
  .generation-token-field > small { min-height: 0; }
  .generation-usage-option { align-items: flex-start; flex-direction: column; }
}
</style>
