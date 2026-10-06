<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowUp,
  Check,
  FolderPlus,
  LoaderCircle,
  PenLine,
  Save,
  Trash2,
  X,
} from 'lucide-vue-next'
import type { Chapter, Resource } from '../types'
import type { OutlineDeleteStrategy } from '../data/outline'

type HoldingType = 'items' | 'skills'
type HoldingPickerState = { type: HoldingType; characterId: string }
type CardDetailState = { type: HoldingType; id: string }
type SaveGuardDecision = 'save' | 'discard' | 'cancel'
type ModalKind = 'holdingPicker' | 'cardDetail' | 'projectDelete' | 'chapterDelete' | 'projectRename' | 'resourceGroup' | 'outlineDelete'

const props = defineProps<{
  holdingPicker: HoldingPickerState | null
  holdingPickerResources: Resource[]
  holdingPickerCharacter?: Resource
  cardDetail: CardDetailState | null
  cardDetailResource?: Resource
  chapterDeleteOpen: boolean
  activeChapter: Chapter
  outlineDeleteOpen: boolean
  outlineDeleteTarget?: Resource
  outlineDeleteDescendantIds: string[]
  outlineDeleteDirectChildCount: number
  projectDeleteOpen: boolean
  currentWorkTitle: string
  saveGuardOpen: boolean
  saveGuardBusy: boolean
  saveGuardError: string
  saveGuardReason: string
  projectRenameOpen: boolean
  renameTitle: string
  resourceGroupDialogOpen: boolean
  currentConfigTitle?: string
  resourceGroupEditingId: string | null
  resourceGroupTitle: string
  isHolding: (character: Resource, type: HoldingType, id: string) => boolean
  toggleHolding: (type: HoldingType, id: string) => void
  rememberModalPointerDown: (event: PointerEvent) => void
  closeModalOnBackdrop: (kind: ModalKind, event: MouseEvent) => void
  cancelDeleteChapter: () => void
  confirmDeleteChapter: () => void
  cancelOutlineDelete: () => void
  confirmOutlineDelete: (strategy: OutlineDeleteStrategy) => void
  cancelDeleteProject: () => void
  confirmDeleteProject: () => void
  resolveSaveGuard: (decision: SaveGuardDecision) => void
  cancelRenameProject: () => void
  confirmRenameProject: () => void
  cancelResourceGroupDialog: () => void
  createResourceGroup: () => void
}>()

const emit = defineEmits<{
  (event: 'close-holding-picker'): void
  (event: 'close-card-detail'): void
  (event: 'rename-title-change', value: string): void
  (event: 'resource-group-title-change', value: string): void
}>()

const renameTitleModel = computed({
  get: () => props.renameTitle,
  set: (value: string) => emit('rename-title-change', value),
})

const resourceGroupTitleModel = computed({
  get: () => props.resourceGroupTitle,
  set: (value: string) => emit('resource-group-title-change', value),
})
</script>

