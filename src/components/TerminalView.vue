<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRefs, watch } from 'vue'
import { Plus, RefreshCw, Square, Terminal as TerminalIcon } from 'lucide-vue-next'
import { Terminal } from '@xterm/xterm'
import type { IDisposable, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../console/console.css'
import type { TerminalEvent, TerminalSession } from '../console/types'
import { terminalUi } from '../console/uiState'

const props = withDefaults(defineProps<{ visible?: boolean }>(), { visible: true })
const sessions = ref<TerminalSession[]>([])
const { activeId, selectedShell } = toRefs(terminalUi)
const loading = ref(true)
const creating = ref(false)
const stopping = ref('')
const error = ref('')
const available = ref(false)
const activeSession = computed(() => sessions.value.find((session) => session.id === activeId.value))
const sessionErrors = ref<Record<string, string>>({})

type Controller = {
  terminal: Terminal
  fit: FitAddon
  host: HTMLElement
  observer: ResizeObserver
  disposables: IDisposable[]
  loading: boolean
  events: TerminalEvent[]
  queuedSequence: number
  parsedSequence: number
  disposed: boolean
  frame?: number
}

const controllers = new Map<string, Controller>()
const earlyEvents = new Map<string, TerminalEvent[]>()
const statusRevisions = new Map<string, number>()
let bridge: Window['desktopTerminal']
let unsubscribe: (() => void) | undefined
let themeObserver: MutationObserver | undefined
let colorProbe: HTMLElement | undefined
let colorCanvas: CanvasRenderingContext2D | null = null
let disposed = false
let listing: Promise<void> | undefined

const shellLabels: Record<TerminalSession['shell'], string> = {
  powershell: 'PowerShell',
  cmd: '命令提示符',
  codex: 'Codex CLI',
}
const statusLabels: Record<TerminalSession['status'], string> = {
  starting: '启动中', running: '运行中', exited: '已退出', error: '异常',
}

function failureText(failure: unknown) {
  return failure instanceof Error ? failure.message : '终端操作失败。'
}

function setSessionError(id: string, failure: unknown) {
  if (!disposed && sessions.value.some((session) => session.id === id)) {
    sessionErrors.value = { ...sessionErrors.value, [id]: failureText(failure) }
  }
}

// xterm accepts concrete colors. Resolve every color through the live app
// tokens, including color-mix(), instead of maintaining another palette.
function tokenColor(token: string): string {
  if (!colorProbe) return ''
  colorProbe.style.color = `var(${token}, var(--theme-font))`
  const color = getComputedStyle(colorProbe).color
  if (!colorCanvas) return color
  colorCanvas.clearRect(0, 0, 1, 1)
  colorCanvas.fillStyle = color
  colorCanvas.fillRect(0, 0, 1, 1)
  const [r, g, b, alpha] = colorCanvas.getImageData(0, 0, 1, 1).data
  return `rgba(${r}, ${g}, ${b}, ${alpha / 255})`
}

function terminalTheme(): ITheme {
  const background = tokenColor('--theme-workspace')
  const foreground = tokenColor('--theme-font')
  const muted = tokenColor('--theme-muted')
  const accent = tokenColor('--theme-button')
  const danger = tokenColor('--theme-danger')
  const success = tokenColor('--theme-success')
  const warning = tokenColor('--theme-warning')
  const info = tokenColor('--theme-info')
  return {
    background, foreground, cursor: accent, cursorAccent: background,
    selectionBackground: tokenColor('--theme-secondary'),
    selectionForeground: foreground,
    black: muted, brightBlack: muted, white: foreground, brightWhite: foreground,
    red: danger, brightRed: danger, green: success, brightGreen: success,
    yellow: warning, brightYellow: warning, blue: info, brightBlue: info,
    magenta: accent, brightMagenta: accent, cyan: info, brightCyan: info,
  }
}

function applyTheme() {
  const theme = terminalTheme()
  for (const controller of controllers.values()) controller.terminal.options.theme = { ...theme }
}

function scheduleFit(id: string) {
  const controller = controllers.get(id)
  if (!controller || controller.disposed || controller.frame !== undefined) return
  controller.frame = requestAnimationFrame(() => {
    controller.frame = undefined
    if (disposed || !props.visible || activeId.value !== id) return
    if (controller.host.clientWidth < 1 || controller.host.clientHeight < 1) return
    try { controller.fit.fit() } catch (failure) { setSessionError(id, failure) }
  })
}

function acknowledge(id: string, controller: Controller, sequence: number) {
  if (disposed || controller.disposed || sequence < controller.parsedSequence) return
  controller.parsedSequence = sequence
  try {
    void Promise.resolve(bridge?.ack({ sessionId: id, sequence })).catch((failure) => setSessionError(id, failure))
  } catch (failure) { setSessionError(id, failure) }
}

function updateSession(event: TerminalEvent) {
  const session = sessions.value.find((candidate) => candidate.id === event.sessionId)
  if (!session) return
  if (event.type === 'exit') {
    session.status = event.error || session.status === 'error' ? 'error' : 'exited'
    session.exitCode = event.exitCode
  } else if (event.type === 'status') {
    const status = (event as TerminalEvent & { status?: TerminalSession['status'] }).status
    if (status && ['starting', 'running', 'exited', 'error'].includes(status)) session.status = status
  }
  if (event.error) session.error = event.error
}

function writeEvent(id: string, controller: Controller, event: TerminalEvent) {
  if (controller.disposed || event.type !== 'data' || typeof event.data !== 'string') return
  const sequence = event.sequence
  if (!Number.isSafeInteger(sequence) || sequence! <= controller.queuedSequence) return
  if (controller.loading) {
    controller.events.push(event)
    return
  }
  if (sequence! > controller.queuedSequence + 1) {
    controller.loading = true
    controller.events.push(event)
    void replaySnapshot(id, controller, true)
    return
  }
  controller.queuedSequence = sequence!
  controller.terminal.write(event.data, () => acknowledge(id, controller, sequence!))
}

function receiveEvent(event: TerminalEvent) {
  if (disposed) return
  if (event.type !== 'data') statusRevisions.set(event.sessionId, (statusRevisions.get(event.sessionId) ?? 0) + 1)
  updateSession(event)
  const controller = controllers.get(event.sessionId)
  if (!controller) {
    const pending = earlyEvents.get(event.sessionId) ?? []
    pending.push(event)
    earlyEvents.set(event.sessionId, pending)
    return
  }
  if (controller.loading) controller.events.push(event)
  else writeEvent(event.sessionId, controller, event)
}

async function replaySnapshot(id: string, controller: Controller, reset = false) {
  if (!bridge || disposed || controller.disposed) return
  const statusRevision = statusRevisions.get(id) ?? 0
  try {
    // Events are already subscribed and buffered. Replay the snapshot first,
    // then only deltas newer than its watermark to avoid duplicating output.
    const snapshot = await bridge.snapshot(id)
    if (disposed || controller.disposed) return
    const sessionIndex = sessions.value.findIndex((session) => session.id === id)
    if (sessionIndex >= 0 && statusRevision === (statusRevisions.get(id) ?? 0)) {
      sessions.value[sessionIndex] = snapshot.session
    }
    controller.queuedSequence = snapshot.sequence
    if (reset) {
      // reset() leaves xterm's asynchronous write queue intact. Drain the old
      // writes first so they cannot reappear before the snapshot is replayed.
      await new Promise<void>((resolve) => controller.terminal.write('', resolve))
      if (disposed || controller.disposed) return
      controller.terminal.reset()
    }
    await new Promise<void>((resolve) => {
      controller.terminal.write(snapshot.output, () => {
        acknowledge(id, controller, snapshot.sequence)
        resolve()
      })
    })
    if (disposed || controller.disposed) return
    controller.loading = false
    const events = controller.events.splice(0)
    // receiveEvent already applies status updates. Replaying old status events
    // here would overwrite the fresher snapshot or a subsequent exit event.
    for (const event of events.filter((event) => event.type === 'data').sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
      writeEvent(id, controller, event)
    }
    scheduleFit(id)
  } catch (failure) {
    controller.loading = false
    setSessionError(id, failure)
  }
}

async function attachHost(id: string, element: unknown) {
  if (!(element instanceof HTMLElement) || disposed || !bridge || controllers.has(id)) return
  const terminal = new Terminal({
    theme: terminalTheme(),
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    windowOptions: {},
    linkHandler: { activate(event) { event.preventDefault() } },
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  const controller: Controller = {
    terminal, fit, host: element, loading: true, disposed: false,
    events: earlyEvents.get(id) ?? [], queuedSequence: 0, parsedSequence: 0,
    observer: new ResizeObserver(() => scheduleFit(id)),
    disposables: [],
  }
  earlyEvents.delete(id)
  controllers.set(id, controller)
  terminal.open(element)
  // Terminal output never grants clipboard access or automatic link opening.
  controller.disposables.push(terminal.parser.registerOscHandler(52, () => true))
  controller.disposables.push(terminal.parser.registerOscHandler(8, () => true))
  controller.disposables.push(terminal.onData((data) => {
    if (controller.loading || disposed) return
    void bridge!.write({ sessionId: id, data }).catch((failure) => setSessionError(id, failure))
  }))
  controller.disposables.push(terminal.onBinary((data) => {
    if (controller.loading || disposed) return
    void bridge!.write({ sessionId: id, data, binary: true }).catch((failure) => setSessionError(id, failure))
  }))
  controller.disposables.push(terminal.onResize(({ cols, rows }) => {
    if (disposed) return
    void bridge!.resize({ sessionId: id, cols, rows }).catch((failure) => setSessionError(id, failure))
  }))
  controller.observer.observe(element)
  await replaySnapshot(id, controller)
}

function disposeController(id: string) {
  const controller = controllers.get(id)
  if (!controller) return
  controller.disposed = true
  if (controller.frame !== undefined) cancelAnimationFrame(controller.frame)
  controller.observer.disconnect()
  for (const disposable of controller.disposables) disposable.dispose()
  controller.terminal.dispose()
  controllers.delete(id)
  earlyEvents.delete(id)
  statusRevisions.delete(id)
  if (sessionErrors.value[id]) {
    const next = { ...sessionErrors.value }
    delete next[id]
    sessionErrors.value = next
  }
}

async function refreshSessions() {
  if (!bridge || disposed) return
  if (listing) return listing
  listing = (async () => {
    error.value = ''
    try {
      const revisions = new Map(statusRevisions)
      const next = await bridge!.list()
      if (disposed) return
      const previous = new Map(sessions.value.map((session) => [session.id, session]))
      sessions.value = next.map((session) => {
        const current = previous.get(session.id)
        return current && (revisions.get(session.id) ?? 0) !== (statusRevisions.get(session.id) ?? 0)
          ? { ...session, status: current.status, exitCode: current.exitCode, error: current.error }
          : session
      })
      const retained = new Set(next.map((session) => session.id))
      for (const id of controllers.keys()) if (!retained.has(id)) disposeController(id)
      for (const id of earlyEvents.keys()) if (!retained.has(id)) earlyEvents.delete(id)
      if (!retained.has(activeId.value)) activeId.value = next[next.length - 1]?.id ?? ''
      await nextTick()
      scheduleFit(activeId.value)
    } catch (failure) {
      if (!disposed) error.value = failureText(failure)
    } finally {
      loading.value = false
    }
  })()
  try { await listing } finally { listing = undefined }
}

async function createTerminal() {
  if (!bridge || creating.value || disposed) return
  creating.value = true
  error.value = ''
  const originalActiveId = activeId.value
  try {
    // Mount/list never start a process. Creation requires this explicit click.
    const session = await bridge.create({ shell: selectedShell.value })
    if (disposed) return
    sessions.value = [...sessions.value.filter((current) => current.id !== session.id), session]
    const selectNewSession = activeId.value === originalActiveId
    if (selectNewSession) activeId.value = session.id
    await refreshSessions()
    await nextTick()
    if (selectNewSession && !disposed && props.visible && activeId.value === session.id) controllers.get(session.id)?.terminal.focus()
  } catch (failure) {
    if (!disposed) {
      // Main retains the failed session with its error. Expose it immediately
      // instead of requiring a second, manual list refresh.
      await refreshSessions()
      if (!disposed) error.value = failureText(failure)
    }
  } finally {
    creating.value = false
  }
}

async function stopTerminal(id: string) {
  if (!bridge || stopping.value) return
  stopping.value = id
  try {
    await bridge.stop(id)
    await refreshSessions()
  } catch (failure) { setSessionError(id, failure) } finally { stopping.value = '' }
}

async function selectSession(id: string) {
  activeId.value = id
  await nextTick()
  scheduleFit(id)
  if (!disposed && props.visible && activeId.value === id) controllers.get(id)?.terminal.focus()
}

watch(() => props.visible, async (visible) => {
  if (!visible) return
  await nextTick()
  scheduleFit(activeId.value)
})

onMounted(async () => {
  bridge = window.desktopTerminal
  available.value = Boolean(bridge)
  if (!bridge) { loading.value = false; return }
  colorProbe = document.createElement('span')
  colorProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'
  document.body.append(colorProbe)
  colorCanvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme-mode', 'class'] })
  unsubscribe = bridge.onEvent(receiveEvent)
  await refreshSessions()
})

onBeforeUnmount(() => {
  disposed = true
  unsubscribe?.()
  themeObserver?.disconnect()
  colorProbe?.remove()
  for (const id of controllers.keys()) disposeController(id)
  earlyEvents.clear()
  // This is view disposal only. Shells remain alive in the desktop backend.
})
</script>

<template>
  <section class="console-terminal-view">
    <header class="console-terminal-toolbar">
      <div class="console-terminal-tabs" aria-label="终端会话">
        <button v-for="session in sessions" :key="session.id" type="button" :class="['console-terminal-session', { selected: session.id === activeId }]" :aria-pressed="session.id === activeId" @click="selectSession(session.id)">
          <TerminalIcon :size="13" /><span>{{ session.title }}</span><small :class="`console-terminal-status-${session.status}`">{{ statusLabels[session.status] }}</small>
        </button>
      </div>
      <div class="console-terminal-actions">
        <select v-model="selectedShell" aria-label="新终端类型" :disabled="!available || creating">
          <option v-for="(label, shell) in shellLabels" :key="shell" :value="shell">{{ label }}</option>
        </select>
        <button class="console-button" type="button" :disabled="!available || creating" @click="createTerminal"><Plus :size="14" />{{ creating ? '启动中' : '新终端' }}</button>
        <button class="console-icon-button" type="button" title="刷新终端会话" aria-label="刷新终端会话" :disabled="!available || loading" @click="refreshSessions"><RefreshCw :size="14" /></button>
        <button v-if="activeSession && ['starting', 'running'].includes(activeSession.status)" class="console-icon-button console-danger-button" type="button" title="停止当前终端进程" aria-label="停止当前终端进程" :disabled="Boolean(stopping)" @click="stopTerminal(activeSession.id)"><Square :size="13" /></button>
      </div>
    </header>
    <div v-if="error" class="console-error" role="alert">{{ error }}</div>
    <div v-if="!available" class="console-empty"><TerminalIcon :size="27" /><strong>终端需要桌面环境</strong><span>请通过桌面程序打开控制台。</span></div>
    <div v-else-if="loading && !sessions.length" class="console-empty">正在读取终端会话…</div>
    <div v-else-if="!sessions.length" class="console-empty"><TerminalIcon :size="27" /><strong>尚未打开终端</strong><span>选择 PowerShell、命令提示符或 Codex CLI，然后点击“新终端”。</span></div>
    <div v-else class="console-terminal-hosts">
      <div v-for="session in sessions" v-show="session.id === activeId" :key="session.id" class="console-terminal-pane">
        <div v-if="sessionErrors[session.id] || session.error" class="console-error" role="alert">{{ sessionErrors[session.id] || session.error }}</div>
        <div :ref="(element) => { void attachHost(session.id, element) }" class="console-xterm-host" />
      </div>
    </div>
    <footer v-if="activeSession" class="console-terminal-footer">
      <span :title="activeSession.cwd">{{ activeSession.cwd }}</span><span v-if="activeSession.exitCode !== undefined">退出码 {{ activeSession.exitCode }}</span><span>{{ statusLabels[activeSession.status] }}</span>
    </footer>
  </section>
</template>
