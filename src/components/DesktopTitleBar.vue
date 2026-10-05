<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, ChevronDown, FilePlus2, FileText, FolderOpen, Minimize2, Minus, Moon, Save, Settings2, Square, Sun, X } from 'lucide-vue-next'
import QyLogo from './QyLogo.vue'

const props = defineProps<{
  title: string
  saveState: string
  settingsOpen?: boolean
  themeMode: 'light' | 'dark'
  filePath?: string
  recentFiles?: readonly { path: string; title: string; updatedAt: number }[]
  fileBusy?: boolean
}>()

const emit = defineEmits<{
  settings: []
  toggleTheme: []
  newFile: []
  openFile: []
  saveFile: []
  saveAsFile: []
  openRecentFile: [path: string]
  removeRecentFile: [path: string]
}>()
const maximized = ref(false)
const fileMenuOpen = ref(false)
let removeMaximizeListener: (() => void) | undefined

function closeFileMenuOnOutside(event: PointerEvent) {
  const target = event.target as HTMLElement | null
  if (!target?.closest('.desktop-file-menu')) fileMenuOpen.value = false
}

onMounted(async () => {
  document.addEventListener('pointerdown', closeFileMenuOnOutside)
  const desktopWindow = window.desktopWindow
  if (desktopWindow) {
    removeMaximizeListener = desktopWindow.onMaximizeState((value) => {
      maximized.value = value
    })
    try {
      maximized.value = await desktopWindow.isMaximized()
    } catch {
      // The title bar remains usable if the window IPC is unavailable during
      // renderer startup.
    }
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeFileMenuOnOutside)
  removeMaximizeListener?.()
})

function minimize() {
  window.desktopWindow?.minimize()
}

function toggleMaximize() {
  window.desktopWindow?.toggleMaximize()
}

function close() {
  window.desktopWindow?.close()
}
</script>

<template>
  <header class="desktop-titlebar" @dblclick="toggleMaximize">
    <div class="desktop-titlebar-brand">
      <QyLogo class="desktop-titlebar-logo" :size="16" label="叙事工坊" />
      <strong>叙事工坊</strong>
      <span class="desktop-titlebar-separator">/</span>
      <span class="desktop-titlebar-page">{{ title }}</span>
      <div class="desktop-file-menu" @click.stop @dblclick.stop>
        <button class="desktop-file-trigger" type="button" :aria-expanded="fileMenuOpen" title="文件" @click="fileMenuOpen = !fileMenuOpen"><FileText :size="14" /><span>文件</span><ChevronDown :size="12" /></button>
        <div v-if="fileMenuOpen" class="desktop-file-dropdown" role="menu">
          <button type="button" role="menuitem" :disabled="fileBusy" @click="fileMenuOpen = false; emit('newFile')"><FilePlus2 :size="14" /><span>新建作品文件</span></button>
          <button type="button" role="menuitem" :disabled="fileBusy" @click="fileMenuOpen = false; emit('openFile')"><FolderOpen :size="14" /><span>打开 .qy 文件</span></button>
          <button type="button" role="menuitem" :disabled="fileBusy || !props.filePath" @click="fileMenuOpen = false; emit('saveFile')"><Save :size="14" /><span>保存</span><small v-if="!props.filePath">未建立文件</small></button>
          <button type="button" role="menuitem" :disabled="fileBusy" @click="fileMenuOpen = false; emit('saveAsFile')"><Save :size="14" /><span>另存为 .qy</span></button>
          <div v-if="props.recentFiles?.length" class="desktop-file-recent">
            <span>最近打开</span>
            <button v-for="item in props.recentFiles" :key="item.path" type="button" role="menuitem" @click="fileMenuOpen = false; emit('openRecentFile', item.path)">
              <span>{{ item.title || item.path }}</span>
              <small title="移除记录" @click.stop="emit('removeRecentFile', item.path)">×</small>
            </button>
          </div>
          <p v-else class="desktop-file-empty">暂无最近作品</p>
        </div>
      </div>
    </div>
    <div class="desktop-titlebar-actions" @dblclick.stop>
      <span :class="['save-status', { error: /失败|冲突|不可用/.test(saveState) }]">
        <span class="desktop-titlebar-save-icon"><span v-if="/失败|冲突|不可用/.test(saveState)">!</span><Check v-else :size="12" /></span>
        {{ saveState }}
      </span>
      <button class="desktop-titlebar-button theme-toggle-button" type="button" :title="themeMode === 'dark' ? '切换到白天模式' : '切换到夜间模式'" :aria-label="themeMode === 'dark' ? '切换到白天模式' : '切换到夜间模式'" @dblclick.stop @click.stop="emit('toggleTheme')"><Sun v-if="themeMode === 'dark'" :size="15" /><Moon v-else :size="15" /></button>
      <button :class="['desktop-titlebar-button', { active: settingsOpen }]" type="button" title="设置" aria-label="打开设置" @dblclick.stop @click.stop="emit('settings')"><Settings2 :size="14" /></button>
      <div class="desktop-titlebar-avatar" aria-hidden="true">A</div>
      <div class="desktop-titlebar-window-controls" aria-label="窗口控制">
        <button class="desktop-window-button" type="button" title="最小化" aria-label="最小化" @dblclick.stop @click.stop="minimize"><Minus :size="15" /></button>
        <button class="desktop-window-button" type="button" :title="maximized ? '还原' : '最大化'" :aria-label="maximized ? '还原窗口' : '最大化窗口'" @dblclick.stop @click.stop="toggleMaximize">
          <Minimize2 v-if="maximized" :size="13" />
          <Square v-else :size="13" />
        </button>
        <button class="desktop-window-button close" type="button" title="关闭" aria-label="关闭" @dblclick.stop @click.stop="close"><X :size="15" /></button>
      </div>
    </div>
  </header>
</template>
