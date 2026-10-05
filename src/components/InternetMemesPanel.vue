<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronDown, ChevronsDownUp, ChevronsUpDown, Edit3, Globe2, Plus, Search, Trash2, X } from 'lucide-vue-next'

export type InternetMeme = {
  id: string
  name: string
  content: string
  explanation?: string
  source?: string
  sourceUrl?: string
  date?: string
  enabled?: boolean
  tags?: string[]
  createdBy?: 'agent' | 'manual'
}

export type InternetMemeCandidate = Omit<InternetMeme, 'id'> & { id?: string }

const props = withDefaults(defineProps<{
  memes?: readonly InternetMeme[]
  candidates?: readonly InternetMemeCandidate[]
  busy?: boolean
}>(), {
  memes: () => [],
  candidates: () => [],
  busy: false,
})

const emit = defineEmits<{
  (event: 'create', meme: InternetMeme): void
  (event: 'update', meme: InternetMeme): void
  (event: 'delete', id: string): void
  (event: 'toggle', id: string, enabled: boolean): void
  (event: 'accept-candidate', candidate: InternetMemeCandidate): void
  (event: 'dismiss-candidate', candidate: InternetMemeCandidate): void
  (event: 'search-web', query: string, engine: 'bing' | 'google' | 'duckduckgo'): void
}>()

const query = ref('')
const showEditor = ref(false)
const editingId = ref<string | null>(null)
const draft = ref<InternetMeme>(emptyMeme())
const showCandidates = ref(true)
const searchEngine = ref<'bing' | 'google' | 'duckduckgo'>('bing')
const expandedIds = ref<Set<string>>(new Set())
const sourceFilter = ref<'all' | 'agent' | 'manual' | 'enabled' | 'disabled'>('all')
const sortMode = ref<'default' | 'name' | 'source'>('default')

function emptyMeme(): InternetMeme {
  return { id: '', name: '', content: '', explanation: '', source: '', sourceUrl: '', date: new Date().toISOString().slice(0, 10), enabled: true, tags: [], createdBy: 'manual' }
}

const filteredMemes = computed(() => {
  const keywords = query.value.toLowerCase().split(/[\s,，、]+/u).map((item) => item.trim()).filter(Boolean)
  const result = props.memes.filter((meme) => {
    const searchable = [meme.name, meme.content, meme.explanation, meme.source, ...(meme.tags ?? [])].filter(Boolean).join(' ').toLowerCase()
    const matchesKeyword = !keywords.length || keywords.every((keyword) => searchable.includes(keyword))
    const matchesSource = sourceFilter.value === 'all'
      || sourceFilter.value === 'agent' && meme.createdBy === 'agent'
      || sourceFilter.value === 'manual' && meme.createdBy !== 'agent'
      || sourceFilter.value === 'enabled' && meme.enabled !== false
      || sourceFilter.value === 'disabled' && meme.enabled === false
    return matchesKeyword && matchesSource
  })
  if (sortMode.value === 'name') return [...result].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  if (sortMode.value === 'source') return [...result].sort((a, b) => (a.source || '未标注来源').localeCompare(b.source || '未标注来源', 'zh-CN'))
  return result
})

const expandedCount = computed(() => filteredMemes.value.filter((meme) => expandedIds.value.has(meme.id)).length)

function isExpanded(id: string) {
  return expandedIds.value.has(id)
}

function toggleExpanded(id: string) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

function setAllExpanded(expanded: boolean) {
  expandedIds.value = expanded ? new Set(filteredMemes.value.map((meme) => meme.id)) : new Set()
}

function openCreate() {
  editingId.value = null
  draft.value = emptyMeme()
  showEditor.value = true
}

function openEdit(meme: InternetMeme) {
  editingId.value = meme.id
  draft.value = { ...meme, tags: [...(meme.tags ?? [])] }
  showEditor.value = true
}

function saveDraft() {
  const value = draft.value
  if (!value.name.trim() || !value.content.trim()) return
  const normalized: InternetMeme = {
    ...value,
    id: editingId.value ?? `meme-${Date.now()}`,
    name: value.name.trim(),
    content: value.content.trim(),
    createdBy: editingId.value ? value.createdBy : 'manual',
    enabled: value.enabled !== false,
  }
  if (editingId.value) emit('update', normalized)
  else emit('create', normalized)
  showEditor.value = false
}