<template>
  <div v-if="holdingPicker" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('holdingPicker', $event)">
    <section class="card-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <header class="card-modal-head">
        <div>
          <span class="eyebrow">角色关联</span>
          <h2 id="picker-title">添加{{ holdingPicker.type === 'skills' ? '技能' : '道具' }}</h2>
        </div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('close-holding-picker')"><X :size="18" /></button>
      </header>
      <p class="card-modal-intro">点击卡片即可添加或移除，已关联的卡片会显示勾选状态。</p>
      <div class="card-picker-list">
        <button
          v-for="item in holdingPickerResources"
          :key="item.id"
          :class="['card-picker-item', { selected: holdingPickerCharacter ? isHolding(holdingPickerCharacter, holdingPicker.type, item.id) : false }]"
          type="button"
          @click="toggleHolding(holdingPicker.type, item.id)"
        >
          <span><strong>{{ item.title }}</strong><small>{{ item.summary }}</small></span>
          <Check v-if="holdingPickerCharacter && isHolding(holdingPickerCharacter, holdingPicker.type, item.id)" :size="16" />
        </button>
      </div>
    </section>
  </div>

  <div v-if="cardDetail && cardDetailResource" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('cardDetail', $event)">
    <article class="card-detail-modal" role="dialog" aria-modal="true" aria-labelledby="card-detail-title">
      <header class="card-modal-head">
        <div><span class="eyebrow">{{ cardDetail.type === 'skills' ? '技能卡' : '道具卡' }}</span><h2 id="card-detail-title">{{ cardDetailResource.title }}</h2></div>
        <button class="icon-button" type="button" title="关闭详情" aria-label="关闭详情" @click="emit('close-card-detail')"><X :size="18" /></button>
      </header>
      <p class="card-detail-summary">{{ cardDetailResource.summary }}</p>
      <dl class="card-detail-fields"><template v-for="(value, key) in cardDetailResource.fields" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
    </article>
  </div>

  <div v-if="chapterDeleteOpen" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('chapterDelete', $event)">
    <article class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-chapter-title">
      <header class="card-modal-head">
        <div><span class="eyebrow">章节管理</span><h2 id="delete-chapter-title">删除当前章节？</h2></div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="cancelDeleteChapter"><X :size="18" /></button>
      </header>
      <p class="card-modal-intro">将删除“{{ activeChapter.title }}”及其正文、任务和出场人物。此操作无法撤销。若这是最后一章，会自动新建一个空白章节。</p>
      <div class="confirm-actions"><button class="button secondary" type="button" @click="cancelDeleteChapter">取消</button><button class="button danger-button" type="button" @click="confirmDeleteChapter"><Trash2 :size="15" />确认删除</button></div>
    </article>
  </div>

  <div v-if="outlineDeleteOpen && outlineDeleteTarget" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('outlineDelete', $event)">
    <article class="confirm-modal outline-delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-outline-title">
      <header class="card-modal-head">
        <div><span class="eyebrow">大纲层级</span><h2 id="delete-outline-title">删除“{{ outlineDeleteTarget.title }}”？</h2></div>
        <button class="icon-button" type="button" title="取消删除" aria-label="取消删除" @click="cancelOutlineDelete"><X :size="18" /></button>
      </header>
      <p class="card-modal-intro">这个节点下面有 {{ outlineDeleteDescendantIds.length }} 个子节点（直接子节点 {{ outlineDeleteDirectChildCount }} 个）。请选择删除后的层级处理方式。</p>
      <div class="outline-delete-summary">
        <div><strong>子节点上移</strong><small>删除当前节点，直接子节点接到它的上级；更深层的子节点保持原有关系。</small></div>
        <div><strong>连同子节点删除</strong><small>删除当前节点和它下面的全部 {{ outlineDeleteDescendantIds.length }} 个子节点。</small></div>
      </div>
      <div class="confirm-actions">
        <button class="button secondary" type="button" @click="cancelOutlineDelete">取消</button>
        <button class="button secondary" type="button" @click="confirmOutlineDelete('promote')"><ArrowUp :size="15" />子节点上移</button>
        <button class="button danger-button" type="button" @click="confirmOutlineDelete('cascade')"><Trash2 :size="15" />连同子节点删除</button>
      </div>
    </article>
  </div>

  <div v-if="projectDeleteOpen" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('projectDelete', $event)">
    <article class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
      <header class="card-modal-head">
        <div><span class="eyebrow">作品管理</span><h2 id="delete-project-title">删除当前作品？</h2></div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="cancelDeleteProject"><X :size="18" /></button>
      </header>
      <p class="card-modal-intro">将删除“{{ currentWorkTitle }}”的章节、世界书、角色卡、道具卡、技能卡和大纲等本地资料。API 设置不会被删除。</p>
      <div class="confirm-actions"><button class="button secondary" type="button" @click="cancelDeleteProject">取消</button><button class="button danger-button" type="button" @click="confirmDeleteProject"><Trash2 :size="15" />确认删除</button></div>
    </article>
  </div>

  <div v-if="saveGuardOpen" class="card-modal-backdrop" @pointerdown.stop @click.self="resolveSaveGuard('cancel')">
    <article class="confirm-modal save-guard-modal" role="dialog" aria-modal="true" aria-labelledby="save-guard-title">
      <header class="card-modal-head">
        <div><span class="eyebrow">保存保护</span><h2 id="save-guard-title">当前有未保存修改</h2></div>
        <button class="icon-button" type="button" title="取消操作" aria-label="取消操作" :disabled="saveGuardBusy" @click="resolveSaveGuard('cancel')"><X :size="18" /></button>
      </header>
      <p class="card-modal-intro">在{{ saveGuardReason }}前，请选择如何处理当前修改。保存会等待本机存储和作品集文件都完成写入。</p>
      <p v-if="saveGuardError" class="generation-error" role="alert">{{ saveGuardError }}</p>
      <div class="confirm-actions">
        <button class="button secondary" type="button" :disabled="saveGuardBusy" @click="resolveSaveGuard('cancel')">取消</button>
        <button class="button danger-button" type="button" :disabled="saveGuardBusy" @click="resolveSaveGuard('discard')">放弃修改</button>
        <button class="button primary" type="button" :disabled="saveGuardBusy" @click="resolveSaveGuard('save')"><LoaderCircle v-if="saveGuardBusy" class="spin" :size="15" /><Save v-else :size="15" />保存并继续</button>
      </div>
    </article>
  </div>

  <div v-if="projectRenameOpen" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('projectRename', $event)">
    <article class="confirm-modal rename-modal" role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
      <header class="card-modal-head">
        <div><span class="eyebrow">作品管理</span><h2 id="rename-project-title">重命名作品</h2></div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="cancelRenameProject"><X :size="18" /></button>
      </header>
      <label class="form-field rename-field"><span>作品名称</span><input v-model="renameTitleModel" type="text" maxlength="60" autofocus @keyup.enter="confirmRenameProject" /></label>
      <div class="confirm-actions"><button class="button secondary" type="button" @click="cancelRenameProject">取消</button><button class="button primary" type="button" :disabled="!renameTitle.trim()" @click="confirmRenameProject"><PenLine :size="15" />保存名称</button></div>
    </article>
  </div>

  <div v-if="resourceGroupDialogOpen" class="card-modal-backdrop" @pointerdown="rememberModalPointerDown" @click.self="closeModalOnBackdrop('resourceGroup', $event)">
    <article class="confirm-modal group-modal" role="dialog" aria-modal="true" aria-labelledby="resource-group-title">
      <header class="card-modal-head">
        <div><span class="eyebrow">{{ currentConfigTitle }}</span><h2 id="resource-group-title">{{ resourceGroupEditingId ? '重命名折叠栏' : '添加折叠栏' }}</h2></div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="cancelResourceGroupDialog"><X :size="18" /></button>
      </header>
      <label class="form-field rename-field"><span>折叠栏名称</span><input v-model="resourceGroupTitleModel" type="text" maxlength="40" placeholder="例如：主要角色、核心道具" autofocus @keyup.enter="createResourceGroup" /></label>
      <div class="confirm-actions"><button class="button secondary" type="button" @click="cancelResourceGroupDialog">取消</button><button class="button primary" type="button" :disabled="!resourceGroupTitle.trim()" @click="createResourceGroup"><PenLine v-if="resourceGroupEditingId" :size="15" /><FolderPlus v-else :size="15" />{{ resourceGroupEditingId ? '保存名称' : '创建折叠栏' }}</button></div>
    </article>
  </div>
</template>
