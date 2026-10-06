<script setup lang="ts">
import { ChevronDown, PenLine, Plus, Search, Trash2 } from 'lucide-vue-next'
import QyLogo from './QyLogo.vue'

defineProps<{
  items: readonly { key: string; label: string; icon: unknown; section: string }[]
  activePage: string
  projectMenuOpen: boolean
  currentWorkTitle: string
  currentProjectId: string
  projects: readonly { id: string; title: string }[]
}>()

const sections = ['开始写作', '创作空间', '全局把握', 'AI功能', '全局功能', 'Debug'] as const

const emit = defineEmits<{ navigate: [page: string]; toggleProjectMenu: []; globalSearch: []; newProject: []; selectProject: [id: string]; renameProject: []; deleteProject: [] }>()
</script>

<template>
  <aside class="sidebar">
    <div class="brand"><QyLogo class="sidebar-brand-logo" :size="22" label="叙事工坊" /><span>叙事工坊</span></div>
    <div class="project-selector">
      <button class="project-switcher" type="button" :aria-expanded="projectMenuOpen" @click="emit('toggleProjectMenu')"><div><span class="eyebrow">当前作品</span><strong>{{ currentWorkTitle }}</strong></div><ChevronDown :size="15" /></button>
      <div v-if="projectMenuOpen" class="project-menu">
        <div class="project-menu-title">作品管理</div>
        <div class="project-menu-current"><div><span class="eyebrow">正在编辑</span><strong>{{ currentWorkTitle }}</strong></div><div class="project-menu-actions"><button class="icon-button" type="button" title="重命名当前作品" aria-label="重命名当前作品" @click.stop="emit('renameProject')"><PenLine :size="15" /></button><button class="icon-button danger" type="button" title="删除当前作品" aria-label="删除当前作品" @click.stop="emit('deleteProject')"><Trash2 :size="15" /></button></div></div>
        <div class="project-menu-list" role="list" aria-label="作品列表">
          <button v-for="project in projects" :key="project.id" :class="['project-menu-item', { active: currentProjectId === project.id }]" type="button" :aria-current="currentProjectId === project.id ? 'page' : undefined" @click="emit('selectProject', project.id)">
            <span>{{ project.title }}</span><small>{{ currentProjectId === project.id ? '正在编辑' : '切换作品' }}</small>
          </button>
        </div>
        <button class="project-menu-new" type="button" @click="emit('newProject')"><Plus :size="15" /><span><strong>新建作品</strong><small>从空白作品开始</small></span></button>
      </div>
    </div>
    <button class="sidebar-search-button" type="button" title="搜索全部资料（Ctrl/Cmd+K）" @click="emit('globalSearch')"><Search :size="15" /><span>搜索全部资料</span><kbd>Ctrl/Cmd K</kbd></button>
    <nav class="nav-list" aria-label="作品模块">
      <template v-for="(section, sectionIndex) in sections" :key="section">
        <span :class="['nav-label', { 'nav-label-spaced': sectionIndex > 0 }]">{{ section }}</span>
        <div v-for="item in items.filter((candidate) => candidate.section === section)" :key="item.key" class="nav-item-row">
          <button :class="['nav-item', { active: activePage === item.key }]" type="button" @click="emit('navigate', item.key)">
            <component :is="item.icon" :size="16" /><span>{{ item.label }}</span>
          </button>
        </div>
      </template>
    </nav>
  </aside>
</template>