function acceptCandidate(candidate: InternetMemeCandidate) {
  emit('accept-candidate', { ...candidate, enabled: candidate.enabled !== false })
}
</script>

<template>
  <section class="internet-memes-panel">
    <header class="internet-memes-header">
      <div>
        <div class="panel-eyebrow"><Globe2 :size="15" /> 实验性功能 · 网络热梗</div>
        <h2>网络热梗表</h2>
        <p>收集近期网络表达，供 Agent 在灵感和写作上下文中按需参考。</p>
      </div>
      <button class="primary-action" type="button" :disabled="busy" @click="openCreate"><Plus :size="16" /> 手动添加</button>
    </header>

    <div class="internet-memes-toolbar">
      <label class="meme-search"><Search :size="16" /><input v-model="query" type="search" aria-label="本地搜索网络热梗" placeholder="本地搜索：名称、解释、标签或来源" @keydown.esc="query = ''" /><button v-if="query" class="meme-search-clear" type="button" title="清除本地搜索" aria-label="清除本地搜索" @click="query = ''"><X :size="14" /></button></label>
      <select v-model="searchEngine" class="meme-engine-select" aria-label="选择搜索引擎"><option value="bing">Bing</option><option value="google">Google</option><option value="duckduckgo">DuckDuckGo</option></select><button class="secondary-action" type="button" :disabled="busy || !query.trim()" @click="emit('search-web', query.trim(), searchEngine)"><Globe2 :size="15" /> Agent联网检索</button>
      <span class="meme-count">{{ filteredMemes.length }}<span v-if="filteredMemes.length !== props.memes.length"> / {{ props.memes.length }}</span> 条</span>
    </div>
    <div class="meme-management-bar">
      <div class="meme-management-title"><span>条目管理</span><small>{{ expandedCount }} / {{ filteredMemes.length }} 条已展开</small></div>
      <div class="meme-management-controls">
        <label class="meme-select-label"><span>筛选</span><select v-model="sourceFilter" aria-label="筛选网络热梗"><option value="all">全部条目</option><option value="agent">Agent 收集</option><option value="manual">手动创建</option><option value="enabled">仅启用</option><option value="disabled">已停用</option></select></label>
        <label class="meme-select-label"><span>排序</span><select v-model="sortMode" aria-label="排序网络热梗"><option value="default">默认顺序</option><option value="name">按名称</option><option value="source">按来源</option></select></label>
        <button class="small-button" type="button" :title="expandedCount === filteredMemes.length && filteredMemes.length ? '全部收起' : '全部展开'" @click="setAllExpanded(!(expandedCount === filteredMemes.length && filteredMemes.length))">
          <ChevronsUpDown v-if="expandedCount !== filteredMemes.length || !filteredMemes.length" :size="14" /> <ChevronsDownUp v-else :size="14" />
          {{ expandedCount === filteredMemes.length && filteredMemes.length ? '全部收起' : '全部展开' }}
        </button>
      </div>
    </div>

    <div v-if="showCandidates && candidates.length" class="meme-candidates">
      <div class="subsection-heading"><span>Agent待确认候选</span><button type="button" class="icon-button" title="收起候选" @click="showCandidates = false"><X :size="15" /></button></div>
      <article v-for="candidate in candidates" :key="candidate.id || candidate.name" class="candidate-card">
        <div class="candidate-main"><strong>{{ candidate.name }}</strong><p>{{ candidate.content }}</p><small>{{ candidate.source || 'Agent检索' }}<span v-if="candidate.date"> · {{ candidate.date }}</span></small></div>
        <div class="candidate-actions"><button type="button" class="small-primary" :disabled="busy" @click="acceptCandidate(candidate)"><Check :size="14" /> 收录</button><button type="button" class="small-button" @click="emit('dismiss-candidate', candidate)">忽略</button></div>
      </article>
    </div>
    <button v-else-if="candidates.length" type="button" class="show-candidates" @click="showCandidates = true">显示 {{ candidates.length }} 条待确认候选</button>

    <div v-if="filteredMemes.length" class="meme-list">
      <article v-for="meme in filteredMemes" :key="meme.id" class="meme-card" :class="{ disabled: meme.enabled === false, expanded: isExpanded(meme.id) }">
        <div class="meme-card-head">
          <button class="meme-expand-button" type="button" :aria-expanded="isExpanded(meme.id)" :title="isExpanded(meme.id) ? '收起详情' : '展开详情'" @click="toggleExpanded(meme.id)">
            <ChevronDown :size="16" />
          </button>
          <button class="meme-summary" type="button" @click="toggleExpanded(meme.id)">
            <span class="meme-title-row"><strong>{{ meme.name }}</strong><span class="origin-badge" :class="meme.createdBy === 'agent' ? 'agent' : 'manual'">{{ meme.createdBy === 'agent' ? 'Agent收集' : '手动创建' }}</span><span v-if="meme.enabled === false" class="disabled-badge">已停用</span></span>
            <span class="meme-summary-text">{{ meme.content }}</span>
            <span class="meme-summary-meta">{{ meme.source || '未标注来源' }}<span v-if="meme.tags?.length"> · {{ meme.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ') }}</span></span>
          </button>
          <div class="meme-card-actions"><label class="meme-toggle"><input type="checkbox" :checked="meme.enabled !== false" :disabled="busy" @change="emit('toggle', meme.id, ($event.target as HTMLInputElement).checked)" /><span>启用</span></label><button type="button" class="icon-button" title="编辑" @click="openEdit(meme)"><Edit3 :size="16" /></button><button type="button" class="icon-button danger" title="删除" :disabled="busy" @click="emit('delete', meme.id)"><Trash2 :size="16" /></button></div>
        </div>
        <div v-if="isExpanded(meme.id)" class="meme-card-details">
          <p class="meme-content">{{ meme.content }}</p>
          <p v-if="meme.explanation" class="meme-explanation">{{ meme.explanation }}</p>
          <div class="meme-meta"><span v-if="meme.source">来源：{{ meme.source }}</span><a v-if="meme.sourceUrl" :href="meme.sourceUrl" target="_blank" rel="noreferrer">查看来源</a><span v-if="meme.date">{{ meme.date }}</span></div>
          <div v-if="meme.tags?.length" class="meme-tags"><span v-for="tag in meme.tags" :key="tag">#{{ tag }}</span></div>
        </div>
      </article>
    </div>
    <div v-else class="empty-state"><Globe2 :size="25" /><strong>{{ query || sourceFilter !== 'all' ? '没有匹配的热梗' : '还没有网络热梗' }}</strong><span>{{ query || sourceFilter !== 'all' ? '可以清除本地搜索或调整筛选条件。' : '可以手动添加，或让 Agent 联网检索候选。' }}</span></div>

    <div v-if="showEditor" class="meme-editor-backdrop" @click.self="showEditor = false">
      <form class="meme-editor" @submit.prevent="saveDraft">
        <div class="editor-heading"><div><span class="panel-eyebrow">{{ editingId ? '编辑热梗' : '新增热梗' }}</span><h3>{{ editingId ? '编辑网络热梗' : '手动添加网络热梗' }}</h3></div><button type="button" class="icon-button" @click="showEditor = false"><X :size="18" /></button></div>
        <label>热梗名称<input v-model="draft.name" required placeholder="例如：破防了" /></label>
        <label>热梗内容<textarea v-model="draft.content" required rows="3" placeholder="填写具体表达或用法" /></label>
        <label>含义/使用说明<textarea v-model="draft.explanation" rows="3" placeholder="这个热梗表达什么，适合什么场景" /></label>
        <div class="editor-grid"><label>来源<input v-model="draft.source" placeholder="平台或账号" /></label><label>日期<input v-model="draft.date" type="date" /></label></div>
        <label>来源链接<input v-model="draft.sourceUrl" type="url" placeholder="https://" /></label>
        <label>标签（用逗号分隔）<input :value="draft.tags?.join(', ')" @input="draft.tags = ($event.target as HTMLInputElement).value.split(',').map(item => item.trim()).filter(Boolean)" placeholder="情绪, 网络用语" /></label>
        <div class="editor-footer"><label class="meme-toggle"><input v-model="draft.enabled" type="checkbox" /><span>启用并允许 Agent 读取</span></label><div><button type="button" class="secondary-action" @click="showEditor = false">取消</button><button type="submit" class="primary-action" :disabled="!draft.name.trim() || !draft.content.trim()">保存热梗</button></div></div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.internet-memes-panel { display:flex; flex-direction:column; gap:18px; height:100%; min-height:0; padding:24px; overflow:auto; background:var(--theme-workspace); color:var(--theme-font); }
.internet-memes-header { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; padding-bottom:4px; }
.internet-memes-header h2 { margin:5px 0 5px; color:var(--theme-font); font-size:26px; }
.internet-memes-header p { margin:0; color:var(--theme-muted); font-size:13px; }
.panel-eyebrow { display:inline-flex; align-items:center; gap:6px; color:var(--theme-muted); font-size:12px; }
.primary-action,.secondary-action,.small-primary,.small-button { display:inline-flex; align-items:center; justify-content:center; gap:6px; border-radius:7px; padding:9px 13px; border:1px solid var(--theme-border); color:var(--theme-font); background:var(--theme-surface-soft); font-size:13px; }
.primary-action,.small-primary { border-color:var(--theme-button); color:var(--theme-button-text); background:var(--theme-button); }
.secondary-action:hover,.small-button:hover { background:var(--theme-hover); }
.internet-memes-toolbar { display:flex; align-items:center; gap:10px; }
.meme-search { display:flex; align-items:center; gap:7px; flex:1; max-width:500px; padding:8px 10px; border:1px solid var(--theme-border); border-radius:7px; background:var(--theme-surface-soft); color:var(--theme-muted); }
.meme-search input { width:100%; border:0; outline:0; background:transparent; font-size:13px; }
.meme-engine-select { min-width:120px; border:1px solid var(--theme-border); border-radius:7px; padding:8px 10px; color:var(--theme-font); background:var(--theme-input-bg); font-size:13px; outline:0; }
.meme-search-clear { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; border:0; border-radius:5px; background:transparent; color:var(--theme-muted); }
.meme-search-clear:hover { background:var(--theme-hover); color:var(--theme-button); }
.meme-count { margin-left:auto; color:var(--theme-muted); font-size:12px; }
.meme-management-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 0 2px; border-bottom:1px solid var(--theme-border-soft); }
.meme-management-title { display:flex; align-items:baseline; gap:9px; color:var(--theme-font); font-size:13px; font-weight:700; }
.meme-management-title small { color:var(--theme-muted); font-size:11px; font-weight:400; }
.meme-management-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.meme-select-label { display:inline-flex; align-items:center; gap:5px; color:var(--theme-muted); font-size:11px; }
.meme-select-label select { min-width:92px; border:1px solid var(--theme-border); border-radius:6px; padding:6px 8px; color:var(--theme-font); background:var(--theme-surface-soft); font-size:12px; }
.meme-candidates { display:grid; gap:10px; padding:14px; border:1px solid var(--theme-border); border-radius:9px; background:var(--theme-accent-soft); }
.subsection-heading { display:flex; justify-content:space-between; align-items:center; color:var(--theme-font); font-size:13px; font-weight:700; }
.candidate-card,.meme-card { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; border:1px solid var(--theme-border); border-radius:9px; padding:15px; background:var(--theme-surface-soft); }
.candidate-main,.meme-card-body { min-width:0; flex:1; }
.candidate-main strong,.meme-title-row h3 { color:var(--theme-font); font-size:15px; }
.candidate-main p,.meme-content { margin:7px 0 5px; color:var(--theme-font); line-height:1.6; font-size:14px; }
.candidate-main small,.meme-meta,.meme-explanation { color:var(--theme-muted); font-size:12px; }
.candidate-actions,.meme-card-actions { display:flex; align-items:center; gap:7px; flex-shrink:0; }
.meme-list { display:grid; gap:10px; }
.meme-card { display:block; padding:0; overflow:hidden; transition:border-color .16s ease, box-shadow .16s ease; }
.meme-card.expanded { border-color:var(--theme-button); box-shadow:0 3px 12px color-mix(in srgb, var(--theme-button) 6%, transparent); }
.meme-card-head { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; align-items:center; gap:8px; min-height:64px; padding:8px 11px 8px 8px; }
.meme-expand-button { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:0; border-radius:6px; color:var(--theme-muted); background:transparent; transition:transform .16s ease, background .16s ease; }
.meme-card.expanded .meme-expand-button { transform:rotate(180deg); }
.meme-expand-button:hover { background:var(--theme-hover); }
.meme-summary { min-width:0; padding:2px 0; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; }
.meme-summary:hover .meme-title-row strong { color:var(--theme-button); }
.meme-summary-text { display:block; overflow:hidden; margin-top:3px; color:var(--theme-muted); font-size:12px; line-height:1.45; text-overflow:ellipsis; white-space:nowrap; }
.meme-summary-meta { display:block; overflow:hidden; margin-top:3px; color:var(--theme-muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.meme-card-details { margin:0 16px 13px 44px; padding:12px 0 0; border-top:1px solid var(--theme-border-soft); }
.meme-card-details .meme-content { margin-top:0; }
.disabled-badge { border-radius:9px; padding:2px 6px; color:var(--theme-muted); background:var(--theme-neutral-soft); font-size:10px; }
.meme-title-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.meme-title-row h3 { margin:0; }
.meme-title-row strong { color:var(--theme-font); font-size:14px; }
.origin-badge { border-radius:10px; padding:3px 7px; font-size:10px; background:var(--theme-neutral-soft); color:var(--theme-muted); }
.origin-badge.agent { color:var(--theme-button); background:var(--theme-accent-soft); }
.meme-explanation { margin:7px 0; }
.meme-meta { display:flex; gap:10px; flex-wrap:wrap; }
.meme-meta a { color:var(--theme-button); }
.meme-tags { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
.meme-tags span { color:var(--theme-font); background:var(--theme-accent-soft); border-radius:9px; padding:3px 7px; font-size:11px; }
.meme-card.disabled { opacity:.6; }
.meme-toggle { display:inline-flex; align-items:center; gap:5px; color:var(--theme-muted); font-size:12px; white-space:nowrap; }
.meme-toggle input { accent-color:var(--theme-button); }
.icon-button { display:inline-flex; align-items:center; justify-content:center; width:29px; height:29px; padding:0; border:1px solid var(--theme-border); border-radius:6px; background:var(--theme-surface-soft); color:var(--theme-muted); }
.icon-button:hover { background:var(--theme-hover); }
.icon-button.danger:hover { color:var(--theme-danger); background:var(--theme-neutral-soft); }
.show-candidates { border:0; color:var(--theme-button); background:transparent; font-size:12px; text-align:left; }
.empty-state { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; min-height:220px; color:var(--theme-muted); }
.empty-state strong { color:var(--theme-font); font-size:14px; }
.empty-state span { font-size:12px; }
.meme-editor-backdrop { position:fixed; inset:0; z-index:80; display:flex; align-items:center; justify-content:center; padding:20px; background:var(--theme-overlay); }
.meme-editor { display:grid; gap:13px; width:min(580px,100%); max-height:calc(100vh - 40px); overflow:auto; padding:22px; border:1px solid var(--theme-border); border-radius:11px; background:var(--theme-surface-soft); box-shadow:0 18px 50px color-mix(in srgb, var(--theme-font) 20%, transparent); }
.editor-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.editor-heading h3 { margin:5px 0 0; color:var(--theme-font); }
.meme-editor label { display:grid; gap:6px; color:var(--theme-muted); font-size:12px; }
.meme-editor input,.meme-editor textarea { width:100%; border:1px solid var(--theme-border); border-radius:6px; padding:9px 10px; outline:0; color:var(--theme-font); background:var(--theme-input-bg); }
.meme-editor input:focus,.meme-editor textarea:focus { border-color:var(--theme-button); }
.editor-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.editor-footer { display:flex; align-items:center; justify-content:space-between; gap:10px; padding-top:7px; border-top:1px solid var(--theme-border-soft); }
.editor-footer > div { display:flex; gap:8px; }
@media (max-width:700px) { .internet-memes-panel { padding:16px; } .internet-memes-header,.internet-memes-toolbar,.candidate-card,.editor-footer { flex-direction:column; align-items:stretch; } .meme-management-bar { align-items:flex-start; flex-direction:column; } .meme-count { margin-left:0; } .candidate-actions,.meme-card-actions { justify-content:flex-end; } .meme-card-head { grid-template-columns:auto minmax(0, 1fr); } .meme-card-actions { grid-column:2; justify-content:flex-start; } .meme-card-details { margin-left:44px; } .editor-grid { grid-template-columns:1fr; } }

:global(html[data-theme-mode] .internet-memes-panel){
  color: var(--theme-font);
  background: var(--theme-workspace);
}
:global(html[data-theme-mode] .internet-memes-header h2),
:global(html[data-theme-mode] .meme-title-row strong),
:global(html[data-theme-mode] .candidate-main strong),
:global(html[data-theme-mode] .editor-heading h3),
:global(html[data-theme-mode] .internet-memes-panel .empty-state strong){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .internet-memes-header p),
:global(html[data-theme-mode] .panel-eyebrow),
:global(html[data-theme-mode] .meme-count),
:global(html[data-theme-mode] .meme-management-title small),
:global(html[data-theme-mode] .meme-select-label),
:global(html[data-theme-mode] .candidate-main small),
:global(html[data-theme-mode] .meme-summary-meta),
:global(html[data-theme-mode] .meme-meta),
:global(html[data-theme-mode] .meme-explanation),
:global(html[data-theme-mode] .meme-toggle),
:global(html[data-theme-mode] .internet-memes-panel .empty-state),
:global(html[data-theme-mode] .meme-editor label){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .internet-memes-panel button),
:global(html[data-theme-mode] .internet-memes-panel select),
:global(html[data-theme-mode] .internet-memes-panel input),
:global(html[data-theme-mode] .internet-memes-panel textarea){
  font-family: inherit;
}
:global(html[data-theme-mode] .meme-search),
:global(html[data-theme-mode] .meme-engine-select),
:global(html[data-theme-mode] .meme-engine-select option),
:global(html[data-theme-mode] .meme-select-label select),
:global(html[data-theme-mode] .meme-editor input),
:global(html[data-theme-mode] .meme-editor textarea){
  color: var(--theme-font);
  background: var(--theme-input-bg);
  border-color: var(--theme-border);
}
:global(html[data-theme-mode] .meme-search input){
  min-width: 0;
  color: var(--theme-font);
  background: transparent;
}
:global(html[data-theme-mode] .meme-search input::placeholder),
:global(html[data-theme-mode] .meme-editor input::placeholder),
:global(html[data-theme-mode] .meme-editor textarea::placeholder){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .meme-search > svg),
:global(html[data-theme-mode] .meme-search-clear),
:global(html[data-theme-mode] .meme-expand-button),
:global(html[data-theme-mode] .internet-memes-panel .icon-button){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .internet-memes-panel button:focus-visible),
:global(html[data-theme-mode] .internet-memes-panel select:focus-visible),
:global(html[data-theme-mode] .internet-memes-panel input:focus-visible),
:global(html[data-theme-mode] .internet-memes-panel textarea:focus-visible){
  outline: 2px solid var(--theme-button);
  outline-offset: 2px;
}
:global(html[data-theme-mode] .meme-search:focus-within),
:global(html[data-theme-mode] .meme-engine-select:focus),
:global(html[data-theme-mode] .meme-select-label select:focus),
:global(html[data-theme-mode] .meme-editor input:focus),
:global(html[data-theme-mode] .meme-editor textarea:focus){
  border-color: var(--theme-button);
}
:global(html[data-theme-mode] .primary-action),
:global(html[data-theme-mode] .small-primary){
  color: var(--theme-button-text);
  background: var(--theme-button);
  border-color: var(--theme-button);
}
:global(html[data-theme-mode] .primary-action:hover:not(:disabled)),
:global(html[data-theme-mode] .small-primary:hover:not(:disabled)){
  background: var(--theme-button-hover);
  border-color: var(--theme-button-hover);
}
:global(html[data-theme-mode] .secondary-action),
:global(html[data-theme-mode] .small-button),
:global(html[data-theme-mode] .internet-memes-panel .icon-button){
  color: var(--theme-font);
  background: var(--theme-surface-soft);
  border-color: var(--theme-border);
}
:global(html[data-theme-mode] .secondary-action:hover:not(:disabled)),
:global(html[data-theme-mode] .small-button:hover:not(:disabled)),
:global(html[data-theme-mode] .internet-memes-panel .icon-button:hover:not(:disabled)),
:global(html[data-theme-mode] .meme-search-clear:hover),
:global(html[data-theme-mode] .meme-expand-button:hover){
  color: var(--theme-font);
  background: var(--theme-hover);
  border-color: var(--theme-button);
}
:global(html[data-theme-mode] .internet-memes-panel .icon-button.danger:hover:not(:disabled)){
  color: var(--theme-button-text);
  background: color-mix(in srgb, var(--theme-button) 82%, var(--theme-font) 18%);
  border-color: var(--theme-button);
}
:global(html[data-theme-mode] .internet-memes-panel button:disabled),
:global(html[data-theme-mode] .internet-memes-panel select:disabled),
:global(html[data-theme-mode] .internet-memes-panel input:disabled),
:global(html[data-theme-mode] .internet-memes-panel textarea:disabled){
  color: var(--theme-muted);
  cursor: not-allowed;
}
:global(html[data-theme-mode] .internet-memes-panel button:disabled){
  background: color-mix(in srgb, var(--theme-secondary) 88%, var(--theme-font) 12%);
  border-color: var(--theme-border);
}
:global(html[data-theme-mode] .meme-management-title),
:global(html[data-theme-mode] .subsection-heading),
:global(html[data-theme-mode] .candidate-main p),
:global(html[data-theme-mode] .meme-content),
:global(html[data-theme-mode] .meme-summary-text){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .meme-management-bar),
:global(html[data-theme-mode] .meme-card-details),
:global(html[data-theme-mode] .internet-memes-panel .editor-footer){
  border-color: var(--theme-border-soft);
}
:global(html[data-theme-mode] .meme-candidates),
:global(html[data-theme-mode] .candidate-card),
:global(html[data-theme-mode] .meme-card),
:global(html[data-theme-mode] .meme-editor){
  color: var(--theme-font);
  background: var(--theme-surface-soft);
  border-color: var(--theme-border);
}
:global(html[data-theme-mode] .meme-candidates){
  background: color-mix(in srgb, var(--theme-secondary) 86%, var(--theme-button) 14%);
}
:global(html[data-theme-mode] .meme-card.expanded){
  border-color: var(--theme-button);
  box-shadow: 0 3px 12px color-mix(in srgb, var(--theme-button) 12%, transparent);
}
:global(html[data-theme-mode] .meme-summary:hover .meme-title-row strong),
:global(html[data-theme-mode] .meme-meta a),
:global(html[data-theme-mode] .show-candidates){
  color: var(--theme-button);
}
:global(html[data-theme-mode] .meme-meta a:hover),
:global(html[data-theme-mode] .show-candidates:hover){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .origin-badge){
  color: var(--theme-font);
  background: color-mix(in srgb, var(--theme-secondary) 88%, var(--theme-font) 12%);
}
:global(html[data-theme-mode] .origin-badge.agent){
  color: var(--theme-font);
  background: color-mix(in srgb, var(--theme-secondary) 76%, var(--theme-button) 24%);
}
:global(html[data-theme-mode] .disabled-badge){
  color: var(--theme-muted);
  background: color-mix(in srgb, var(--theme-secondary) 80%, var(--theme-font) 20%);
}
:global(html[data-theme-mode] .meme-tags span){
  color: var(--theme-font);
  background: color-mix(in srgb, var(--theme-secondary) 82%, var(--theme-button) 18%);
}
:global(html[data-theme-mode] .meme-card.disabled){
  opacity: 1;
  background: color-mix(in srgb, var(--theme-secondary) 92%, var(--theme-font) 8%);
}
:global(html[data-theme-mode] .meme-card.disabled .meme-title-row strong),
:global(html[data-theme-mode] .meme-card.disabled .meme-summary-text),
:global(html[data-theme-mode] .meme-card.disabled .meme-summary-meta),
:global(html[data-theme-mode] .meme-card.disabled .meme-content){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .meme-toggle input){
  accent-color: var(--theme-button);
}
:global(html[data-theme-mode] .meme-editor-backdrop){
  background: var(--theme-overlay);
}
:global(html[data-theme-mode] .meme-editor){
  box-shadow: 0 18px 50px color-mix(in srgb, var(--theme-font) 24%, transparent);
}
</style>
