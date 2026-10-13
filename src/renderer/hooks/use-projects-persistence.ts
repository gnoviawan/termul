import { useCallback, useEffect, useRef } from 'react'
import { getAcpTransport } from '@/lib/acp-transport'
import {
  filesystemApi,
  persistenceApi,
  secureStorageApi,
  syncProjects,
  terminalApi
} from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { setTerminalProtected } from '@/lib/terminal-api'
import { useWebAuthGateOk } from '@/lib/web-auth-gate'
import { webServerProjects } from '@/lib/web-server-api'
import { workspaceManifestApi } from '@/lib/workspace-manifest-api'
import { reconcileProjectWorktrees } from '@/lib/worktree-reconciler'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { useRemoteStatusStore } from '@/stores/remote-status-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceManifestSyncStore } from '@/stores/workspace-manifest-sync-store'
import type { EnvVariable, Project, ProjectColor, ProjectGroup, Worktree } from '@/types/project'
import type {
  PersistedProject,
  PersistedProjectData,
  PersistedProjectGroup,
  PersistedWorktree
} from '../../shared/types/persistence.types'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import type { ProjectListPayload, ProjectSummary } from '../../shared/types/web-projects.types'

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
    isGitRepo: project.isGitRepo,
    icon: project.icon,
    isDefault: project.isDefault
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
    isGitRepo: persisted.isGitRepo,
    icon: persisted.icon,
    isDefault: persisted.isDefault
  }
}

/**
 * Build the redacted `ProjectSummary[]` wire shape for the web/remote mirror
 * (Epic-4 bridge) from the renderer `Project` store. No env-var values cross
 * the wire — redact-by-omission. Shared by the auto-save live-push path + the
 * `RemoteAccessPopover` server-start seed.
 *
 * The host default is each project's stored `isDefault` flag (the explicit
 * set-default action) and nothing else: the desktop's active project is
 * per-client navigation state and is never pushed as the default.
 */
export function toProjectSummaries(projects: Project[]): ProjectSummary[] {
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    path: p.path ?? null,
    isArchived: p.isArchived ?? false,
    isDefault: p.isDefault === true
  }))
}

/** `true` when two summary lists carry the same wire fields (navigation rebuilds the
 * project array to flip `isActive`, which is not a list change). */
function sameProjectSummaries(a: ProjectSummary[], b: ProjectSummary[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i]
      return (
        q !== undefined &&
        p.id === q.id &&
        p.name === q.name &&
        p.color === q.color &&
        p.path === q.path &&
        p.isArchived === q.isArchived &&
        p.isDefault === q.isDefault
      )
    })
  )
}

/**
 * Map a web/remote `ProjectSummary` (the in-memory registry's wire shape) to
 * the renderer `Project`. The mirror carries NO env-var values (redact-by-
 * omission — secrets live in secure storage; plain env is omitted for the
 * interim), so `envVars` is empty and worktree reconciliation is skipped (the
 * browser cannot shell out to git anyway). `color` is a valid `ProjectColor`
 * token string the desktop sent, cast through.
 *
 * Maps `summary.isDefault` (host default) → `Project.isDefault`. Does NOT map
 * an `isActive` — the host no longer sends one (it cannot know a client's
 * per-connection active selection). `Project.isActive` stays per-client and is
 * stamped locally by `selectProject`.
 */
function summaryToProject(summary: ProjectSummary): Project {
  return {
    id: summary.id,
    name: summary.name,
    color: summary.color as ProjectColor,
    path: summary.path ?? undefined,
    isArchived: summary.isArchived,
    isDefault: summary.isDefault,
    envVars: [],
    worktrees: []
  }
}

/**
 * True while the web loader installs a list the host sent (HTTP read, watch
 * state or delta). The web auto-save subscriber diffs every list change into
 * add/update/remove writes, so it must not read a host-sent list as a local
 * edit: an older watched list that lacks a project whose POST is still pending
 * would otherwise turn into a DELETE of that project.
 */
let applyingHostList = false

