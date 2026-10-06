<script setup lang="ts">
import {
  AlignLeft,
  ArrowDown,
  Check,
  Clipboard,
  ChevronDown,
  FolderPlus,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  PanelRight,
  Plus,
  Save,
  Search,
  Sparkles,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-vue-next'
import ParagraphEditor from './ParagraphEditor.vue'
import ContextPreviewPanel from './ContextPreviewPanel.vue'
import ContextUsageIndicator from './ContextUsageIndicator.vue'
import ConsolePanel from './ConsolePanel.vue'
import type { ContextBudgetReport } from '../api/contextBudget'
import type { ChatUsage } from '../api/chatUsage'

/**
 * The writer workspace intentionally owns only presentation. Its state and
 * operations stay in App.vue; events are forwarded to the existing handlers.
 * Keeping this boundary shallow lets the editor be extracted without changing
 * persistence, generation, or retrieval behavior.
 */
const props = defineProps<{
  activeChapter: any
  visibleVolumes: any[]
  normalizedChapterSearch: string
  filteredChapters: any[]
  chapterCountByVolume: Record<string, number>
  chapterSearch: string
  chaptersForVolume: (volumeId: string) => any[]
  volumeForChapter: (chapter: any) => any
  chapterDisplayTitle: (chapter: any) => string
  assistantTab: 'task' | 'context' | 'checks'
  castDraft: string
  inferredCast: string[]
  writerProviderSelectionId: string
  providers: any[]
  activeParagraphEdit: any
  isGenerating: boolean
  candidate: string
  canAcceptCandidate: boolean
  writerState: string
  writerContextPreview: any
  writerContextBudget: ContextBudgetReport | null
  writerContextUsage: ChatUsage | null
  writerContextStatus: 'preview' | 'running' | 'done' | 'error'
  writerContextBudgetLabel: string
  writerContextBudgetError: string
  generationError: string
  consoleDockOpen: boolean
  consoleDockHeight: number
  viewport: { height: number }
  focusMode: boolean
  editorToolsOpen: boolean
  formatIndentSpaces: number
  copyFeedback: 'copied' | 'error' | ''
  qyFileBusy: boolean
  currentQyPath: string
  consoleJobs: any[]
  consoleProviders: any[]
  consoleTarget?: any
  consoleProjectNames?: Record<string, string>
  consoleBusy: boolean
  consoleActiveJobId?: string
  consoleEndpointPath?: string
  consoleError?: string
  consoleRuntime?: { startResize: (event: PointerEvent) => void }
}>()

const emit = defineEmits<{
  'update:chapterSearch': [value: string]
  'jump-to-last': []
  'set-assistant-tab': [value: 'task' | 'context' | 'checks']
  'update:castDraft': [value: string]
  'toggle-volume': [volume: any]
  'update-volume-title': [volume: any, title: string]
  'select-chapter': [id: string]
  'create-chapter': []
  'create-volume': []
  'update-chapter-title': [value: string]
  'toggle-console': []
  'toggle-focus': []
  'save-file': []
  'toggle-editor-tools': []
  'update:indent-spaces': [value: number]
  'format-chapter-content': []
  'copy-chapter-plain-text': []
  'request-delete-chapter': []
  'update-content': [value: string]
  'paragraph-open-edit': [payload: any]
  'paragraph-close-edit': []
  'paragraph-update-instruction': [value: string]
  'paragraph-request-edit': [payload: any]
  'paragraph-apply-edit': [payload: any]
  discard: []
  accept: []
  'update-task-goal': [value: string]
  'remove-cast': [name: string]
  'commit-cast': [event: KeyboardEvent]
  'add-cast': [value: string]
  'select-provider': [id: string]
  generate: []
  'console-resize-start': [event: PointerEvent]
  'console-resize-key': [delta: number]
  'console-submit': [value: any]
  'console-action': [value: any]
  'console-hide': []
  'console-maximize': []
  'console-resize': [height: number]
}>()

function updateChapterSearch(event: Event) {
  emit('update:chapterSearch', (event.target as HTMLInputElement).value)
}

function updateCastDraft(event: Event) {
  emit('update:castDraft', (event.target as HTMLInputElement).value)
}

function updateVolumeTitle(volume: any, event: Event) {
  emit('update-volume-title', volume, (event.target as HTMLInputElement).value)
}

function updateTaskGoal(event: Event) {
  emit('update-task-goal', (event.target as HTMLTextAreaElement).value)
}

function resizeConsole(delta: number) {
  emit('console-resize-key', delta)
}
</script>

<template>
  <div class="writer-workspace">
    <section class="writer-layout">
      <aside class="chapter-rail">
        <div class="chapter-rail-head"><span>章节目录</span><button class="icon-button" type="button" title="跳转到末尾章节" aria-label="跳转到末尾章节" @click="emit('jump-to-last')"><ArrowDown :size="15" /></button></div>
        <label class="chapter-search"><Search :size="14" /><input :value="chapterSearch" type="search" placeholder="搜索章节" aria-label="搜索章节" @input="updateChapterSearch" /><button v-if="chapterSearch" class="chapter-search-clear" type="button" title="清空搜索" aria-label="清空搜索" @click="emit('update:chapterSearch', '')"><X :size="13" /></button></label>
        <div class="chapter-list">
          <section v-for="volume in visibleVolumes" :key="volume.id" class="chapter-volume">
            <div class="volume-heading">
              <button class="volume-toggle" type="button" :title="volume.collapsed ? '展开分卷' : '折叠分卷'" :aria-label="volume.collapsed ? '展开分卷' : '折叠分卷'" @click="emit('toggle-volume', volume)"><ChevronDown :size="14" :class="{ 'volume-chevron-collapsed': volume.collapsed }" /></button>
              <input class="volume-title-input" :value="volume.title" placeholder="输入分卷名称" aria-label="分卷名称" @input="updateVolumeTitle(volume, $event)" />
              <small>{{ chapterCountByVolume[volume.id] ?? 0 }}</small>
            </div>
            <div v-if="!volume.collapsed || normalizedChapterSearch" class="volume-chapters">
              <button v-for="chapter in chaptersForVolume(volume.id)" :key="chapter.id" :class="['chapter-item', { active: chapter.id === activeChapter?.id }]" type="button" @click="emit('select-chapter', chapter.id)">
                <span>{{ chapter.title }}</span><small>{{ chapter.status }}<template v-if="chapter.wordCount"> · {{ chapter.wordCount }} 字</template></small>
              </button>
            </div>
          </section>
          <p v-if="!filteredChapters.length" class="chapter-empty">没有匹配的章节</p>
        </div>
        <div class="chapter-actions"><button class="button secondary" type="button" @click="emit('create-chapter')"><Plus :size="14" />新建章节</button><button class="button secondary" type="button" @click="emit('create-volume')"><FolderPlus :size="14" />新建卷</button></div>
      </aside>

      <article class="editor-pane" v-if="activeChapter">
        <div class="editor-head"><div><span class="eyebrow"><template v-if="volumeForChapter(activeChapter)?.title">{{ volumeForChapter(activeChapter)?.title }} / </template>{{ activeChapter.status }}</span><input class="chapter-title-editor" :value="chapterDisplayTitle(activeChapter)" placeholder="输入章节标题" aria-label="章节标题" @input="emit('update-chapter-title', ($event.target as HTMLInputElement).value)" /></div><div class="editor-actions"><button class="button secondary" type="button" :aria-expanded="consoleDockOpen" @click="emit('toggle-console')"><TerminalSquare :size="15" />控制台</button><button class="button secondary" type="button" @click="emit('toggle-focus')"><PanelRight :size="15" />{{ focusMode ? '退出专注' : '专注写作' }}</button><button class="button secondary" type="button" :disabled="qyFileBusy" :title="currentQyPath ? `保存到 ${currentQyPath}` : '选择 .qy 作品集文件并保存'" @click="emit('save-file')"><Save :size="15" />保存</button></div></div>
        <div class="editor-toolbar"><span class="tool-label">正文编辑区</span><span class="toolbar-hint">选段后可续写、改写或润色</span><div class="editor-overflow" @click.stop @keydown.esc.stop.prevent="emit('toggle-editor-tools')"><button class="icon-button" :class="{ active: editorToolsOpen }" type="button" title="正文工具" aria-label="正文工具" aria-haspopup="true" :aria-expanded="editorToolsOpen" @click="emit('toggle-editor-tools')"><MoreHorizontal :size="16" /></button><div v-if="editorToolsOpen" class="editor-tool-menu" role="group" aria-label="正文工具"><label class="editor-format-setting"><span>首行缩进</span><select :value="formatIndentSpaces" aria-label="首行缩进空格数" @change="emit('update:indent-spaces', Number(($event.target as HTMLSelectElement).value))"><option :value="0">不缩进</option><option :value="1">1 个全角空格</option><option :value="2">2 个全角空格</option><option :value="4">4 个全角空格</option></select></label><button class="editor-menu-action" type="button" :disabled="!activeChapter.content.trim()" @click="emit('format-chapter-content')"><AlignLeft :size="15" />应用自动排版</button><button class="editor-menu-action" type="button" :disabled="!activeChapter.content.trim()" @click="emit('copy-chapter-plain-text')"><Check v-if="copyFeedback === 'copied'" :size="15" /><Clipboard v-else :size="15" />{{ copyFeedback === 'copied' ? '已复制纯文本' : '复制全章纯文本' }}</button><p v-if="copyFeedback === 'error'" class="editor-menu-feedback error">复制失败，请检查剪贴板权限。</p><p v-else-if="copyFeedback === 'copied'" class="editor-menu-feedback">Markdown 标记已移除，段落与链接文字已保留。</p><div class="editor-menu-divider"></div><button class="editor-menu-action danger" type="button" @click="emit('request-delete-chapter')"><Trash2 :size="15" />删除当前章节</button></div></div></div>
        <ParagraphEditor :model-value="activeChapter.content" :edit-state="activeParagraphEdit" :disabled="isGenerating" @update:model-value="emit('update-content', $event)" @open-edit="emit('paragraph-open-edit', $event)" @close-edit="emit('paragraph-close-edit')" @update-instruction="emit('paragraph-update-instruction', $event)" @request-edit="emit('paragraph-request-edit', $event)" @apply-edit="emit('paragraph-apply-edit', $event)" />
        <div class="editor-footer"><span>{{ activeChapter.wordCount }} 字 · 自动保存</span><span>Markdown 兼容</span></div>
        <div v-if="candidate || isGenerating" class="candidate-box" :aria-busy="isGenerating">
          <div class="candidate-head"><div><span class="eyebrow">候选正文</span><strong>{{ isGenerating ? '正在生成' : canAcceptCandidate ? '生成完成 · 待采纳' : writerState === 'done' ? '候选已失效 · 不可采纳' : '生成中断 · 不可采纳' }}</strong></div><button class="icon-button" type="button" :title="isGenerating ? '停止生成并丢弃候选' : '丢弃候选'" @click="emit('discard')"><X :size="16" /></button></div>
          <p v-if="candidate">{{ candidate }}<span v-if="isGenerating" class="agent-typing-cursor" aria-hidden="true"></span></p>
          <p v-else class="candidate-wait"><LoaderCircle class="spin" :size="14" />等待模型回复…</p>
          <div class="candidate-actions"><button class="button secondary" type="button" @click="emit('discard')">{{ isGenerating ? '停止生成' : '丢弃' }}</button><button class="button primary" type="button" :disabled="!canAcceptCandidate" @click="emit('accept')"><Check :size="15" />采纳候选</button></div>
        </div>
      </article>

      <aside class="assistant-pane" v-if="activeChapter">
        <div class="assistant-tabs"><button v-for="tab in [{ key: 'task', label: '本章任务' }, { key: 'context', label: '本次资料' }, { key: 'checks', label: '检查建议' }]" :key="tab.key" :class="{ selected: assistantTab === tab.key }" type="button" @click="emit('set-assistant-tab', tab.key as 'task' | 'context' | 'checks')">{{ tab.label }}</button></div>
        <div v-if="assistantTab === 'task'" class="assistant-content writer-task-content">
          <h2>本章任务</h2>
          <label class="form-field task-goal-field"><span>剧情目标</span><textarea :value="activeChapter.taskGoal ?? ''" rows="3" placeholder="输入本章要推进的剧情目标" @input="updateTaskGoal" /></label>
          <div class="form-field"><span>出场人物</span><div class="cast-tag-editor"><span v-for="name in activeChapter.cast ?? []" :key="name" class="cast-tag"><span>{{ name }}</span><button type="button" :title="`移除 ${name}`" :aria-label="`移除 ${name}`" @click="emit('remove-cast', name)"><X :size="12" /></button></span><input :value="castDraft" type="text" placeholder="输入人物，按空格添加" @input="updateCastDraft" @keydown="emit('commit-cast', $event)" @blur="emit('add-cast', castDraft)" /></div><div v-if="!(activeChapter.cast?.length) && inferredCast.length" class="cast-inferred"><span>从本章内容识别</span><span v-for="name in inferredCast" :key="name" class="cast-inferred-tag">{{ name }}</span></div><small>留空时根据剧情目标和正文识别角色，并检索相关角色资料。</small></div>
          <label class="form-field writer-api-select"><span>正文生成 API</span><select :value="writerProviderSelectionId" aria-label="选择正文生成 API" @change="emit('select-provider', ($event.target as HTMLSelectElement).value)"><option v-if="!providers.length" value="">未配置 API</option><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.title }}{{ provider.fields?.['模型'] ? ` · ${provider.fields['模型']}` : '' }}</option></select></label>
          <ContextUsageIndicator :budget="writerContextBudget" :usage="writerContextUsage" :status="writerContextStatus" :budget-label="writerContextBudgetLabel" label="正文上下文" />
          <p v-if="writerContextBudgetError" class="generation-error" role="status">{{ writerContextBudgetError }}</p>
          <div v-if="generationError" class="generation-error" role="alert">{{ generationError }}</div>
          <button class="button primary full generate-chapter-button" type="button" :disabled="isGenerating || activeParagraphEdit !== null || !providers.length" @click="emit('generate')"><LoaderCircle v-if="isGenerating" class="spin" :size="15" /><Sparkles v-else :size="15" />{{ isGenerating ? '正在生成…' : '生成正文' }}</button>
        </div>
        <div v-else-if="assistantTab === 'context'" class="assistant-content"><h2>本次使用的资料</h2><ContextPreviewPanel :preview="writerContextPreview" :budget="writerContextBudget" compact title="正文实际上下文" /><span v-if="!writerContextPreview" class="helper">当前章节没有可预览的请求。</span></div>
        <div v-else class="assistant-content"><h2>审阅与确认</h2><div class="check-row"><Check :size="15" /><span>设定冲突与道具归属</span><em>待生成后检查</em></div><div class="check-row"><Check :size="15" /><span>角色知情边界</span><em>待生成后检查</em></div><div class="check-row"><Check :size="15" /><span>文风正反例</span><em>按需审阅</em></div><div class="warning-note"><LockKeyhole :size="15" />确认状态变化后，下一章才使用新资料。</div></div>
      </aside>
    </section>
    <div v-if="consoleDockOpen" class="writer-console-dock" :style="{ height: `${consoleDockHeight}px` }">
      <div class="console-resize-grip" role="separator" aria-label="调整控制台高度" aria-orientation="horizontal" tabindex="0" @pointerdown="emit('console-resize-start', $event)" @keydown.up.prevent="resizeConsole(20)" @keydown.down.prevent="resizeConsole(-20)"></div>
      <ConsolePanel
        :jobs="consoleJobs" :providers="consoleProviders" :current-target="consoleTarget" :project-names="consoleProjectNames"
        :busy="consoleBusy" :current-job-id="consoleActiveJobId" :session-endpoint="consoleEndpointPath"
        :error="consoleError" dock
        @submit="emit('console-submit', $event)" @action="emit('console-action', $event)"
        @hide="emit('console-hide')" @maximize="emit('console-maximize')"
        @resize="emit('console-resize', $event)"
      />
    </div>
  </div>
</template>
