import { useCallback, useEffect, useRef } from 'react'
import { persistenceApi, secureStorageApi, terminalApi, worktreeApi } from '@/lib/api'
import { setTerminalProtected } from '@/lib/terminal-api'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { EnvVariable, Project, ProjectColor, ProjectGroup, Worktree } from '@/types/project'
import type {
  PersistedProject,
  PersistedProjectData,
  PersistedProjectGroup,
  PersistedWorktree
} from '../../shared/types/persistence.types'
import { PersistenceKeys } from '../../shared/types/persistence.types'

const REDACTED_VALUE = '[REDACTED]'
type EnvVariableSnapshot = Pick<EnvVariable, 'key' | 'value' | 'isSecret'>
type ProjectSnapshot = Pick<Project, 'id'> & { envVars?: EnvVariableSnapshot[] }

/**
 * Generate secure storage key for a project environment variable
 */
function getSecureStorageKey(projectId: string, envKey: string): string {
  return `project:${projectId}:env:${envKey}`
}

function isSecretEnvVar(envVar: Pick<EnvVariableSnapshot, 'isSecret'>): boolean {
  return envVar.isSecret === true
}

async function deleteSecretEntry(projectId: string, envKey: string): Promise<void> {
  const storageKey = getSecureStorageKey(projectId, envKey)
  const deleteResult = await secureStorageApi.deleteSecret(storageKey)

  if (!deleteResult.success) {
    console.warn(`Failed to delete secret ${envKey} for project ${projectId}:`, deleteResult.error)
  }
}

async function cleanupObsoleteSecrets(
  projectId: string,
  previousEnvVars: EnvVariableSnapshot[] | undefined,
  nextEnvVars: EnvVariable[] | undefined
): Promise<void> {
  if (!previousEnvVars || previousEnvVars.length === 0) {
    return
  }

  const nextSecretKeys = new Set(
    (nextEnvVars ?? []).filter((envVar) => isSecretEnvVar(envVar)).map((envVar) => envVar.key)
  )

  for (const previousEnvVar of previousEnvVars) {
    if (!isSecretEnvVar(previousEnvVar)) {
      continue
    }

    if (nextSecretKeys.has(previousEnvVar.key)) {
      continue
    }

    await deleteSecretEntry(projectId, previousEnvVar.key)
  }
}

async function cleanupRemovedProjects(
  previousProjects: ProjectSnapshot[],
  nextProjects: Project[]
): Promise<void> {
  const nextProjectIds = new Set(nextProjects.map((project) => project.id))

  for (const previousProject of previousProjects) {
    if (nextProjectIds.has(previousProject.id)) {
      continue
    }

    await deleteSecrets(previousProject.id, previousProject.envVars)
  }
}

async function getPersistedProjectsSnapshot(): Promise<PersistedProject[]> {
  const result = await persistenceApi.read<PersistedProjectData>(PersistenceKeys.projects)

  if (!result.success || !result.data) {
    return []
  }

  return result.data.projects
}

/**
 * Store secret environment variables in secure storage
 * Returns the env vars with secrets redacted for persistence
 */
async function storeSecretsAndRedact(
  projectId: string,
  envVars: EnvVariable[] | undefined
): Promise<EnvVariable[] | undefined> {
  if (!envVars || envVars.length === 0) {
    return envVars
  }

  const result: EnvVariable[] = []

  for (const envVar of envVars) {
    if (envVar.isSecret) {
      if (envVar.value === REDACTED_VALUE) {
        result.push(envVar)
        continue
      }

      // Store in secure storage
      const storageKey = getSecureStorageKey(projectId, envVar.key)
      const storeResult = await secureStorageApi.setSecret(storageKey, envVar.value)

      if (!storeResult.success) {
        // Abort the save instead of writing the raw secret to disk. Throwing
        // keeps the recoverable plaintext value in the in-memory store while
        // ensuring neither the secret nor a misleading [REDACTED] placeholder
        // is persisted when the keychain write fails.
        throw new Error(
          `Failed to store secret ${envVar.key} for project ${projectId}: ${
            storeResult.error ?? 'unknown error'
          }`
        )
      }

      // Add redacted version to result
      result.push({
        ...envVar,
        value: REDACTED_VALUE,
        isSecret: true
      })
    } else {
      // Non-secret, keep as-is
      result.push(envVar)
    }
  }

  return result
}

/**
 * Load secret environment variables from secure storage
 * Replaces redacted values with actual secrets
 */
