<script setup lang="ts">
import { Copy, FolderOpen, LoaderCircle, X } from 'lucide-vue-next'
import type { FileRevisionConflict } from '../files/types'
import '../files/conflict.css'

defineProps<{ open: boolean; conflict: FileRevisionConflict | null; busy: boolean; error: string }>()
const emit = defineEmits<{ reload: []; saveAs: []; cancel: [] }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open && conflict" class="qy-conflict-backdrop" @pointerdown.stop @click.self="!busy && emit('cancel')">
      <section class="qy-conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="qy-conflict-title" :aria-busy="busy">
        <header>
          <div><span>作品集保存保护</span><h2 id="qy-conflict-title">磁盘文件{{ conflict.kind === 'missing' ? '已被移走或删除' : conflict.kind === 'created' ? '已被其他程序创建' : '已被外部修改' }}</h2></div>
          <button class="icon-button" type="button" aria-label="取消文件冲突处理" :disabled="busy" @click="emit('cancel')"><X :size="18" /></button>
        </header>
        <p>当前编辑内容仍保留在内存中，自动写入已暂停。请选择保留当前内容到另一文件，或读取磁盘中的版本。</p>
        <code>{{ conflict.path }}</code>
        <div class="qy-conflict-choices">
          <button class="button primary" type="button" :disabled="busy" @click="emit('saveAs')"><Copy :size="16" /><span><strong>将当前内容另存为</strong><small>保留本次编辑，选择其他文件路径。</small></span></button>
          <button class="button secondary" type="button" :disabled="busy || conflict.kind === 'missing'" @click="emit('reload')"><FolderOpen :size="16" /><span><strong>重新加载磁盘版本</strong><small>放弃当前作品集尚未保存的编辑，读取磁盘文件。</small></span></button>
        </div>
        <p v-if="error" class="qy-conflict-error" role="alert">{{ error }}</p>
        <footer><span v-if="busy"><LoaderCircle class="spin" :size="14" />正在处理…</span><button class="button secondary" type="button" :disabled="busy" @click="emit('cancel')">取消，保留当前编辑</button></footer>
      </section>
    </div>
  </Teleport>
</template>
