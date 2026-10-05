<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Check, Crop, ImagePlus, Images, Move, Star, Trash2, X, ZoomIn } from 'lucide-vue-next'
import type { CharacterImage } from '../types'

type CropSource = {
  dataUrl: string
  name: string
  file?: File
  existingId?: string
}

const props = withDefaults(defineProps<{
  images: CharacterImage[]
  coverImageId?: string
}>(), {
  coverImageId: '',
})

const emit = defineEmits<{
  update: [value: { images: CharacterImage[]; coverImageId: string }]
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const cropFrame = ref<HTMLElement | null>(null)
const cropImage = ref<HTMLImageElement | null>(null)
const galleryOpen = ref(false)
const cropOpen = ref(false)
const cropQueue = ref<CropSource[]>([])
const cropIndex = ref(0)
const cropName = ref('')
const cropError = ref('')
const uploadError = ref('')
const frameSize = ref({ width: 0, height: 0 })
const imageSize = ref({ width: 0, height: 0 })
const cropOffset = ref({ x: 0, y: 0 })
const cropZoom = ref(1)
const pointerDrag = ref<{ pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number } | null>(null)
const resumeGalleryAfterCrop = ref(false)

const coverImage = computed(() => props.images.find((image) => image.id === props.coverImageId) ?? props.images[0] ?? null)
const currentCrop = computed(() => cropQueue.value[cropIndex.value] ?? null)
const baseScale = computed(() => {
  if (!frameSize.value.width || !frameSize.value.height || !imageSize.value.width || !imageSize.value.height) return 1
  return Math.max(frameSize.value.width / imageSize.value.width, frameSize.value.height / imageSize.value.height)
})
const renderedSize = computed(() => ({
  width: imageSize.value.width * baseScale.value * cropZoom.value,
  height: imageSize.value.height * baseScale.value * cropZoom.value,
}))
const cropImageStyle = computed(() => ({
  width: `${renderedSize.value.width}px`,
  height: `${renderedSize.value.height}px`,
  transform: `translate(${cropOffset.value.x}px, ${cropOffset.value.y}px)`,
}))

function emitImages(images: CharacterImage[], coverImageId: string) {
  emit('update', { images, coverImageId })
}

function openPicker() {
  uploadError.value = ''
  fileInput.value?.click()
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'))
    reader.onerror = () => reject(new Error(`读取图片失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

async function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/'))
  input.value = ''
  if (!files.length) return
  cropError.value = ''
  uploadError.value = ''
  resumeGalleryAfterCrop.value = galleryOpen.value
  cropQueue.value = files.map((file) => ({
    dataUrl: '',
    file,
    name: file.name.replace(/\.[^.]+$/, '') || '新图片',
  }))
  cropIndex.value = 0
  await showCurrentCrop()
}

async function showCurrentCrop() {
  const source = currentCrop.value
  if (!source) {
    cropOpen.value = false
    cropQueue.value = []
    galleryOpen.value = true
    return
  }
  cropName.value = source.name
  cropError.value = ''
  cropOpen.value = true
  if (!source.dataUrl && source.file) {
    try {
      source.dataUrl = await readFile(source.file)
    } catch (error) {
      if (currentCrop.value === source) {
        const message = error instanceof Error ? error.message : '读取图片失败'
        uploadError.value = message
        cropError.value = message
      }
      return
    }
  }
  if (currentCrop.value !== source) return
  await nextTick()
  try {
    await cropImage.value?.decode()
  } catch {
    cropError.value = '无法读取这张图片，请选择其他图片。'
    return
  }
  initializeCrop()
}

function initializeCrop() {
  const frame = cropFrame.value?.getBoundingClientRect()
  const image = cropImage.value
  if (!frame || !image?.naturalWidth || !image.naturalHeight) return
  frameSize.value = { width: frame.width, height: frame.height }
  imageSize.value = { width: image.naturalWidth, height: image.naturalHeight }
  cropZoom.value = 1
  cropOffset.value = {
    x: (frame.width - image.naturalWidth * baseScale.value) / 2,
    y: (frame.height - image.naturalHeight * baseScale.value) / 2,
  }
  constrainCrop()
}

function constrainCrop() {
  const width = renderedSize.value.width
  const height = renderedSize.value.height
  cropOffset.value = {
    x: Math.min(0, Math.max(frameSize.value.width - width, cropOffset.value.x)),
    y: Math.min(0, Math.max(frameSize.value.height - height, cropOffset.value.y)),
  }
}

function onZoomInput(event: Event) {
  const nextZoom = Number((event.target as HTMLInputElement).value)
  const oldWidth = renderedSize.value.width
  const oldHeight = renderedSize.value.height
  const anchorX = oldWidth ? (frameSize.value.width / 2 - cropOffset.value.x) / oldWidth : 0.5
  const anchorY = oldHeight ? (frameSize.value.height / 2 - cropOffset.value.y) / oldHeight : 0.5
  cropZoom.value = nextZoom
  cropOffset.value = {
    x: frameSize.value.width / 2 - anchorX * renderedSize.value.width,
    y: frameSize.value.height / 2 - anchorY * renderedSize.value.height,
  }
  constrainCrop()
}

function startCropDrag(event: PointerEvent) {
  if (event.button !== 0) return
  const frame = event.currentTarget as HTMLElement
  frame.setPointerCapture(event.pointerId)
  pointerDrag.value = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: cropOffset.value.x,
    offsetY: cropOffset.value.y,
  }
}

function moveCropDrag(event: PointerEvent) {
  const drag = pointerDrag.value
  if (!drag || drag.pointerId !== event.pointerId) return
  cropOffset.value = {
    x: drag.offsetX + event.clientX - drag.startX,
    y: drag.offsetY + event.clientY - drag.startY,
  }
  constrainCrop()
}

function stopCropDrag(event: PointerEvent) {
  if (pointerDrag.value?.pointerId !== event.pointerId) return
  pointerDrag.value = null
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `character-image-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function saveCurrentCrop() {
  const source = currentCrop.value
  const image = cropImage.value
  if (!source || !image || !frameSize.value.width || !renderedSize.value.width) return
  const canvas = document.createElement('canvas')
  canvas.width = 720
  canvas.height = 1280
  const context = canvas.getContext('2d')
  if (!context) {
    cropError.value = '浏览器无法处理图片，请重试。'
    return
  }
  const sx = Math.max(0, -cropOffset.value.x / renderedSize.value.width * image.naturalWidth)
  const sy = Math.max(0, -cropOffset.value.y / renderedSize.value.height * image.naturalHeight)
  const sw = Math.min(image.naturalWidth - sx, frameSize.value.width / renderedSize.value.width * image.naturalWidth)
  const sh = Math.min(image.naturalHeight - sy, frameSize.value.height / renderedSize.value.height * image.naturalHeight)
  try {
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
    const name = cropName.value.trim() || source.name || '角色形象'
    let images = [...props.images]
    let coverId = coverImage.value?.id ?? ''
    if (source.existingId) {
      images = images.map((entry) => entry.id === source.existingId ? { ...entry, name, dataUrl } : entry)
    } else {
      const created: CharacterImage = { id: createId(), name, dataUrl, createdAt: Date.now() }
      images.push(created)
      if (!coverId) coverId = created.id
    }
    emitImages(images, coverId)
    cropIndex.value += 1
    void showCurrentCrop()
  } catch {
    cropError.value = '图片处理失败，可能是图片尺寸过大。'
  }
}

function cancelCropQueue() {
  cropOpen.value = false
  cropQueue.value = []
  cropIndex.value = 0
  galleryOpen.value = resumeGalleryAfterCrop.value
}

function beginRecrop(image: CharacterImage) {
  resumeGalleryAfterCrop.value = true
  cropQueue.value = [{ dataUrl: image.dataUrl, name: image.name, existingId: image.id }]
  cropIndex.value = 0
  void showCurrentCrop()
}

function setCover(image: CharacterImage) {
  emitImages([...props.images], image.id)
}

function deleteImage(image: CharacterImage) {
  const images = props.images.filter((entry) => entry.id !== image.id)
  const coverId = props.coverImageId === image.id ? images[0]?.id ?? '' : props.coverImageId
  emitImages(images, coverId)
}

function imageCountLabel(count: number) {
  return `${count} 张图片`
}
</script>

<template>
  <section class="character-images">
    <div class="cover-preview" :class="{ 'cover-preview-empty': !coverImage }">
      <img v-if="coverImage" :src="coverImage.dataUrl" :alt="coverImage.name" />
      <div v-else class="cover-empty-content"><Images :size="28" /><span>暂无角色形象</span></div>
      <span v-if="coverImage" class="cover-aspect-label">9:16</span>
    </div>
    <div class="image-actions">
      <div class="image-heading"><strong>角色形象</strong><span>{{ imageCountLabel(props.images.length) }}</span></div>
      <div class="image-buttons">
        <button class="image-button image-button-primary" type="button" @click="openPicker"><ImagePlus :size="15" />添加图片</button>
        <button class="image-button" type="button" @click="galleryOpen = true"><Images :size="15" />管理图片</button>
      </div>
      <p v-if="uploadError" class="upload-error" role="alert">{{ uploadError }}</p>
    </div>
    <input ref="fileInput" class="visually-hidden" type="file" accept="image/*" multiple @change="onFilesSelected" />

    <Teleport to="body">
      <div v-if="galleryOpen" class="image-modal-backdrop" @click.self="galleryOpen = false">
        <section class="image-modal gallery-modal" role="dialog" aria-modal="true" aria-labelledby="gallery-title">
          <header class="modal-header">
            <div><span class="modal-eyebrow">角色资料</span><h2 id="gallery-title">管理角色图片</h2></div>
            <button class="modal-icon-button" type="button" title="关闭" aria-label="关闭" @click="galleryOpen = false"><X :size="18" /></button>
          </header>
          <div class="gallery-toolbar"><span>{{ imageCountLabel(props.images.length) }}</span><button class="image-button image-button-primary" type="button" @click="openPicker"><ImagePlus :size="15" />添加图片</button></div>
          <div v-if="props.images.length" class="gallery-grid">
            <article v-for="image in props.images" :key="image.id" class="gallery-item" :class="{ 'gallery-item-cover': coverImage?.id === image.id }">
              <div class="gallery-thumb"><img :src="image.dataUrl" :alt="image.name" /><span v-if="coverImage?.id === image.id" class="cover-badge"><Star :size="12" fill="currentColor" />封面</span></div>
              <div class="gallery-item-info"><strong :title="image.name">{{ image.name }}</strong><button v-if="coverImage?.id !== image.id" class="text-action" type="button" @click="setCover(image)"><Star :size="13" />设为封面</button><span v-else class="cover-current">当前封面</span></div>
              <div class="gallery-item-actions"><button class="image-button compact" type="button" @click="beginRecrop(image)"><Crop :size="14" />重新裁切</button><button class="modal-icon-button danger-action" type="button" title="删除图片" :aria-label="`删除${image.name}`" @click="deleteImage(image)"><Trash2 :size="15" /></button></div>
            </article>
          </div>
          <div v-else class="gallery-empty"><Images :size="30" /><strong>图片集为空</strong><span>添加角色形象后，可以在这里设定封面或重新裁切。</span><button class="image-button image-button-primary" type="button" @click="openPicker"><ImagePlus :size="15" />添加图片</button></div>
        </section>
      </div>

      <div v-if="cropOpen && currentCrop" class="image-modal-backdrop crop-backdrop" @click.self="cancelCropQueue">
        <section class="image-modal crop-modal" role="dialog" aria-modal="true" aria-labelledby="crop-title">
          <header class="modal-header">
            <div><span class="modal-eyebrow">{{ cropQueue.length > 1 ? `第 ${cropIndex + 1} / ${cropQueue.length} 张` : '9:16 角色形象' }}</span><h2 id="crop-title">{{ currentCrop.existingId ? '重新裁切图片' : '裁切角色图片' }}</h2></div>
            <button class="modal-icon-button" type="button" title="取消裁切" aria-label="取消裁切" @click="cancelCropQueue"><X :size="18" /></button>
          </header>
          <div class="crop-content">
            <div ref="cropFrame" class="crop-frame" @pointerdown="startCropDrag" @pointermove="moveCropDrag" @pointerup="stopCropDrag" @pointercancel="stopCropDrag" @lostpointercapture="stopCropDrag">
              <img ref="cropImage" :src="currentCrop.dataUrl" :style="cropImageStyle" alt="裁切预览" draggable="false" @load="initializeCrop" />
              <div class="crop-frame-guide"><span></span><span></span><span></span><span></span></div>
              <span class="crop-ratio">9:16</span>
            </div>
            <label class="crop-name-field"><span>图片名称</span><input v-model="cropName" maxlength="80" /></label>
            <label class="zoom-control"><span><ZoomIn :size="15" />缩放</span><input :value="cropZoom" type="range" min="1" max="3" step="0.01" @input="onZoomInput" /><output>{{ Math.round(cropZoom * 100) }}%</output></label>
            <div class="crop-hint"><Move :size="14" /><span>拖动图片调整构图</span></div>
            <p v-if="cropError" class="crop-error" role="alert">{{ cropError }}</p>
          </div>
          <footer class="modal-footer"><button class="image-button" type="button" @click="cancelCropQueue">取消</button><button class="image-button image-button-primary" type="button" @click="saveCurrentCrop"><Check :size="15" />{{ cropIndex + 1 < cropQueue.length ? '保存并裁切下一张' : '保存图片' }}</button></footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.character-images { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; color: var(--theme-font); }
  .cover-preview { position: relative; overflow: hidden; width: 100%; max-width: 220px; aspect-ratio: 9 / 16; border: 1px solid var(--theme-border); border-radius: 8px; background: var(--theme-secondary); }
.cover-preview > img { display: block; width: 100%; height: 100%; object-fit: cover; }
.cover-preview-empty { border-style: dashed; }
.cover-empty-content { display: flex; height: 100%; align-items: center; justify-content: center; flex-direction: column; gap: 7px; color: var(--theme-muted); font-size: 13px; }
.cover-aspect-label { position: absolute; right: 8px; bottom: 8px; padding: 3px 6px; border-radius: 4px; background: color-mix(in srgb, var(--theme-font) 78%, transparent); color: var(--theme-button-text); font-size: 11px; }
.image-actions { display: grid; gap: 8px; }
.image-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: var(--theme-font); font-size: 13px; }
.image-heading > span, .gallery-toolbar > span { color: var(--theme-muted); font-size: 12px; }
.image-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
.image-button, .modal-icon-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 31px; padding: 0 8px; border: 1px solid var(--theme-border); border-radius: 6px; background: var(--theme-surface-soft); color: var(--theme-font); font: inherit; font-size: 12px; cursor: pointer; }
.image-button:hover, .modal-icon-button:hover { border-color: var(--theme-button); background: var(--theme-hover); }
.image-button-primary { border-color: var(--theme-button); background: var(--theme-button); color: var(--theme-button-text); }
.image-button-primary:hover { border-color: var(--theme-button-hover); background: var(--theme-button-hover); }
.image-button.compact { min-height: 30px; padding-inline: 8px; font-size: 12px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }
.image-modal-backdrop { position: fixed; z-index: 5000; inset: 0; display: flex; align-items: center; justify-content: center; padding: 18px; background: var(--theme-overlay); }
.crop-backdrop { z-index: 5010; }
.image-modal { display: flex; width: min(900px, 100%); max-height: min(760px, 92vh); flex-direction: column; overflow: hidden; border: 1px solid var(--theme-border); border-radius: 8px; background: var(--theme-surface); box-shadow: 0 18px 60px color-mix(in srgb, var(--theme-font) 22%, transparent); color: var(--theme-font); }
.modal-header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 18px 20px; border-bottom: 1px solid var(--theme-border); }
.modal-eyebrow { color: var(--theme-muted); font-size: 11px; }
.modal-header h2 { margin: 3px 0 0; color: var(--theme-font); font-size: 18px; font-weight: 650; }
.modal-icon-button { width: 34px; min-width: 34px; padding: 0; }
.gallery-modal { width: min(880px, 100%); }
.gallery-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 20px; }
.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; overflow: auto; padding: 0 20px 20px; }
.gallery-item { min-width: 0; overflow: hidden; border: 1px solid var(--theme-border); border-radius: 7px; background: var(--theme-surface-soft); }
.gallery-item-cover { border-color: var(--theme-button); box-shadow: 0 0 0 1px var(--theme-button) inset; }
.gallery-thumb { position: relative; overflow: hidden; aspect-ratio: 9 / 16; background: var(--theme-secondary); }
.gallery-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.cover-badge { position: absolute; top: 7px; left: 7px; display: inline-flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 4px; background: var(--theme-button); color: var(--theme-button-text); font-size: 11px; }
.gallery-item-info { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 10px 5px; }
.gallery-item-info strong { min-width: 0; overflow: hidden; color: var(--theme-font); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.text-action, .cover-current { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--theme-button); font: inherit; font-size: 11px; cursor: pointer; }
.cover-current { color: var(--theme-muted); cursor: default; }
.gallery-item-actions { display: flex; align-items: center; justify-content: space-between; padding: 5px 10px 10px; }
.danger-action { color: var(--theme-danger); }
.gallery-empty { display: flex; min-height: 260px; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 24px; color: var(--theme-muted); text-align: center; }
.gallery-empty strong { color: var(--theme-font); font-size: 15px; }
.gallery-empty > span { max-width: 330px; font-size: 12px; }
.crop-modal { width: min(820px, 100%); }
.crop-content { overflow: auto; padding: 18px 20px 10px; }
.crop-frame { position: relative; overflow: hidden; width: min(100%, 27vh); aspect-ratio: 9 / 16; margin: 0 auto; background: color-mix(in srgb, var(--theme-secondary) 58%, var(--theme-font)); cursor: grab; touch-action: none; user-select: none; }
.crop-frame:active { cursor: grabbing; }
.crop-frame > img { position: absolute; top: 0; left: 0; max-width: none; pointer-events: none; user-select: none; }
.crop-frame-guide { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); pointer-events: none; }
.crop-frame-guide > span { border-right: 1px solid color-mix(in srgb, var(--theme-button-text) 42%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--theme-button-text) 42%, transparent); }
.crop-frame-guide > span:nth-child(3n) { border-right: 0; }
.crop-frame-guide > span:nth-child(n + 7) { border-bottom: 0; }
.crop-ratio { position: absolute; right: 8px; bottom: 8px; padding: 3px 6px; border-radius: 4px; background: color-mix(in srgb, var(--theme-font) 72%, transparent); color: var(--theme-button-text); font-size: 11px; }
.crop-name-field { display: grid; gap: 5px; margin-top: 14px; color: var(--theme-muted); font-size: 12px; }
.crop-name-field input { width: 100%; box-sizing: border-box; min-height: 36px; padding: 7px 10px; border: 1px solid var(--theme-border); border-radius: 6px; outline-color: var(--theme-button); background: var(--theme-surface-soft); color: var(--theme-font); font: inherit; font-size: 13px; }
.zoom-control { display: grid; grid-template-columns: 70px minmax(0, 1fr) 48px; align-items: center; gap: 10px; margin-top: 13px; color: var(--theme-muted); font-size: 12px; }
.zoom-control > span { display: inline-flex; align-items: center; gap: 5px; }
.zoom-control input { width: 100%; accent-color: var(--theme-button); }
.zoom-control output { color: var(--theme-muted); text-align: right; }
.crop-hint { display: flex; align-items: center; gap: 6px; margin-top: 9px; color: var(--theme-muted); font-size: 11px; }
.crop-error { margin: 8px 0 0; color: var(--theme-danger); font-size: 12px; }
.upload-error { margin: 0; color: var(--theme-danger); font-size: 11px; }
.modal-footer { display: flex; flex: 0 0 auto; justify-content: flex-end; gap: 8px; padding: 13px 20px 17px; border-top: 1px solid var(--theme-border); }