function applyHostList(install: () => void): void {
  applyingHostList = true
  try {
    install()
  } finally {
    applyingHostList = false
  }
}

export function useProjectsLoader(): void {
  const setProjects = useProjectStore((state) => state.setProjects)
  // #854: while the web auth gate reports unauthorized (missing/rotated
  // token), the mirror fetch 401s and must not run — it would spin forever
  // in a loop of failed fetches. When the gate resolves ok (including after
  // a token submission), (re)run the fetch with the fresh Authorization
  // header.
  const webAuthGateOk = useWebAuthGateOk()

  useEffect(() => {
    // Web/remote mode: mirror the desktop's project list from the in-memory
    // `ProjectRegistry` via `GET /projects`. The browser's stubbed plugin-store
    // returns nothing, so without this branch the sidebar renders empty. The
    // mirror is read-only — `useProjectsAutoSave` is disabled in web mode. The
    // desktop publishes the project state on store mutation; the `projects` watch delivers it.
    //
    // Epic 7 (cross-client continuity): on the INITIAL load (store not yet
    // `isLoaded`) the client seeds `activeProjectId` from the host's
    // `defaultProjectId`. On subsequent watch lists it
    // preserves its OWN `activeProjectId` (no silent retarget when another
    // client switches). If the current project was deleted by the host, it
    // falls back to `defaultProjectId` (or the first project).
    //
    // Issue #855: the per-client selection survives reloads. The web
    // `persistenceApi` (server-side store over the authenticated WS) is the
    // same mechanism the desktop uses for its `activeProjectId` — the web
    // loader reads the persisted client selection on the initial load (after
    // the project list validates it exists) and re-persists it whenever it
    // changes, so a reload restores the project the user switched to instead
    // of the first project in the list.
    if (!isTauriContext()) {
      // #854: gated out (missing/rotated token) — do nothing; the effect
      // re-runs when the gate flips ok and fetches with the fresh header.
      // Falling through to the desktop persistence branch would flip
      // isLoaded on the stubbed plugin-store's empty result and defeat the
      // token-entry screen.
      if (!webAuthGateOk) return
      let unsub: (() => void) | undefined
      // Guard against completing a fetch after unmount (skip the stale
      // setProjects so a remounted store is not clobbered).
      let cancelled = false
      // Every list that arrives (the HTTP read, a watch state or delta) takes a
      // generation; one that resolves after a newer list has landed is dropped.
      let listGeneration = 0
      const applyList = async (
        data: ProjectListPayload,
        generation = ++listGeneration
      ): Promise<void> => {
        if (cancelled) return
        // Carry resolved icons across the mirror: `ProjectSummary` (a frozen
        // wire shape) does not transport `icon`, and `setProjects` replaces the
        // whole array — without this merge every new list
        // would flash monograms until `use-project-icon` re-resolves.
        const iconById = new Map(
          useProjectStore
            .getState()
            .projects.filter((p) => p.icon)
            .map((p) => [p.id, p.icon] as const)
        )
        // Same carry-over for locally resolved git flags: `ProjectSummary`
        // carries no git fields (frozen wire shape), so without this merge
        // every new list would drop `isGitRepo` stamped by
        // `useProjectGitBranch`/`.git` probes and the web launcher's worktree
        // picker would flicker away until the next probe re-runs.
        const isGitRepoById = new Map(
          useProjectStore
            .getState()
            .projects.filter((p) => p.isGitRepo)
            .map((p) => [p.id, p.isGitRepo] as const)
        )
        // Worktrees are reconciler-owned, also not on the wire (the switcher pick lives in
        // the shell-layout store, keyed by path).
        const prevById = new Map(useProjectStore.getState().projects.map((p) => [p.id, p] as const))
        const projects = data.projects.map((summary) => {
          const project = summaryToProject(summary)
          const icon = iconById.get(project.id)
          const isGitRepo = isGitRepoById.get(project.id)
          const prev = prevById.get(project.id)
          return {
            ...project,
            ...(icon ? { icon } : {}),
            ...(isGitRepo ? { isGitRepo } : {}),
            ...(prev?.worktrees ? { worktrees: prev.worktrees } : {}),
            // The probed HEAD branch is not on the wire either; without it every
            // refetch blanks the Chat cards' branch line and the Launcher strip
            // reads "Detached HEAD" until the next probe.
            ...(prev?.gitBranch ? { gitBranch: prev.gitBranch } : {})
          }
        })
        const defaultId = data.defaultProjectId
        // P2: validate the host default references a project still in the
        // list (the host may have deleted the default project). Fall back to
        // the first project when the default is null or dangling.
        const validDefault =
          defaultId && projects.some((p) => p.id === defaultId)
            ? defaultId
            : (projects[0]?.id ?? '')
        if (!useProjectStore.getState().isLoaded) {
          // Initial load: prefer THIS client's persisted selection (issue
          // #855), then the host default.
          let restored: string | null = null
          const persisted = await persistenceApi.read<string>(PersistenceKeys.activeProject)
          if (
            persisted.success &&
            persisted.data &&
            projects.some((p) => p.id === persisted.data)
          ) {
            restored = persisted.data
          }
          if (cancelled || generation !== listGeneration) return
          applyHostList(() => setProjects(projects, restored ?? validDefault))
          for (const project of projects) {
            if (project.path) void reconcileProjectWorktrees(project.id)
          }
        } else {
          // Subsequent refetch: preserve the client's own activeProjectId.
          // If it's no longer in the list (host deleted it), fall back to the
          // default (or the first project if the default is also gone).
          const currentActive = useProjectStore.getState().activeProjectId
          const stillExists = !!currentActive && projects.some((p) => p.id === currentActive)
          applyHostList(() => setProjects(projects, stillExists ? currentActive : validDefault))
        }
      }
      const fetchMirror = async (): Promise<void> => {
        const generation = ++listGeneration
        const result = await webServerProjects.list()
        if (cancelled || !result.success || !result.data) return
        if (generation !== listGeneration) return
        await applyList(result.data, generation)
      }
      void fetchMirror()
      // The `projects` watch sends the full list on every (re)subscribe and the
      // replacement list on each change, so a missed change is rebuilt from the
      // next state instead of refetched.
      const applyWatched = (list: ProjectListPayload): void => {
        if (!Array.isArray(list?.projects)) return
        void applyList(list)
      }
      try {
        unsub = getAcpTransport().watches?.subscribe<ProjectListPayload, ProjectListPayload>(
          'projects',
          { onState: applyWatched, onDelta: applyWatched }
        )
      } catch (err) {
        console.debug('[projects] projects watch unavailable', err)
      }
      // Persist the client's active selection on every change (issue #855)
      // so a reload restores it. Fire-and-forget with a boundary log on
      // failure; a lost write only degrades to the host default on reload.
      const unsubStore = useProjectStore.subscribe((state, prevState) => {
        if (state.activeProjectId === prevState.activeProjectId) return
        if (!state.activeProjectId) return
        void persistenceApi
          .write(PersistenceKeys.activeProject, state.activeProjectId)
          .then((res) => {
            if (!res.success) {
              void logFrontendError({
                level: 'warn',
                source: 'useProjectsLoader.activeProject',
                message: `persisting the web active project failed: ${res.error ?? 'unknown'}`
              })
            }
          })
          .catch(() => {
            // `persistenceApi` resolves rather than rejects; this only fires
            // on a programming error. Never break the store subscription.
          })
      })
      return () => {
        cancelled = true
        unsub?.()
        unsubStore()
      }
    }

    /**
     * Collect the filesystem paths that must be re-granted to the Tauri fs scope
     * after a restart: every persisted project root plus its worktree paths.
     * Deduplicated — a worktree nested under a root still costs one entry.
     */
    function collectProjectScopePaths(projects: Project[]): string[] {
      const paths = new Set<string>()
      for (const project of projects) {
        if (project.path) paths.add(project.path)
        for (const worktree of project.worktrees ?? []) {
          if (worktree.path) paths.add(worktree.path)
        }
      }
      return [...paths]
    }

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
        // Re-grant fs scope for restored roots BEFORE the explorer reads
        // them: the dialog plugin's pick-time grant dies with the process,
        // and the static capability only allowlists specific drives, so
        // restored projects elsewhere fail with "forbidden path".
        const scopePaths = collectProjectScopePaths(projects)
        if (scopePaths.length > 0) {
          const grant = await filesystemApi.grantFsScope(scopePaths)
          if (!grant.success) {
            console.debug('[projects] fs scope grant failed:', grant.error)
          }
        }

        setProjects(projects, validActiveId, result.data.groups as ProjectGroup[])

        for (const project of projects) {
          if (project.path) void reconcileProjectWorktrees(project.id)
        }
      } else {
        // No saved projects - start with empty state
        setProjects([])
      }
    }
    load()
  }, [setProjects, webAuthGateOk])
}

