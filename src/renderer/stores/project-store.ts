import { toast } from 'sonner'
import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { writeActiveProject } from '@/lib/active-project'
import { unmountCanvases } from '@/lib/canvas-unmount-flow'
import { logFrontendError } from '@/lib/log-api'
import { clientFieldsOf, forgetProjectPrefs, rememberProjectPrefs } from '@/lib/project-prefs'
import {
  type CascadeOptions,
  ProjectBusyError,
  projectRegistryApi
} from '@/lib/project-registry-api'
import { clearChatRoute } from '@/lib/router-navigate'
import { randomUUID } from '@/lib/uuid'
import type { EnvVariable, Project, ProjectColor, ProjectGroup, Worktree } from '@/types/project'
import { useProjectBusyStore } from './project-busy-store'

/** How long a new project may take to come back through the `projects` watch before it is selected anyway. */
const LISTED_TIMEOUT_MS = 5000

/**
 * What `updateProject` takes. The registry owns `isArchived` and `isDefault`
 * (changed only by their own commands); `name`, `color` and `path` go to the
 * host, everything else is a client-only pref saved on this device.
 */
export type ProjectUpdates = Partial<Omit<Project, 'id' | 'isArchived' | 'isDefault'>>

export interface ProjectState {
  // State
  projects: Project[]
  groups: ProjectGroup[]
  activeProjectId: string
  isLoaded: boolean
  isWorktreeOperationLocked: boolean

  // Actions
  /** This device's own choice: writes the device `active-project` key and nothing on the host. */
  selectProject: (id: string) => void
  /**
   * Registers the project with the host, waits for the `projects` watch to list
   * it, then selects it. Rejects when the host refuses the registration.
   */
  addProject: (
    name: string,
    color: ProjectColor,
    path?: string,
    defaultShell?: string,
    envVars?: EnvVariable[]
  ) => Promise<Project>
  /**
   * `name`/`color`/`path` go to the host (the watch delivers the result; moving
   * the root of a busy project waits for the user in the busy dialog); the rest
   * is saved on this device.
   */
  updateProject: (id: string, updates: ProjectUpdates) => void
  /**
   * Ask the host to remove the project. A project with live chats or terminals
   * is refused; the user then decides in the busy dialog, which resends with
   * `cascade: true` only after they agree.
   */
  deleteProject: (id: string, options?: CascadeOptions) => Promise<void>
  /** Like `deleteProject`, for archiving. */
  archiveProject: (id: string, options?: CascadeOptions) => Promise<void>
  restoreProject: (id: string) => Promise<void>
  reorderProjects: (activeProjectIds: string[]) => void
  /** The projects-watch feed only: replaces the whole list. */
  setProjects: (projects: Project[], activeProjectId?: string, groups?: ProjectGroup[]) => void
  /** Reconciler only (AD-3): other writers go through `reconcileProjectWorktrees`. */
  addWorktree: (projectId: string, worktree: Worktree) => void
  /** Reconciler only (AD-3): other writers go through `reconcileProjectWorktrees`. */
  removeWorktree: (projectId: string, worktreeId: string) => void
  setWorktreeOperationLock: (locked: boolean) => void

