<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { Maximize2, Minimize2 } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  ariaLabel?: string
}>(), {
  placeholder: '',
  ariaLabel: '多行文本',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  blur: []
}>()

const input = ref<HTMLTextAreaElement | null>(null)
const expanded = ref(false)
const manualHeight = ref<number | null>(null)
const autoHeightLimit = 192

function resizeInput() {
  const element = input.value
  if (!element) return
  element.style.height = 'auto'
  const naturalHeight = element.scrollHeight
  const height = expanded.value
    ? Math.max(naturalHeight, manualHeight.value ?? 0)
    : manualHeight.value
      ? Math.max(naturalHeight, manualHeight.value)
      : Math.min(naturalHeight, autoHeightLimit)
  element.style.height = `${height}px`
  element.style.overflowY = !expanded.value && naturalHeight > height ? 'auto' : 'hidden'
}

function updateValue(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
  void nextTick(resizeInput)
}

function handleBlur() {
  emit('blur')
}

function toggleExpanded() {
  expanded.value = !expanded.value
  manualHeight.value = null
  void nextTick(resizeInput)
}

function captureManualHeight() {
  const element = input.value
  if (!element || expanded.value) return
  manualHeight.value = element.offsetHeight
}

watch(() => props.modelValue, () => { void nextTick(resizeInput) })
watch(expanded, () => { void nextTick(resizeInput) })
onMounted(resizeInput)
</script>

<template>
  <div class="expandable-textarea" :class="{ expanded }">
    <textarea
      ref="input"
      class="expandable-textarea-input"
      :value="props.modelValue"
      :placeholder="props.placeholder"
      :aria-label="props.ariaLabel"
      rows="1"
      @input="updateValue"
      @blur="handleBlur"
      @pointerup="captureManualHeight"
    />
    <button
      class="expandable-textarea-toggle"
      type="button"
      :aria-label="expanded ? '收起输入框' : '展开输入框'"
      :aria-expanded="expanded"
      :title="expanded ? '收起输入框' : '展开输入框'"
      @click="toggleExpanded"
    >
      <Minimize2 v-if="expanded" :size="13" />
      <Maximize2 v-else :size="13" />
    </button>
  </div>
</template>
