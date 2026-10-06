<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Archive, FileText, FolderOpen, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-vue-next'
import type { DesktopPortfolioFileSettingsBridge, PortfolioBackup, PortfolioDirectories } from '../files/types'
import '../files/settings.css'

const props = defineProps<{
  filePath: string
  backupCount: number
  restoring?: boolean
  restoreError?: string
  restoreMessage?: string
  restoredPath?: string
}>()
const emit = defineEmits<{
  updateBackupCount: [count: number]
  restoreBackup: [backupId: string]
  openRestoredBackup: [path: string]
}>()

const backupChoices = [0, 3, 5, 10, 20, 50] as const
const available = ref(false)
const loading = ref(true)
const directories = ref<PortfolioDirectories | null>(null)
const backups = ref<PortfolioBackup[]>([])
const directoriesError = ref('')
const backupsError = ref('')
const actionError = ref('')
const openingDirectory = ref<'save' | 'backup' | ''>('')
const hasFile = computed(() => Boolean(props.filePath.trim()))
let bridge: DesktopPortfolioFileSettingsBridge | undefined
let disposed = false
let requestRevision = 0

function failureText(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback
}

async function refresh() {
  if (!bridge || disposed) return
  const fileBridge = bridge
  const revision = ++requestRevision
  const filePath = props.filePath
  loading.value = true
  directoriesError.value = ''
  backupsError.value = ''
  actionError.value = ''
  const results = await Promise.allSettled([
    Promise.resolve().then(() => fileBridge.directories()),
    filePath.trim() ? Promise.resolve().then(() => fileBridge.backups(filePath)) : Promise.resolve(null),
  ])
  // Changing the selected portfolio invalidates all earlier replies, even if
  // the file service finishes reading the old backup pool later.
  if (disposed || revision !== requestRevision || props.filePath !== filePath) return
  const [directoryResult, backupsResult] = results
  if (directoryResult.status === 'fulfilled') {
    directories.value = directoryResult.value
    directoriesError.value = directoryResult.value.error || ''
  } else {
    directoriesError.value = failureText(directoryResult.reason, '无法读取保存和备份目录，请重试。')
  }
  if (backupsResult.status === 'fulfilled' && backupsResult.value) {
    const result = backupsResult.value
    backups.value = [...result.entries].sort((left, right) => right.createdAt - left.createdAt)
    backupsError.value = result.error || ''
    // Backups also return the directories. Keep them available if only the
    // independent directory lookup failed.
    if (directoryResult.status === 'rejected') {
      directories.value = { saveDirectory: result.saveDirectory, backupDirectory: result.backupDirectory }
    }
  } else if (backupsResult.status === 'rejected') {
    backups.value = []
    backupsError.value = failureText(backupsResult.reason, '无法读取当前作品集的备份，请重试。')
  } else {
    backups.value = []
  }
  loading.value = false
}

function updateBackupCount(event: Event) {
  const count = Number((event.target as HTMLSelectElement).value)
  if (backupChoices.some((choice) => choice === count)) emit('updateBackupCount', count)
}

async function openDirectory(kind: 'save' | 'backup') {
  if (!bridge || openingDirectory.value || disposed) return
  openingDirectory.value = kind
  actionError.value = ''
  try {
    const result = await bridge.openDirectory(kind)
    if (!disposed && (!result.ok || result.error)) actionError.value = result.error || '无法打开目录，请重试。'
  } catch (failure) {
    if (!disposed) actionError.value = failureText(failure, '无法打开目录，请重试。')
  } finally {
    if (!disposed) openingDirectory.value = ''
  }
}

function restoreBackup(id: string) {
  if (loading.value || props.restoring || disposed) return
  if (!backups.value.some((backup) => backup.id === id && backup.valid)) return
  emit('restoreBackup', id)
}

function openRestoredBackup() {
  if (disposed || props.restoring || !props.restoredPath?.trim()) return
  emit('openRestoredBackup', props.restoredPath)
}

function formatTime(timestamp: number) {
  const time = new Date(timestamp)
  return Number.isFinite(time.getTime())
    ? time.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '时间未知'
}