  // Group Actions
  addGroup: (name: string) => string
  removeGroup: (id: string, deleteProjects: boolean) => void
  renameGroup: (id: string, newName: string) => void
  toggleGroupCollapse: (id: string) => void
  moveProjectToGroup: (projectId: string, targetGroupId: string | null, index?: number) => void
  reorderGroups: (groupIds: string[]) => void
  reorderProjectInGroup: (groupId: string, projectIds: string[]) => void
  updateGroup: (id: string, updates: Partial<Omit<ProjectGroup, 'id'>>) => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Park a busy refusal in the busy store, where the user decides whether the host may stop what is bound. */
function requestBusyConfirmation(
  kind: 'delete' | 'archive' | 'move',
  projectId: string,
  project: Project | undefined,
  busy: ProjectBusyError,
  resend: () => Promise<void>
): void {
  useProjectBusyStore.getState().request({
    kind,
    projectId,
    projectName: project?.name ?? 'This project',
    sessions: busy.sessions.length,
    terminals: busy.terminals.length,
    resend
  })
}

/** Resolves `true` once the `projects` watch lists `projectId`, `false` after {@link LISTED_TIMEOUT_MS}. */
function untilListed(projectId: string): Promise<boolean> {
  const listed = (): boolean => useProjectStore.getState().projects.some((p) => p.id === projectId)
  if (listed()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const unsubscribe = useProjectStore.subscribe(() => {
      if (!listed()) return
      clearTimeout(timer)
      unsubscribe()
      resolve(true)
    })
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, LISTED_TIMEOUT_MS)
  })
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  groups: [],
  activeProjectId: '',
  isLoaded: false,
  isWorktreeOperationLocked: false,
  setProjects: (projects: Project[], activeProjectId?: string, groups?: ProjectGroup[]): void => {
    set({
      projects,
      groups: groups ?? [],
      activeProjectId: activeProjectId ?? (projects.length > 0 ? projects[0].id : ''),
      isLoaded: true
    })
  },

  selectProject: (id: string): void => {
    const prev = get().activeProjectId
    set((state) => ({
      activeProjectId: id,
      projects: state.projects.map((p) => ({ ...p, isActive: p.id === id }))
    }))
    if (prev !== id) {
      writeActiveProject(id)
      clearChatRoute()
    }
  },

  addProject: async (
    name: string,
    color: ProjectColor,
    path?: string,
    defaultShell?: string,
    envVars?: EnvVariable[]
  ): Promise<Project> => {
    const newProject: Project = {
      id: randomUUID(),
      name,
      color,
      path,
      defaultShell,
      envVars
      // gitBranch intentionally omitted: a stale hardcoded 'main' here was
      // shown in the status bar before the real branch was detected.
      // `useProjectGitBranch` auto-detects the actual HEAD branch on project
      // activation; the manual GitBranchPicker switch still updates it.
    }
    // Remembered first: the watch state that lists the project can land before
    // the reply does, and must find the shell and env vars waiting.
    rememberProjectPrefs(newProject.id, clientFieldsOf(newProject))
    try {
      await projectRegistryApi.add({ id: newProject.id, name, path: path ?? '', color })
    } catch (error) {
      await forgetProjectPrefs(newProject.id, { keepSecrets: true })
      throw error
    }
    if (!(await untilListed(newProject.id))) {
      void logFrontendError({
        level: 'warn',
        source: 'project-store.addProject',
        message: `project ${newProject.id} was registered but the projects watch did not list it within ${LISTED_TIMEOUT_MS}ms`
      })
    }
    get().selectProject(newProject.id)
    return get().projects.find((p) => p.id === newProject.id) ?? newProject
  },

  updateProject: (id: string, updates: ProjectUpdates): void => {
    const { name, color, path, ...clientUpdates } = updates
    if (Object.keys(clientUpdates).length > 0) {
      set((state) => ({
        projects: state.projects.map((p) => (p.id === id ? { ...p, ...clientUpdates } : p))
      }))
    }
    const current = get().projects.find((p) => p.id === id)
    const root = path?.trim()
    const patch = {
      ...(name !== undefined && name !== current?.name ? { name } : {}),
      ...(color !== undefined && color !== current?.color ? { color } : {}),
      ...(root && root !== current?.path ? { path: root } : {})
    }
    if (Object.keys(patch).length === 0) return
    const send = (options?: CascadeOptions): Promise<void> =>
      projectRegistryApi.update(id, patch, options).catch((error: unknown) => {
        if (error instanceof ProjectBusyError) {
          requestBusyConfirmation('move', id, current, error, () => send({ cascade: true }))
        } else {
          toast.error(`Could not update the project: ${describe(error)}`)
        }
      })
    void send()
  },

  deleteProject: async (id: string, options?: CascadeOptions): Promise<void> => {
    const project = get().projects.find((p) => p.id === id)
    if (!(await unmountCanvases([id]))) return
    try {
      await projectRegistryApi.remove(id, options)
    } catch (error) {
      if (error instanceof ProjectBusyError) {
        requestBusyConfirmation('delete', id, project, error, () =>
          get().deleteProject(id, { cascade: true })
        )
      } else {
        toast.error(`Could not delete the project: ${describe(error)}`)
      }
      return
    }
    // The host dropped it; what this device kept for it goes too. The watch
    // state that follows takes the project out of the list.
    set((state) => ({
      groups: state.groups.map((g) => ({
        ...g,
        projectIds: g.projectIds.filter((pid) => pid !== id)
      }))
    }))
    await forgetProjectPrefs(id)
  },

  archiveProject: async (id: string, options?: CascadeOptions): Promise<void> => {
    const project = get().projects.find((p) => p.id === id)
    if (!(await unmountCanvases([id]))) return
    try {
      await projectRegistryApi.archive(id, options)
    } catch (error) {
      if (error instanceof ProjectBusyError) {
        requestBusyConfirmation('archive', id, project, error, () =>
          get().archiveProject(id, { cascade: true })
        )
      } else {
        toast.error(`Could not archive the project: ${describe(error)}`)
      }
    }
  },

  restoreProject: async (id: string): Promise<void> => {
    try {
      await projectRegistryApi.restore(id)
    } catch (error) {
      toast.error(`Could not restore the project: ${describe(error)}`)
    }
  },

  reorderProjects: (activeProjectIds: string[]): void => {
    set((state) => {
      // Separate archived and active projects
      const archivedProjects = state.projects.filter((p) => p.isArchived)
      const activeProjects = state.projects.filter((p) => !p.isArchived)

      // Create a map for quick lookup
      const projectMap = new Map(activeProjects.map((p) => [p.id, p]))

      // Reorder active projects based on the new order
      const reorderedActive = activeProjectIds
        .map((id) => projectMap.get(id))
        .filter((p): p is Project => p !== undefined)

      // Preserve active projects that were not in the reordered list (e.g. grouped projects)
      const reorderedIdsSet = new Set(activeProjectIds)
      const remainingActive = activeProjects.filter((p) => !reorderedIdsSet.has(p.id))

      // Combine reordered active projects, remaining active projects, and archived projects
      return { projects: [...reorderedActive, ...remainingActive, ...archivedProjects] }
    })
  },

  addWorktree: (projectId: string, worktree: Worktree): void => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, worktrees: [...(p.worktrees ?? []), worktree] } : p
      )
    }))
  },

  removeWorktree: (projectId: string, worktreeId: string): void => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              worktrees: (p.worktrees ?? []).filter((w) => w.id !== worktreeId)
            }
          : p
      )
    }))
  },

  setWorktreeOperationLock: (locked: boolean): void => {
    set({ isWorktreeOperationLocked: locked })
  },

  // Group Actions Implementation
  addGroup: (name: string): string => {
    const id = randomUUID()
    const newGroup: ProjectGroup = {
      id,
      name,
      projectIds: [],
      isCollapsed: false
    }
    set((state) => ({
      groups: [...state.groups, newGroup]
    }))
    return id
  },

  removeGroup: (id: string, deleteProjects: boolean): void => {
    const { groups } = get()
    const groupToRemove = groups.find((g) => g.id === id)
    if (!groupToRemove) return

    set({ groups: groups.filter((g) => g.id !== id) })
    // The group's projects are the host's to remove: each one asks, and a busy
    // one waits for the user's answer like any other delete.
    if (deleteProjects) {
      for (const projectId of groupToRemove.projectIds) {
        void get().deleteProject(projectId)
      }
    }
  },

  renameGroup: (id: string, newName: string): void => {
    set((state) => ({
      groups: state.groups.map((g) => (g.id === id ? { ...g, name: newName } : g))
    }))
  },

  toggleGroupCollapse: (id: string): void => {
    set((state) => ({
      groups: state.groups.map((g) => (g.id === id ? { ...g, isCollapsed: !g.isCollapsed } : g))
    }))
  },

  moveProjectToGroup: (projectId: string, targetGroupId: string | null, index?: number): void => {
    set((state) => {
      // 1. Remove from all existing groups
      const cleanedGroups = state.groups.map((g) => ({
        ...g,
        projectIds: g.projectIds.filter((pid) => pid !== projectId)
      }))

      // 2. Add to target group if it exists
      if (targetGroupId === null) {
        return { groups: cleanedGroups }
      }

      return {
        groups: cleanedGroups.map((g) => {
          if (g.id === targetGroupId) {
            const newProjectIds = [...g.projectIds]
            if (typeof index === 'number') {
              newProjectIds.splice(index, 0, projectId)
            } else {
              newProjectIds.push(projectId)
            }
            return { ...g, projectIds: newProjectIds, isCollapsed: false }
          }
          return g
        })
      }
    })
  },

  reorderGroups: (groupIds: string[]): void => {
    set((state) => {
      const groupMap = new Map(state.groups.map((g) => [g.id, g]))
      const reorderedGroups = groupIds
        .map((id) => groupMap.get(id))
        .filter((g): g is ProjectGroup => g !== undefined)

      // Preserve groups that were not in the reordered list
      const reorderedIdsSet = new Set(groupIds)
      const remainingGroups = state.groups.filter((g) => !reorderedIdsSet.has(g.id))

      return { groups: [...reorderedGroups, ...remainingGroups] }
    })
  },

  reorderProjectInGroup: (groupId: string, projectIds: string[]): void => {
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, projectIds } : g))
    }))
  },

  updateGroup: (id: string, updates: Partial<Omit<ProjectGroup, 'id'>>): void => {
    set((state) => ({
      groups: state.groups.map((g) => (g.id === id ? { ...g, ...updates } : g))
    }))
  }
}))

