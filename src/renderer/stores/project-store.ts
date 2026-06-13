import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { EnvVariable, Project, ProjectColor, ProjectGroup, Worktree } from '@/types/project'

export interface ProjectState {
  // State
  projects: Project[]
  groups: ProjectGroup[]
  activeProjectId: string
  isLoaded: boolean
  isWorktreeOperationLocked: boolean

  // Actions
  selectProject: (id: string) => void
  addProject: (
    name: string,
    color: ProjectColor,
    path?: string,
    defaultShell?: string,
    envVars?: EnvVariable[]
  ) => Project
  updateProject: (id: string, updates: Partial<Project>) => void
  deleteProject: (id: string) => void
  archiveProject: (id: string) => void
  restoreProject: (id: string) => void
  reorderProjects: (activeProjectIds: string[]) => void
  setProjects: (projects: Project[], activeProjectId?: string, groups?: ProjectGroup[]) => void
  addWorktree: (projectId: string, worktree: Worktree) => void
  removeWorktree: (projectId: string, worktreeId: string) => void
  setActiveWorktree: (projectId: string, worktreeId: string | null) => void
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
    set((state) => ({
      activeProjectId: id,
      projects: state.projects.map((p) => ({ ...p, isActive: p.id === id }))
    }))
  },

  addProject: (
    name: string,
    color: ProjectColor,
    path?: string,
    defaultShell?: string,
    envVars?: EnvVariable[]
  ): Project => {
    const newProject: Project = {
      id: crypto.randomUUID(),
      name,
      color,
      path,
      defaultShell,
      envVars,
      gitBranch: 'main'
    }
    set((state) => ({
      projects: [...state.projects, newProject],
      activeProjectId: newProject.id
    }))
    return newProject
  },

  updateProject: (id: string, updates: Partial<Project>): void => {
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, ...updates } : p))
    }))
  },

  deleteProject: (id: string): void => {
    const { projects, activeProjectId, groups } = get()
    const remaining = projects.filter((p) => p.id !== id)

    // Also remove from any group it belongs to
    const updatedGroups = groups.map((g) => ({
      ...g,
      projectIds: g.projectIds.filter((pid) => pid !== id)
    }))

    set({
      projects: remaining,
      groups: updatedGroups,
      activeProjectId:
        activeProjectId === id && remaining.length > 0
          ? remaining[0].id
          : activeProjectId === id
            ? ''
            : activeProjectId
    })
  },

  archiveProject: (id: string): void => {
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, isArchived: true } : p))
    }))
  },

  restoreProject: (id: string): void => {
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, isArchived: false } : p))
    }))
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
              worktrees: (p.worktrees ?? []).filter((w) => w.id !== worktreeId),
              activeWorktreeId: p.activeWorktreeId === worktreeId ? null : p.activeWorktreeId
            }
          : p
      )
    }))
  },

  setActiveWorktree: (projectId: string, worktreeId: string | null): void => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, activeWorktreeId: worktreeId } : p
      )
    }))
  },

  setWorktreeOperationLock: (locked: boolean): void => {
    set({ isWorktreeOperationLocked: locked })
  },

  // Group Actions Implementation
  addGroup: (name: string): string => {
    const id = crypto.randomUUID()
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
    const { groups, projects, activeProjectId } = get()
    const groupToRemove = groups.find((g) => g.id === id)
    if (!groupToRemove) return

    let updatedProjects = projects
    if (deleteProjects) {
      updatedProjects = projects.filter((p) => !groupToRemove.projectIds.includes(p.id))
    }

    const nextActiveProjectId =
      deleteProjects && !updatedProjects.some((p) => p.id === activeProjectId)
        ? (updatedProjects[0]?.id ?? '')
        : activeProjectId

    set({
      groups: groups.filter((g) => g.id !== id),
      projects: updatedProjects,
      activeProjectId: nextActiveProjectId
    })
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

export function getActiveWorktreeFromStore(projectId: string): Worktree | undefined {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  if (!project?.activeWorktreeId) return undefined
  return project.worktrees?.find((w) => w.id === project.activeWorktreeId)
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
  | 'setActiveWorktree'
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
      setActiveWorktree: state.setActiveWorktree,
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
