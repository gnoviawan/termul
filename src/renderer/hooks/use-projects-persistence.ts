import { useEffect, useCallback, useRef } from 'react'
import { useProjectStore } from '@/stores/project-store'
import { persistenceApi, worktreeApi } from '@/lib/api'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import type { PersistedProjectData, PersistedProject, PersistedWorktree } from '../../shared/types/persistence.types'
import type { Project, ProjectColor, Worktree } from '@/types/project'

function toPersistedEnvVars(project: Project): PersistedProject['envVars'] {
  return project.envVars?.map((envVar) => ({
    key: envVar.key,
    value: envVar.isSecret ? '' : envVar.value,
    isSecret: envVar.isSecret
  }))
}

function fromPersistedEnvVars(persisted: PersistedProject): Project['envVars'] {
  return persisted.envVars?.map((envVar) => ({
    key: envVar.key,
    value: envVar.isSecret ? '' : envVar.value,
    isSecret: envVar.isSecret
  }))
}

function toPersistedWorktree(worktree: Worktree): PersistedWorktree {
  return {
    id: worktree.id,
    name: worktree.name,
    branch: worktree.branch,
    path: worktree.path,
    createdAt: worktree.createdAt,
  }
}

function fromPersistedWorktree(persisted: PersistedWorktree): Worktree {
  return {
    id: persisted.id,
    name: persisted.name,
    branch: persisted.branch,
    path: persisted.path,
    createdAt: persisted.createdAt,
  }
}

function toPersistedProject(project: Project): PersistedProject {
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    path: project.path,
    isArchived: project.isArchived,
    gitBranch: project.gitBranch,
    defaultShell: project.defaultShell,
    // TODO: Secret values (isSecret===true) should be stored in secure OS storage (keyring/secureStore)
    // instead of plaintext. Until secure storage exists, secret keys are preserved but values are redacted.
    envVars: toPersistedEnvVars(project),
    worktrees: project.worktrees?.map(toPersistedWorktree),
    activeWorktreeId: project.activeWorktreeId,
    isGitRepo: project.isGitRepo,
  }
}

function fromPersistedProject(persisted: PersistedProject): Project {
  return {
    id: persisted.id,
    name: persisted.name,
    color: persisted.color as ProjectColor,
    path: persisted.path,
    isArchived: persisted.isArchived,
    gitBranch: persisted.gitBranch,
    defaultShell: persisted.defaultShell,
    envVars: fromPersistedEnvVars(persisted),
    worktrees: persisted.worktrees?.map(fromPersistedWorktree),
    activeWorktreeId: persisted.activeWorktreeId,
    isGitRepo: persisted.isGitRepo,
  }
}

/**
 * Reconcile worktrees for a single project against `git worktree list --porcelain`.
 * Adds worktrees that git knows about but we don't; removes stale entries.
 * All actions are logged with [WorktreeReconciler] prefix for debugging.
 */
async function reconcileProjectWorktrees(project: Project): Promise<void> {
  if (!project.path) return

  const result = await worktreeApi.list(project.path)
  if (!result.success) {
    // Not a git repo or git not available
    if (result.code === 'NOT_A_GIT_REPO' || result.code === 'GIT_NOT_FOUND') {
      useProjectStore.getState().updateProject(project.id, { isGitRepo: false })
      console.debug(`[WorktreeReconciler] Not a git repo or git not found: ${project.name}`)
    }
    return
  }

  // Mark project as a git repo
  useProjectStore.getState().updateProject(project.id, { isGitRepo: true })

  const gitWorktrees = result.data
  if (!gitWorktrees) return

  const storedWorktrees = project.worktrees ?? []
  const storedByPath = new Map(storedWorktrees.map((w) => [w.path, w]))
  const gitByPath = new Map(gitWorktrees.map((w) => [w.path, w]))

  let changed = false
  const updatedWorktrees = [...storedWorktrees]

  // Git has worktree not in store → add it
  for (const gitWt of gitWorktrees) {
    if (!storedByPath.has(gitWt.path)) {
      const isTermulManaged = gitWt.path.includes('.termul/worktrees/')
      updatedWorktrees.push({
        id: crypto.randomUUID(),
        name: gitWt.name,
        branch: gitWt.branch,
        path: gitWt.path,
        createdAt: new Date().toISOString(),
      })
      console.debug(`[WorktreeReconciler] Added worktree: ${gitWt.name} at ${gitWt.path} (managed: ${isTermulManaged})`)
      changed = true
    }
  }

  // Store has worktree git doesn't show → remove stale entry
  // But only remove if we can verify (the path no longer exists or git doesn't list it)
  const staleIds: string[] = []
  for (const storedWt of storedWorktrees) {
    if (!gitByPath.has(storedWt.path)) {
      staleIds.push(storedWt.id)
      console.debug(`[WorktreeReconciler] Removing stale worktree: ${storedWt.name} (not in git worktree list)`)
      changed = true
    }
  }

  if (changed) {
    const finalList = updatedWorktrees.filter((w) => !staleIds.includes(w.id))
    useProjectStore.getState().updateProject(project.id, { worktrees: finalList })
  }
}