/**
 * Hook to auto-save projects when the store changes
 * Subscribes to project store changes and triggers debounced writes
 */
// The host default the latest project-list sync reply reported (`undefined`
// until one arrived or after the server stopped), shared by the auto-save hook
// and the server-start seed so a fallback change of the effective default is
// detected against the right baseline. Replies are applied in request order:
// IPC promises can resolve out of order, and a stale reply must not move it.
let hostDefaultSeen: string | null | undefined
let hostDefaultAppliedSeq = 0
let syncRequestSeq = 0

/** Number a project-list sync request (call before sending it). */
export function nextSyncSeq(): number {
  syncRequestSeq += 1
  return syncRequestSeq
}

/**
 * Record the host default a sync reply reported: `'changed'` when the
 * effective default changed (or was unknown), `'same'` when it did not, and
 * `'stale'` for a reply older than one already applied (ignored entirely — it
 * must not trigger any further write).
 */
export function noteHostDefault(
  seq: number,
  hostDefault: string | null | undefined
): 'changed' | 'same' | 'stale' {
  if (seq < hostDefaultAppliedSeq) return 'stale'
  hostDefaultAppliedSeq = seq
  const changed = hostDefaultSeen !== hostDefault
  hostDefaultSeen = hostDefault
  return changed ? 'changed' : 'same'
}