async function loadSecrets(
  projectId: string,
  envVars: EnvVariable[] | undefined
): Promise<EnvVariable[] | undefined> {
  if (!envVars || envVars.length === 0) {
    return envVars
  }

  const result: EnvVariable[] = []

  for (const envVar of envVars) {
    if (envVar.isSecret && envVar.value === REDACTED_VALUE) {
      // Load from secure storage
      const storageKey = getSecureStorageKey(projectId, envVar.key)
      const getResult = await secureStorageApi.getSecret(storageKey)

      if (getResult.success) {
        result.push({
          key: envVar.key,
          value: getResult.data,
          isSecret: true
        })
      } else {
        // Secret not found or error - keep redacted
        console.warn(
          `Failed to load secret ${envVar.key} for project ${projectId}:`,
          getResult.error
        )
        result.push(envVar)
      }
    } else {
      // Non-secret or already has value, keep as-is
      result.push(envVar)
    }
  }

  return result
}

/**
 * Delete secret environment variables from secure storage
 */
async function deleteSecrets(projectId: string, envVars: EnvVariable[] | undefined): Promise<void> {
  if (!envVars || envVars.length === 0) {
    return
  }

  for (const envVar of envVars) {
    if (envVar.isSecret) {
      await deleteSecretEntry(projectId, envVar.key)
    }
  }
}

function toPersistedWorktree(worktree: Worktree): PersistedWorktree {
  return {
    id: worktree.id,
    name: worktree.name,
    branch: worktree.branch,
    path: worktree.path,
    createdAt: worktree.createdAt
  }
}

function fromPersistedWorktree(persisted: PersistedWorktree): Worktree {
  return {
    id: persisted.id,
    name: persisted.name,
    branch: persisted.branch,
    path: persisted.path,
    createdAt: persisted.createdAt
  }
}

async function toPersistedProject(
  project: Project,
  previousEnvVars?: EnvVariableSnapshot[]
): Promise<PersistedProject> {
  await cleanupObsoleteSecrets(project.id, previousEnvVars, project.envVars)
  const redactedEnvVars = await storeSecretsAndRedact(project.id, project.envVars)

  return {
    id: project.id,
    name: project.name,
    color: project.color,
    path: project.path,
    isArchived: project.isArchived,
    gitBranch: project.gitBranch,
    defaultShell: project.defaultShell,
    envVars: redactedEnvVars,
    worktrees: project.worktrees?.map(toPersistedWorktree),
    activeWorktreeId: project.activeWorktreeId,
    isGitRepo: project.isGitRepo
  }
}

async function persistProjectsSnapshot(
  projects: Project[],
  activeProjectId: string,
  writeProjects: (key: string, data: PersistedProjectData) => Promise<unknown>,
  previousProjects?: ProjectSnapshot[],
  groups?: ProjectGroup[]
): Promise<void> {
  const previousProjectsSnapshot = previousProjects ?? (await getPersistedProjectsSnapshot())
  await cleanupRemovedProjects(previousProjectsSnapshot, projects)

  const previousEnvVarsByProjectId = new Map(
    previousProjectsSnapshot.map((project) => [project.id, project.envVars])
  )
  const persistedProjects = await Promise.all(
    projects.map((project) =>
      toPersistedProject(project, previousEnvVarsByProjectId.get(project.id))
    )
  )
  const data: PersistedProjectData = {
    projects: persistedProjects,
    groups: groups as PersistedProjectGroup[],
    activeProjectId,
    updatedAt: new Date().toISOString()
  }

  await writeProjects(PersistenceKeys.projects, data)
}