/* Keep the image gallery and crop dialogs in the active application palette. */
:global(html[data-theme-mode] .cover-preview){
  border-color: var(--theme-border);
  background: var(--theme-surface-soft);
}
:global(html[data-theme-mode] .cover-empty-content),
:global(html[data-theme-mode] .gallery-empty),
:global(html[data-theme-mode] .gallery-toolbar > span),
:global(html[data-theme-mode] .image-heading > span){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .cover-aspect-label),
:global(html[data-theme-mode] .crop-ratio){
  color: var(--theme-button-text);
  background: color-mix(in srgb, var(--theme-font) 78%, transparent);
}
:global(html[data-theme-mode] .image-heading),
:global(html[data-theme-mode] .image-modal){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .image-button),
:global(html[data-theme-mode] .modal-icon-button){
  color: var(--theme-font);
  border-color: var(--theme-border);
  background: var(--theme-surface-soft);
}
:global(html[data-theme-mode] .image-button:hover),
:global(html[data-theme-mode] .modal-icon-button:hover){
  color: var(--theme-font);
  border-color: var(--theme-button);
  background: var(--theme-hover);
}
:global(html[data-theme-mode] .image-button-primary),
:global(html[data-theme-mode] .cover-badge){
  color: var(--theme-button-text);
  border-color: var(--theme-button);
  background: var(--theme-button);
}
:global(html[data-theme-mode] .image-button-primary:hover){
  color: var(--theme-button-text);
  border-color: var(--theme-button-hover);
  background: var(--theme-button-hover);
}
:global(html[data-theme-mode] .image-modal-backdrop){
  background: var(--theme-overlay);
}
:global(html[data-theme-mode] .image-modal){
  border-color: var(--theme-border);
  background: var(--theme-surface);
  box-shadow: 0 18px 60px color-mix(in srgb, var(--theme-font) 22%, transparent);
}
:global(html[data-theme-mode] .modal-header),
:global(html[data-theme-mode] .modal-footer){
  border-color: var(--theme-border);
}
:global(html[data-theme-mode] .modal-eyebrow),
:global(html[data-theme-mode] .cover-current),
:global(html[data-theme-mode] .crop-hint){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .modal-header h2),
:global(html[data-theme-mode] .gallery-item-info strong),
:global(html[data-theme-mode] .gallery-empty strong){
  color: var(--theme-font);
}
:global(html[data-theme-mode] .gallery-item){
  border-color: var(--theme-border);
  background: var(--theme-surface-soft);
}
:global(html[data-theme-mode] .gallery-item-cover){
  border-color: var(--theme-button);
  box-shadow: 0 0 0 1px var(--theme-button) inset;
}
:global(html[data-theme-mode] .gallery-thumb){
  background: var(--theme-secondary);
}
:global(html[data-theme-mode] .text-action){
  color: var(--theme-button);
}
:global(html[data-theme-mode] .text-action:hover){
  color: var(--theme-button-hover);
}
:global(html[data-theme-mode] .danger-action),
:global(html[data-theme-mode] .crop-error),
:global(html[data-theme-mode] .upload-error){
  color: color-mix(in srgb, var(--theme-button) 62%, var(--theme-font));
}
:global(html[data-theme-mode] .crop-frame){
  background: color-mix(in srgb, var(--theme-secondary) 58%, var(--theme-font));
}
:global(html[data-theme-mode] .crop-frame-guide > span){
  border-color: color-mix(in srgb, var(--theme-button-text) 42%, transparent);
}
:global(html[data-theme-mode] .crop-name-field),
:global(html[data-theme-mode] .zoom-control),
:global(html[data-theme-mode] .zoom-control output){
  color: var(--theme-muted);
}
:global(html[data-theme-mode] .crop-name-field input){
  color: var(--theme-font);
  border-color: var(--theme-border);
  outline-color: var(--theme-button);
  background: var(--theme-input-bg);
}
:global(html[data-theme-mode] .zoom-control input){
  accent-color: var(--theme-button);
}
:global(html[data-theme-mode] .image-button:focus-visible),
:global(html[data-theme-mode] .modal-icon-button:focus-visible),
:global(html[data-theme-mode] .text-action:focus-visible),
:global(html[data-theme-mode] .crop-name-field input:focus-visible){
  outline: 2px solid var(--theme-button);
  outline-offset: 2px;
}

@media (min-width: 680px) {
  .character-images { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 520px) {
  .image-modal-backdrop { padding: 9px; }
  .modal-header { padding: 14px; }
  .gallery-toolbar { padding: 10px 14px; }
  .gallery-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; padding: 0 14px 14px; }
  .crop-content { padding: 12px 14px 8px; }
  .modal-footer { padding: 11px 14px 14px; }
}
</style>

