import { useEffect, useCallback, useRef } from 'react'
import { useProjectStore } from '@/stores/project-store'
import { persistenceApi, secureStorageApi, worktreeApi } from '@/lib/api'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import type {
  PersistedProjectData,
  PersistedProject,
  PersistedWorktree
} from '../../shared/types/persistence.types'
import type { Project, ProjectColor, EnvVariable, Worktree } from '@/types/project'

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
    console.warn(
      `Failed to delete secret ${envKey} for project ${projectId}:`,
      deleteResult.error
    )
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
    isGitRepo: project.isGitRepo,
    tunnelPresets: project.tunnelPresets?.map((preset) => ({
      id: preset.id,
      name: preset.name,
      localPort: preset.localPort,
      hostname: preset.hostname,
      cloudflareToken: preset.cloudflareToken,
      projectId: preset.projectId,
      autoStart: preset.autoStart
    }))
  }
}

async function persistProjectsSnapshot(
  projects: Project[],
  activeProjectId: string,
  writeProjects: (key: string, data: PersistedProjectData) => Promise<unknown>,
  previousProjects?: ProjectSnapshot[]
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
    isGitRepo: persisted.isGitRepo,
    tunnelPresets: persisted.tunnelPresets?.map((preset) => ({
      id: preset.id,
      name: preset.name,
      localPort: preset.localPort,
      hostname: preset.hostname,
      cloudflareToken: preset.cloudflareToken,
      projectId: preset.projectId,
      autoStart: preset.autoStart
    }))
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
        // Load projects with secrets from secure storage
        const projects = await Promise.all(
          result.data.projects.map(fromPersistedProject)
        )
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
            // Reconcile worktrees using the worktreeApi
            worktreeApi.list(project.path).then((result) => {
              if (result.success && result.data) {
                const storedPaths = new Set((project.worktrees ?? []).map((w) => w.path))
                const discovered = result.data.filter(
                  (w) => w.path !== project.path && !storedPaths.has(w.path),
                )
                for (const wt of discovered) {
                  const newWorktree = {
                    id: crypto.randomUUID(),
                    name: wt.name,
                    branch: wt.branch,
                    path: wt.path,
                    createdAt: new Date().toISOString(),
                  }
                  useProjectStore.getState().addWorktree(project.id, newWorktree)
                }
              }
            }).catch((err: unknown) =>
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

      // Convert projects to persisted format (async)
      persistProjectsSnapshot(
        state.projects,
        state.activeProjectId,
        persistenceApi.writeDebounced,
        prevState.projects
      )
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
    await persistProjectsSnapshot(projects, activeProjectId, persistenceApi.writeDebounced)
  }, [])
}

export function usePersistProjectsImmediate(): () => Promise<void> {
  return useCallback(async () => {
    const { projects, activeProjectId } = useProjectStore.getState()
    await persistProjectsSnapshot(projects, activeProjectId, persistenceApi.write)
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

    // Delete the project from the store
    useProjectStore.getState().deleteProject(id)

    // Cascade delete: remove terminal layout and snapshots for this project
    await Promise.all([
      persistenceApi.delete(PersistenceKeys.terminals(id)),
      persistenceApi.delete(PersistenceKeys.snapshots(id))
    ])

    // Persist the updated projects list
    const { projects, activeProjectId } = useProjectStore.getState()
    const persistedProjects = await Promise.all(
      projects.map((project) => toPersistedProject(project))
    )
    const data: PersistedProjectData = {
      projects: persistedProjects,
      activeProjectId,
      updatedAt: new Date().toISOString()
    }
    await persistenceApi.write(PersistenceKeys.projects, data)
  }, [])
}