async function fromPersistedProject(persisted: PersistedProject): Promise<Project> {
  const loadedEnvVars = await loadSecrets(persisted.id, persisted.envVars)

  return {
    id: persisted.id,
    name: persisted.name,
    color: persisted.color as ProjectColor,
    path: persisted.path,
    isArchived: persisted.isArchived,
    gitBranch: persisted.gitBranch,
    defaultShell: persisted.defaultShell,
    envVars: loadedEnvVars,
    worktrees: persisted.worktrees?.map(fromPersistedWorktree),
    activeWorktreeId: persisted.activeWorktreeId,
    isGitRepo: persisted.isGitRepo
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
        createdAt: new Date().toISOString()
      })
      console.debug(
        `[WorktreeReconciler] Added worktree: ${gitWt.name} at ${gitWt.path} (managed: ${isTermulManaged})`
      )
      changed = true
    }
  }

  // Store has worktree git doesn't show → remove stale entry
  // But only remove if we can verify (the path no longer exists or git doesn't list it)
  const staleIds: string[] = []
  for (const storedWt of storedWorktrees) {
    if (!gitByPath.has(storedWt.path)) {
      staleIds.push(storedWt.id)
      console.debug(
        `[WorktreeReconciler] Removing stale worktree: ${storedWt.name} (not in git worktree list)`
      )
      changed = true
    }
  }

  if (changed) {
    const finalList = updatedWorktrees.filter((w) => !staleIds.includes(w.id))

    // Reconcile activeWorktreeId: if the active worktree was pruned, reset it
    const currentProject = useProjectStore.getState().projects.find((p) => p.id === project.id)
    const activeId = currentProject?.activeWorktreeId
    const newActiveId = activeId && staleIds.includes(activeId) ? null : activeId

    useProjectStore.getState().updateProject(project.id, {
      worktrees: finalList,
      activeWorktreeId: newActiveId
    })
  }
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
      const result = await persistenceApi.read<PersistedProjectData>(PersistenceKeys.projects)
      if (result.success && result.data) {
        // Load projects with secrets from secure storage
        const projects = await Promise.all(result.data.projects.map(fromPersistedProject))
        // Validate activeProjectId exists in projects
        const validActiveId = projects.some((p) => p.id === result.data.activeProjectId)
          ? result.data.activeProjectId
          : projects.length > 0
            ? projects[0].id
            : ''
        setProjects(projects, validActiveId, result.data.groups as ProjectGroup[])

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
      // Skip auto-saving if the store is not yet loaded
      if (!state.isLoaded) {
        return
      }

      // If we just transitioned to loaded, mark it initialized and skip saving
      if (!prevState.isLoaded) {
        hasInitialized.current = true
        return
      }

      // Skip the first state change (only if we haven't initialized yet, e.g. in tests where isLoaded starts as true)
      if (!hasInitialized.current) {
        hasInitialized.current = true
        return
      }

      // Only save if projects, groups or activeProjectId changed
      if (
        state.projects === prevState.projects &&
        state.groups === prevState.groups &&
        state.activeProjectId === prevState.activeProjectId
      ) {
        return
      }

      // Convert projects to persisted format (async)
      persistProjectsSnapshot(
        state.projects,
        state.activeProjectId,
        persistenceApi.writeDebounced,
        prevState.projects,
        state.groups
      ).catch((err: unknown) => {
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
    const { projects, activeProjectId, groups } = useProjectStore.getState()
    await persistProjectsSnapshot(
      projects,
      activeProjectId,
      persistenceApi.writeDebounced,
      undefined,
      groups
    )
  }, [])
}

export function usePersistProjectsImmediate(): () => Promise<void> {
  return useCallback(async () => {
    const { projects, activeProjectId, groups } = useProjectStore.getState()
    await persistProjectsSnapshot(
      projects,
      activeProjectId,
      persistenceApi.write,
      undefined,
      groups
    )
  }, [])
}

export function useDeleteProjectWithCascade(): (id: string) => Promise<void> {
  return useCallback(async (id: string) => {
    // Get project before deletion to clean up secrets
    const project = useProjectStore.getState().projects.find((p) => p.id === id)

    // Delete secrets from secure storage
    if (project) {
      await deleteSecrets(project.id, project.envVars)
    }

    // Kill the project's live PTYs so the backend reclaims them. The terminals
    // are genuinely released here (the project is being deleted), so they must
    // not stay alive/protected and leak. kill() removes them from the backend
    // terminal map; we also drop them from the renderer store.
    const projectTerminals = useTerminalStore.getState().terminals.filter((t) => t.projectId === id)
    for (const terminal of projectTerminals) {
      if (terminal.ptyId) {
        try {
          // kill() returns an IpcResult; a soft failure does not throw. The
          // project is being deleted regardless, so we always proceed to drop
          // the renderer record below — we just surface a failed kill in logs
          // (e.g. the backend deferring a kill while the window is hidden still
          // reports success, so this only logs genuine failures).
          const result = await terminalApi.kill(terminal.ptyId)
          if (!result.success) {
            console.warn('Failed to kill PTY during project delete:', result.error)
            // Best-effort fallback: allow orphan cleanup if PTY still exists
            await setTerminalProtected(terminal.ptyId, false).catch((error) => {
              console.warn('Failed to clear PTY protection during project delete:', error)
            })
          }
        } catch (error) {
          console.warn('Failed to kill PTY during project delete:', error)
        }
      }
      useTerminalStore.getState().closeTerminal(terminal.id, id)
    }

    // Delete the project from the store
    useProjectStore.getState().deleteProject(id)

    // Cascade delete: remove terminal layout and snapshots for this project
    await Promise.all([
      persistenceApi.delete(PersistenceKeys.terminals(id)),
      persistenceApi.delete(PersistenceKeys.snapshots(id))
    ])

    // Persist the updated projects list
    const { projects, activeProjectId, groups } = useProjectStore.getState()
    const persistedProjects = await Promise.all(
      projects.map((project) => toPersistedProject(project))
    )
    const data: PersistedProjectData = {
      projects: persistedProjects,
      groups: groups as PersistedProjectGroup[],
      activeProjectId,
      updatedAt: new Date().toISOString()
    }
    await persistenceApi.write(PersistenceKeys.projects, data)
  }, [])
}
