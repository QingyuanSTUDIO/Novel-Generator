<script setup lang="ts">
import { AlertTriangle, Check, Moon, Settings2, Sun } from 'lucide-vue-next'

defineProps<{ title: string; saveState: string; settingsOpen?: boolean; themeMode: 'light' | 'dark' }>()
const emit = defineEmits<{ settings: []; toggleTheme: [] }>()
</script>

<template>
  <header class="topbar">
    <div class="crumb"><span>作品</span><span class="slash">/</span><strong>{{ title }}</strong></div>
    <div class="top-actions"><span :class="['save-status', { error: /失败|冲突|不可用/.test(saveState) }]"><AlertTriangle v-if="/失败|冲突|不可用/.test(saveState)" :size="14" /><Check v-else :size="14" />{{ saveState }}</span><button class="icon-button theme-toggle-button" type="button" :title="themeMode === 'dark' ? '切换到白天模式' : '切换到夜间模式'" :aria-label="themeMode === 'dark' ? '切换到白天模式' : '切换到夜间模式'" @click="emit('toggleTheme')"><Sun v-if="themeMode === 'dark'" :size="16" /><Moon v-else :size="16" /></button><button :class="['icon-button', { active: settingsOpen }]" type="button" title="设置" aria-label="打开设置" @click="emit('settings')"><Settings2 :size="16" /></button><div class="avatar">A</div></div>
  </header>
</template>