// Selectors for performance (selective subscriptions)
export function useActiveProject(): Project | undefined {
  return useProjectStore((state) => state.projects.find((p) => p.id === state.activeProjectId))
}

export function useProjects(): Project[] {
  return useProjectStore(useShallow((state) => state.projects))
}

export function useActiveProjectId(): string {
  return useProjectStore((state) => state.activeProjectId)
}

export function useProjectsLoaded(): boolean {
  return useProjectStore((state) => state.isLoaded)
}

export function useProjectActions(): Pick<
  ProjectState,
  | 'selectProject'
  | 'addProject'
  | 'updateProject'
  | 'deleteProject'
  | 'archiveProject'
  | 'restoreProject'
  | 'reorderProjects'
  | 'addWorktree'
  | 'removeWorktree'
  | 'setWorktreeOperationLock'
  | 'addGroup'
  | 'removeGroup'
  | 'renameGroup'
  | 'toggleGroupCollapse'
  | 'moveProjectToGroup'
  | 'reorderGroups'
  | 'reorderProjectInGroup'
  | 'updateGroup'
> {
  return useProjectStore(
    useShallow((state) => ({
      selectProject: state.selectProject,
      addProject: state.addProject,
      updateProject: state.updateProject,
      deleteProject: state.deleteProject,
      archiveProject: state.archiveProject,
      restoreProject: state.restoreProject,
      reorderProjects: state.reorderProjects,
      addWorktree: state.addWorktree,
      removeWorktree: state.removeWorktree,
      setWorktreeOperationLock: state.setWorktreeOperationLock,
      addGroup: state.addGroup,
      removeGroup: state.removeGroup,
      renameGroup: state.renameGroup,
      toggleGroupCollapse: state.toggleGroupCollapse,
      moveProjectToGroup: state.moveProjectToGroup,
      reorderGroups: state.reorderGroups,
      reorderProjectInGroup: state.reorderProjectInGroup,
      updateGroup: state.updateGroup
    }))
  )
}
