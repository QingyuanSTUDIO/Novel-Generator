<script setup lang="ts">
import logoUrl from '../assets/qy-logo.png'

withDefaults(defineProps<{
  size?: number
  label?: string
  tone?: 'button' | 'buttonText' | 'font' | 'workspace'
}>(), {
  size: 18,
  label: '',
  tone: 'button',
})
</script>

<template>
  <span
    class="qy-logo"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      maskImage: `url(${logoUrl})`,
      WebkitMaskImage: `url(${logoUrl})`,
      backgroundColor: tone === 'buttonText'
        ? 'var(--theme-button-text)'
        : tone === 'font'
          ? 'var(--theme-font)'
          : tone === 'workspace'
            ? 'var(--theme-workspace)'
            : 'var(--theme-button)',
    }"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style scoped>
.qy-logo {
  display: inline-block;
  flex: 0 0 auto;
  background: var(--theme-button);
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
  -webkit-mask-position: center;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: contain;
}
</style>
