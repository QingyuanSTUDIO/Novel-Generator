import { computed, onMounted, onScopeDispose, ref, type Ref } from 'vue'

export type AgentFabViewport = {
  width: number
  height: number
}

export type AgentFabPosition = {
  x: number
  y: number
}

export type UseAgentFabOptions = {
  /**
   * The drawer open state lives in App.vue because the same state is used by
   * the full-page Agent route. The composable only owns the floating surface
   * mechanics.
   */
  open: Ref<boolean>
  /**
   * Called when the floating drawer is closed while the Agent page is active.
   * App.vue can use this to switch back to the writer route.
   */
  onClose?: () => void
  initialPosition?: AgentFabPosition
}

const FAB_SIZE = 58
const FAB_MIN_OFFSET = 8

function currentViewport(): AgentFabViewport {
  if (typeof window === 'undefined') return { width: 1280, height: 720 }
  return { width: window.innerWidth, height: window.innerHeight }
}

/**
 * Floating Agent button and drawer geometry.
 *
 * This deliberately contains no application/store/API dependencies. It can
 * therefore be removed from App.vue without changing Agent request handling,
 * persistence, or the page router. The returned refs keep the existing
 * template names (`viewport`, `agentPosition`, `agentFabStyle`, etc.) so the
 * first extraction can be wired with a small import-only change.
 */
export function useAgentFab(options: UseAgentFabOptions) {
  const viewport = ref<AgentFabViewport>(currentViewport())
  const agentPosition = ref<AgentFabPosition>(
    options.initialPosition ?? {
      x: Math.max(16, viewport.value.width - 74),
      y: Math.max(16, viewport.value.height - 74),
    },
  )
  const agentDragging = ref(false)
  const agentDragOffset = ref<AgentFabPosition>({ x: 0, y: 0 })
  const suppressAgentClick = ref(false)
  let agentPointerId: number | null = null

  function clampAgentPosition(x: number, y: number): AgentFabPosition {
    return {
      x: Math.max(FAB_MIN_OFFSET, Math.min(x, Math.max(FAB_MIN_OFFSET, viewport.value.width - FAB_SIZE))),
      y: Math.max(FAB_MIN_OFFSET, Math.min(y, Math.max(FAB_MIN_OFFSET, viewport.value.height - FAB_SIZE))),
    }
  }

  function updateViewport() {
    viewport.value = currentViewport()
    agentPosition.value = clampAgentPosition(agentPosition.value.x, agentPosition.value.y)
  }

  function moveAgentDrag(event: PointerEvent) {
    if (!agentDragging.value || event.pointerId !== agentPointerId) return
    const nextX = event.clientX - agentDragOffset.value.x
    const nextY = event.clientY - agentDragOffset.value.y
    if (Math.abs(nextX - agentPosition.value.x) > 3 || Math.abs(nextY - agentPosition.value.y) > 3) {
      suppressAgentClick.value = true
    }
    agentPosition.value = clampAgentPosition(nextX, nextY)
  }

  function endAgentDrag(event: PointerEvent) {
    if (agentPointerId !== null && event.pointerId !== agentPointerId) return
    agentDragging.value = false
    agentPointerId = null
    window.removeEventListener('pointermove', moveAgentDrag)
    window.removeEventListener('pointerup', endAgentDrag)
    window.removeEventListener('pointercancel', endAgentDrag)
    if (suppressAgentClick.value) window.setTimeout(() => { suppressAgentClick.value = false }, 0)
  }

  function startAgentDrag(event: PointerEvent) {
    if (event.button !== 0) return
    agentPointerId = event.pointerId
    agentDragging.value = true
    suppressAgentClick.value = false
    agentDragOffset.value = {
      x: event.clientX - agentPosition.value.x,
      y: event.clientY - agentPosition.value.y,
    }
    window.addEventListener('pointermove', moveAgentDrag)
    window.addEventListener('pointerup', endAgentDrag)
    window.addEventListener('pointercancel', endAgentDrag)
    event.preventDefault()
  }

  function toggleAgentSurface() {
    if (suppressAgentClick.value) return
    options.open.value = !options.open.value
  }

  function closeAgentSurface() {
    options.open.value = false
    options.onClose?.()
  }

  const agentFabStyle = computed(() => ({
    left: `${agentPosition.value.x}px`,
    top: `${agentPosition.value.y}px`,
  }))

  const agentDrawerStyle = computed(() => {
    const width = Math.min(900, Math.max(280, viewport.value.width - 40))
    const height = Math.min(760, Math.max(360, viewport.value.height - 40))
    const maxLeft = Math.max(10, viewport.value.width - width - 10)
    const maxTop = Math.max(10, viewport.value.height - height - 10)
    let left = agentPosition.value.x - width + 50
    let top = agentPosition.value.y - height - 12
    if (left < 10) left = Math.min(agentPosition.value.x, maxLeft)
    if (top < 10) top = Math.min(agentPosition.value.y + 60, maxTop)
    return {
      left: `${Math.max(10, Math.min(left, maxLeft))}px`,
      top: `${Math.max(10, Math.min(top, maxTop))}px`,
    }
  })

  function disposePointerListeners() {
    window.removeEventListener('pointermove', moveAgentDrag)
    window.removeEventListener('pointerup', endAgentDrag)
    window.removeEventListener('pointercancel', endAgentDrag)
    agentPointerId = null
    agentDragging.value = false
  }

  onMounted(() => window.addEventListener('resize', updateViewport))
  if (typeof window !== 'undefined') {
    onScopeDispose(() => {
      window.removeEventListener('resize', updateViewport)
      disposePointerListeners()
    })
  }

  return {
    viewport,
    agentPosition,
    agentDragging,
    agentFabStyle,
    agentDrawerStyle,
    clampAgentPosition,
    updateViewport,
    startAgentDrag,
    moveAgentDrag,
    endAgentDrag,
    toggleAgentSurface,
    closeAgentSurface,
  }
}