/** Forget the host default (the server stopped; its registry was cleared). */
export function resetHostDefault(): void {
  hostDefaultSeen = undefined
  hostDefaultAppliedSeq = syncRequestSeq
}

export function useProjectsAutoSave(): void {
  const hasInitialized = useRef(false)

  useEffect(() => {
    // Web/remote mode: the project list is persisted server-side (Option B:
    // the standalone server is a first-class project-list authority, so
    // web-client-created projects survive refresh). Diff the store and push
    // individual add/update/remove mutations to the server — the server is
    // the source of truth in VPS mode, and the `projects` watch
    // delivers the new list to all connected clients.
    if (!isTauriContext()) {
      const unsubscribe = useProjectStore.subscribe((state, prevState) => {
        if (!state.isLoaded || !prevState.isLoaded) return
        if (state.projects === prevState.projects) return
        // A list the host sent is not a local edit (see `applyingHostList`).
        if (applyingHostList) return

        const prevById = new Map(prevState.projects.map((p) => [p.id, p]))
        const nextById = new Map(state.projects.map((p) => [p.id, p]))

        // New projects → addProject.
        for (const project of state.projects) {
          if (!prevById.has(project.id)) {
            void webServerProjects
              .addProject({
                id: project.id,
                name: project.name,
                path: project.path ?? '',
                color: project.color,
                isArchived: project.isArchived ?? false
              })
              .then((result) => {
                if (!result.success) {
                  console.warn('[projects] server addProject failed:', result.error)
                }
              })
              .catch((err: unknown) => {
                console.warn('[projects] server addProject error', err)
              })
          }
        }

        // Removed projects → removeProject.
        for (const project of prevState.projects) {
          if (!nextById.has(project.id)) {
            void webServerProjects
              .removeProject(project.id)
              .then((result) => {
                if (!result.success) {
                  console.warn('[projects] server removeProject failed:', result.error)
                }
              })
              .catch((err: unknown) => {
                console.warn('[projects] server removeProject error', err)
              })
          }
        }

        // Changed projects → updateProject (name/color/archived only).
        for (const project of state.projects) {
          const prev = prevById.get(project.id)
          if (!prev) continue
          if (
            prev.name !== project.name ||
            prev.color !== project.color ||
            (prev.isArchived ?? false) !== (project.isArchived ?? false)
          ) {
            void webServerProjects
              .updateProject(project.id, {
                name: project.name,
                color: project.color,
                isArchived: project.isArchived ?? false
              })
              .then((result) => {
                if (!result.success) {
                  console.warn('[projects] server updateProject failed:', result.error)
                }
              })
              .catch((err: unknown) => {
                console.warn('[projects] server updateProject error', err)
              })
          }
        }
      })
      return () => {
        unsubscribe()
      }
    }

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

      // Epic-4 bridge live push: if the shared-live server is running, mirror
      // the new project list into the in-memory registry + publish
      // the state to the `projects` watch so connected web clients rebuild their list.
      // Fire-and-forget (replaces the snapshot — idempotent); no env-var values.
      // Navigation (`activeProjectId`) is NOT a list change: switching the
      // active project pushes nothing and moves no host default.
      const summaries = toProjectSummaries(state.projects)
      if (
        useRemoteStatusStore.getState().status?.running &&
        state.projects !== prevState.projects &&
        !sameProjectSummaries(summaries, toProjectSummaries(prevState.projects))
      ) {
        const defaultChanged =
          state.projects.find((p) => p.isDefault === true)?.id !==
          prevState.projects.find((p) => p.isDefault === true)?.id
        const syncSeq = nextSyncSeq()
        syncProjects(summaries)
          .then((result) => {
            if (!result.success) {
              console.warn('[projects] remote sync unsuccessful:', result.error)
            }
            // CAP-7 interim bridge: the web MCP registry file lives under the
            // host default project, so mirror the MCP registry when the host's
            // EFFECTIVE default changed — the stored default flag moved (an
            // explicit set-default) or the host fell back to another project —
            // never on navigation. Best-effort + non-fatal; only after the
            // sync landed. The first reply counts as a change (the file for the
            // default the host picked has not been mirrored yet).
            if (result.success) {
              const outcome = noteHostDefault(syncSeq, result.data)
              // A stale reply never writes: the newer reply already carries the
              // effective default, and a second mirror could replace a file
              // update made in between.
              if (outcome !== 'stale' && (defaultChanged || outcome === 'changed')) {
                void useAcpStore.getState().syncMcpRegistryToProjectFile()
              }
            }
          })
          .catch((err: unknown) => {
            console.debug('[projects] remote sync failed', err)
          })
      }
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

    // Patch 15: evict the deleted project's entries from the manifest sync
    // store (basedRevision + restore-in-progress flags) so they don't leak.
    const syncStore = useWorkspaceManifestSyncStore.getState()
    syncStore.setBasedRevision(id, null)
    syncStore.setManifestRestoreInProgress(id, false)
    // Clear a pending conflict that belonged to the deleted project.
    if (syncStore.pendingConflict?.projectId === id) {
      syncStore.setPendingConflict(null)
    }

    // Cascade delete: remove terminal layout and snapshots for this project.
    // Story 6: also delete the host-owned workspace manifest (best-effort —
    // a failure is logged but never blocks the project delete; the host's
    // delete is idempotent whether or not the manifest file existed).
    await Promise.all([
      persistenceApi.delete(PersistenceKeys.terminals(id)),
      persistenceApi.delete(PersistenceKeys.snapshots(id)),
      workspaceManifestApi
        .deleteManifest(id)
        .then((result) => {
          if (!result.success) {
            console.warn(
              `[projects] manifest delete unsuccessful for ${id}: ${result.error} (${result.code})`
            )
          }
        })
        .catch((error) => {
          console.warn(`[projects] manifest delete threw for ${id}:`, error)
        })
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