/**
 * Hook that reconciles worktrees for the active project.
 * Runs on project selection and periodically (every 60s).
 * Also reconciles all projects on initial load.
 */
export function useWorktreeReconciler(): void {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const projects = useProjectStore((state) => state.projects)

  useEffect(() => {
    const activeProject = projects.find((p) => p.id === activeProjectId)
    if (!activeProject?.path) return

    // Reconcile on project selection
    reconcileProjectWorktrees(activeProject)

    // Periodic reconciliation every 60s for active project
    const interval = setInterval(() => {
      const currentProject = useProjectStore.getState().projects.find(
        (p) => p.id === activeProjectId
      )
      if (currentProject?.path) {
        reconcileProjectWorktrees(currentProject)
      }
    }, 60_000)

    return () => clearInterval(interval)
  }, [activeProjectId, projects])
}

/**
 * Force-reconcile worktrees for a specific project after create/remove operations.
 * Always re-lists from git to ensure consistency.
 */
export async function reconcileProjectWorktreesNow(projectId: string): Promise<void> {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  if (project) {
    await reconcileProjectWorktrees(project)
  }
}

export function useProjectsLoader(): void {
  const setProjects = useProjectStore((state) => state.setProjects)

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await persistenceApi.read<PersistedProjectData>(
        PersistenceKeys.projects
      )
      if (result.success && result.data) {
        const projects = result.data.projects.map(fromPersistedProject)
        // Validate activeProjectId exists in projects
        const validActiveId = projects.some((p) => p.id === result.data.activeProjectId)
          ? result.data.activeProjectId
          : projects.length > 0
            ? projects[0].id
            : ''
        setProjects(projects, validActiveId)

        // Reconcile all projects against git in parallel after loading
        for (const project of projects) {
          if (project.path) {
            reconcileProjectWorktrees(project).catch((err) =>
              console.debug('[WorktreeReconciler] Reconciliation error:', err)
            )
          }
        }
      } else {
        // No saved projects - start with empty state
        setProjects([])
      }
    }
    load()
  }, [setProjects])
}

/**
 * Hook to auto-save projects when the store changes
 * Subscribes to project store changes and triggers debounced writes
 */
export function useProjectsAutoSave(): void {
  const hasInitialized = useRef(false)

  useEffect(() => {
    // Subscribe to project store changes
    const unsubscribe = useProjectStore.subscribe((state, prevState) => {
      // Skip the first state change (from loading)
      if (!hasInitialized.current) {
        hasInitialized.current = true
        return
      }

      // Only save if projects or activeProjectId changed
      if (
        state.projects === prevState.projects &&
        state.activeProjectId === prevState.activeProjectId
      ) {
        return
      }

      const data: PersistedProjectData = {
        projects: state.projects.map(toPersistedProject),
        activeProjectId: state.activeProjectId,
        updatedAt: new Date().toISOString()
      }

      // Use debounced write via API
      persistenceApi
        .writeDebounced(PersistenceKeys.projects, data)
        .catch((err: unknown) => {
          console.error('Failed to auto-save projects:', err)
        })
    })

    return () => {
      unsubscribe()
    }
  }, [])
}

export function usePersistProjects(): () => Promise<void> {
  return useCallback(async () => {
    const { projects, activeProjectId } = useProjectStore.getState()
    const data: PersistedProjectData = {
      projects: projects.map(toPersistedProject),
      activeProjectId,
      updatedAt: new Date().toISOString()
    }
    await persistenceApi.writeDebounced(PersistenceKeys.projects, data)
  }, [])
}

export function usePersistProjectsImmediate(): () => Promise<void> {
  return useCallback(async () => {
    const { projects, activeProjectId } = useProjectStore.getState()
    const data: PersistedProjectData = {
      projects: projects.map(toPersistedProject),
      activeProjectId,
      updatedAt: new Date().toISOString()
    }
    await persistenceApi.write(PersistenceKeys.projects, data)
  }, [])
}

export function useDeleteProjectWithCascade(): (id: string) => Promise<void> {
  return useCallback(async (id: string) => {
    // Delete the project from the store
    useProjectStore.getState().deleteProject(id)

    // Cascade delete: remove terminal layout and snapshots for this project
    await Promise.all([
      persistenceApi.delete(PersistenceKeys.terminals(id)),
      persistenceApi.delete(PersistenceKeys.snapshots(id))
    ])

    // Persist the updated projects list
    const { projects, activeProjectId } = useProjectStore.getState()
    const data: PersistedProjectData = {
      projects: projects.map(toPersistedProject),
      activeProjectId,
      updatedAt: new Date().toISOString()
    }
    await persistenceApi.write(PersistenceKeys.projects, data)
  }, [])
}
