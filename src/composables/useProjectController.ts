import { computed, type Ref } from 'vue'

/**
 * The project controller deliberately knows only about the project registry and
 * lifecycle callbacks.  Snapshot creation, .qy I/O and the renderer's working
 * state stay in App.vue (or another host), which keeps this composable safe to
 * reuse from the desktop and browser shells.
 */
export type ProjectRecordLike = {
  id: string
  title: string
  createdAt?: number
  updatedAt: number
  snapshot: unknown
}

export type ProjectPersistOptions = {
  allowProjectDeletion?: boolean
}

export type ProjectSaveGuardAction = () => void | Promise<void>

export type ProjectControllerOptions<TProject extends ProjectRecordLike> = {
  projects: Ref<TProject[]>
  currentProjectId: Ref<string>
  currentWorkTitle: Ref<string>
  projectMenuOpen: Ref<boolean>
  projectDeleteOpen: Ref<boolean>
  projectRenameOpen: Ref<boolean>
  renameTitle: Ref<string>

  /** Ask the host to save/discard/cancel before a destructive project action. */
  withSaveGuard: (reason: string, action?: ProjectSaveGuardAction) => boolean | Promise<boolean>
  /** Capture the active renderer state into its registry record. */
  syncCurrentProjectRecord: () => void
  /** Restore a registry record into the renderer's working state. */
  restoreProjectRecord: (project: TProject) => void
  /** Build a blank project record without touching the active project. */
  createBlankProjectRecord: (title: string) => TProject
  /** Return a unique title for a new project. */
  nextProjectTitle: (base?: string) => string
  /** Persist the registry/profile after a successful operation. */
  persist: (options?: ProjectPersistOptions) => void | Promise<void>
  /** Clear transient UI and Agent state after a project has been restored. */
  resetAfterProjectChange?: (reason: 'switch' | 'create' | 'delete') => void | Promise<void>
}

export type ProjectController<TProject extends ProjectRecordLike> = ReturnType<typeof useProjectController<TProject>>

export function useProjectController<TProject extends ProjectRecordLike>(options: ProjectControllerOptions<TProject>) {
  const {
    projects,
    currentProjectId,
    currentWorkTitle,
    projectMenuOpen,
    projectDeleteOpen,
    projectRenameOpen,
    renameTitle,
  } = options

  const currentProject = computed(() => projects.value.find((project) => project.id === currentProjectId.value))

  function toggleProjectMenu() {
    projectMenuOpen.value = !projectMenuOpen.value
  }

  function closeProjectMenu() {
    projectMenuOpen.value = false
  }

  function closeProjectMenuOnOutside(event: Event) {
    if (!projectMenuOpen.value) return
    const target = event.target
    if (target instanceof Element && target.closest('.project-selector')) return
    projectMenuOpen.value = false
  }

  function closeProjectOverlays() {
    projectMenuOpen.value = false
    projectDeleteOpen.value = false
    projectRenameOpen.value = false
  }

  async function switchProject(id: string): Promise<boolean> {
    if (id === currentProjectId.value) {
      closeProjectMenu()
      return true
    }
    const target = projects.value.find((project) => project.id === id)
    if (!target) return false

    return Boolean(await options.withSaveGuard('切换作品', async () => {
      options.syncCurrentProjectRecord()
      options.restoreProjectRecord(target)
      await options.resetAfterProjectChange?.('switch')
      closeProjectOverlays()
      await options.persist()
    }))
  }

  async function createNewProject(): Promise<boolean> {
    return Boolean(await options.withSaveGuard('新建作品', async () => {
      options.syncCurrentProjectRecord()
      const project = options.createBlankProjectRecord(options.nextProjectTitle())
      projects.value.unshift(project)
      options.restoreProjectRecord(project)
      await options.resetAfterProjectChange?.('create')
      closeProjectOverlays()
      await options.persist()
    }))
  }

  function requestDeleteProject() {
    closeProjectMenu()
    projectDeleteOpen.value = true
  }

  function requestRenameProject() {
    renameTitle.value = currentWorkTitle.value
    closeProjectMenu()
    projectRenameOpen.value = true
  }

  function cancelRenameProject() {
    projectRenameOpen.value = false
  }

  async function confirmRenameProject(): Promise<boolean> {
    const nextTitle = renameTitle.value.trim()
    if (!nextTitle) return false
    currentWorkTitle.value = nextTitle
    options.syncCurrentProjectRecord()
    projectRenameOpen.value = false
    await options.persist()
    return true
  }

  function cancelDeleteProject() {
    projectDeleteOpen.value = false
  }

  async function confirmDeleteProject(): Promise<boolean> {
    if (!currentProjectId.value) return false
    return Boolean(await options.withSaveGuard('删除当前作品', async () => {
      const remaining = projects.value.filter((project) => project.id !== currentProjectId.value)
      if (!remaining.length) remaining.push(options.createBlankProjectRecord(''))
      projects.value = remaining
      projectDeleteOpen.value = false
      const target = remaining[0]
      if (!target) return
      options.restoreProjectRecord(target)
      await options.resetAfterProjectChange?.('delete')
      closeProjectMenu()
      await options.persist({ allowProjectDeletion: true })
    }))
  }

  return {
    currentProject,
    toggleProjectMenu,
    closeProjectMenu,
    closeProjectMenuOnOutside,
    switchProject,
    createNewProject,
    requestDeleteProject,
    requestRenameProject,
    cancelRenameProject,
    confirmRenameProject,
    cancelDeleteProject,
    confirmDeleteProject,
  }
}