function isoTime(timestamp: number) {
  const time = new Date(timestamp)
  return Number.isFinite(time.getTime()) ? time.toISOString() : undefined
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

watch(() => props.filePath, () => {
  backups.value = []
  backupsError.value = ''
  void refresh()
}, { flush: 'sync' })

onMounted(() => {
  bridge = (window as unknown as { desktopFile?: DesktopPortfolioFileSettingsBridge }).desktopFile
  available.value = Boolean(bridge && typeof bridge.directories === 'function'
    && typeof bridge.backups === 'function' && typeof bridge.openDirectory === 'function')
  if (!available.value) { bridge = undefined; loading.value = false; return }
  void refresh()
})

onBeforeUnmount(() => {
  disposed = true
  requestRevision += 1
})
</script>

<template>
  <section class="portfolio-file-settings" aria-label="作品文件设置">
    <header class="portfolio-file-settings-heading">
      <div>
        <span class="portfolio-file-eyebrow">.qy 作品集</span>
        <h3><FileText :size="19" />作品文件</h3>
        <p>一个 .qy 文件保存全部作品和创作资料。API、主题和其他软件设置独立保存在本机。</p>
      </div>
      <button class="portfolio-file-icon-button" type="button" title="刷新目录和备份" aria-label="刷新目录和备份" :disabled="!available || loading || restoring" @click="refresh"><RefreshCw :size="15" :class="{ spin: loading }" /></button>
    </header>

    <div v-if="!available && !loading" class="portfolio-file-empty"><FileText :size="23" /><strong>作品文件管理需要桌面环境</strong><span>请通过桌面程序打开设置。</span></div>
    <template v-else>
      <section class="portfolio-file-settings-card">
        <div class="portfolio-file-card-heading"><h4><FileText :size="14" />当前作品集</h4></div>
        <code v-if="hasFile" class="portfolio-file-path">{{ props.filePath }}</code>
        <p v-else class="portfolio-file-helper">当前作品集尚未保存为 .qy 文件。首次保存后，可在这里查看它的备份。</p>
        <p class="portfolio-file-helper">“新建作品”在当前作品集内增加作品；“新建作品集”创建另一个 .qy 文件。</p>
      </section>

      <section class="portfolio-file-settings-card">
        <div class="portfolio-file-card-heading"><h4><FolderOpen :size="14" />本机目录</h4></div>
        <div class="portfolio-file-directory">
          <div><span>默认保存目录</span><code>{{ directories?.saveDirectory || (loading ? '正在读取…' : '目录未能读取') }}</code></div>
          <button class="portfolio-file-button" type="button" aria-label="打开保存目录" :disabled="!directories?.saveDirectory || Boolean(openingDirectory)" @click="openDirectory('save')"><LoaderCircle v-if="openingDirectory === 'save'" :size="13" class="spin" /><FolderOpen v-else :size="13" />打开目录</button>
        </div>
        <div class="portfolio-file-directory">
          <div><span>备份目录</span><code>{{ directories?.backupDirectory || (loading ? '正在读取…' : '目录未能读取') }}</code></div>
          <button class="portfolio-file-button" type="button" aria-label="打开备份目录" :disabled="!directories?.backupDirectory || Boolean(openingDirectory)" @click="openDirectory('backup')"><LoaderCircle v-if="openingDirectory === 'backup'" :size="13" class="spin" /><FolderOpen v-else :size="13" />打开目录</button>
        </div>
        <p v-if="directoriesError" class="portfolio-file-message portfolio-file-message-error" role="alert">{{ directoriesError }}</p>
        <p v-if="actionError" class="portfolio-file-message portfolio-file-message-error" role="alert">{{ actionError }}</p>
      </section>

      <section class="portfolio-file-settings-card">
        <div class="portfolio-file-card-heading portfolio-file-backup-heading">
          <h4><Archive :size="14" />备份与恢复</h4>
          <label class="portfolio-file-count-field"><span>保留备份数量</span><select :value="props.backupCount" aria-label="保留备份数量" :disabled="restoring" @change="updateBackupCount"><option v-for="count in backupChoices" :key="count" :value="count">{{ count === 0 ? '不保留备份' : `最近 ${count} 个` }}</option></select></label>
        </div>
        <p class="portfolio-file-helper">保存已有作品集前，会保留它的上一版本；备份按原文件路径分别管理，超过数量后移除最旧的备份。选择 0 表示不保留备份。</p>
        <p class="portfolio-file-helper">恢复会选择一个新的 .qy 文件保存，不覆盖当前作品集。你可以在恢复后选择打开新文件。</p>

        <p v-if="props.restoreError" class="portfolio-file-message portfolio-file-message-error" role="alert">{{ props.restoreError }}</p>
        <p v-if="props.restoreMessage" class="portfolio-file-message portfolio-file-message-success" role="status">{{ props.restoreMessage }}</p>
        <button v-if="props.restoredPath" class="portfolio-file-button portfolio-file-button-primary portfolio-file-open-restored" type="button" :disabled="restoring" @click="openRestoredBackup"><FileText :size="13" />打开恢复的作品集</button>
        <p v-if="backupsError" class="portfolio-file-message portfolio-file-message-error" role="alert">{{ backupsError }}</p>
        <div v-if="loading" class="portfolio-file-list-state" role="status"><LoaderCircle :size="15" class="spin" />正在读取备份…</div>
        <div v-else-if="!hasFile" class="portfolio-file-list-state">保存作品集后，在这里查看它的备份。</div>
        <div v-else-if="!backups.length && !backupsError" class="portfolio-file-list-state">当前作品集还没有备份。</div>
        <ol v-else-if="backups.length" class="portfolio-file-backup-list" aria-label="当前作品集备份">
          <li v-for="backup in backups" :key="backup.id" :class="['portfolio-file-backup', { 'portfolio-file-backup-invalid': !backup.valid }]">
            <div class="portfolio-file-backup-detail">
              <strong>{{ backup.title || '未命名作品集' }}</strong>
              <div class="portfolio-file-backup-meta"><time :datetime="isoTime(backup.createdAt)">{{ formatTime(backup.createdAt) }}</time><span>{{ formatSize(backup.size) }}</span><span v-if="backup.projectCount !== undefined">{{ backup.projectCount }} 部作品</span><span v-if="!backup.valid" class="portfolio-file-invalid-label">备份损坏</span></div>
              <p v-if="!backup.valid" class="portfolio-file-backup-error">{{ backup.error || '此备份未通过作品集校验，不能恢复。' }}</p>
            </div>
            <button class="portfolio-file-button" type="button" :disabled="!backup.valid || Boolean(restoring)" :aria-label="`将${backup.title || '此备份'}恢复为新作品集`" @click="restoreBackup(backup.id)"><LoaderCircle v-if="restoring" :size="13" class="spin" /><RotateCcw v-else :size="13" />恢复为新作品集</button>
          </li>
        </ol>
      </section>
    </template>
  </section>
</template>
