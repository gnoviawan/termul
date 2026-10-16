import type { ProjectListPayload } from '@shared/types/web-projects.types'
import { useEffect } from 'react'
import { getAcpTransport } from '@/lib/acp-transport'
import { readActiveProject } from '@/lib/active-project'
import { filesystemApi } from '@/lib/api'
import { importLegacyProjects } from '@/lib/legacy-project-import'
import { logFrontendError } from '@/lib/log-api'
import {
  getProjectLayout,
  getProjectPrefs,
  loadProjectPrefs,
  persistProjectPrefs
} from '@/lib/project-prefs'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useWebAuthGateOk } from '@/lib/web-auth-gate'
import { reconcileProjectWorktrees } from '@/lib/worktree-reconciler'
import { useAcpStore } from '@/stores/acp-store'
import { applyRegistryList } from '@/stores/project-registry-feed'
import { useProjectStore } from '@/stores/project-store'
import { useRemoteStatusStore } from '@/stores/remote-status-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'

function logFailure(source: string, message: string, error: unknown): void {
  void logFrontendError({
    level: 'warn',
    source: `use-project-registry.${source}`,
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`
  })
}

/**
 * Waits between boot-time reads of the project prefs. The host store can still
 * be starting, and one failed read must not turn saving off for the session.
 */
const PREFS_READ_RETRY_MS = [300, 1000, 3000]

/**
 * Read the prefs before the first state is applied, retrying a failed read a
 * few times. A record that stays unreadable returns `false`: the list still
 * comes from the host, but nothing is saved over the record.
 */
async function loadProjectPrefsWithRetry(isCancelled: () => boolean): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const readable = await loadProjectPrefs().catch((error: unknown) => {
      logFailure('loadProjectPrefs', 'reading the project prefs failed', error)
      return false
    })
    if (readable || isCancelled()) return readable
    if (attempt >= PREFS_READ_RETRY_MS.length) {
      logFailure(
        'loadProjectPrefs',
        'project prefs stayed unreadable, saves are off for this session',
        'retries exhausted'
      )
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, PREFS_READ_RETRY_MS[attempt]))
    // A hook unmounted during the delay must not reload the shared prefs.
    if (isCancelled()) return false
  }
}

/** How often a prefs record that could not be read is read again. */
const PREFS_RECOVERY_MS = 5000

/**
 * Read the prefs again until the record reads, then resolve `true`. Resolves
 * `false` once the hook is gone.
 */
async function recoverProjectPrefs(isCancelled: () => boolean): Promise<boolean> {
  while (!isCancelled()) {
    await new Promise((resolve) => setTimeout(resolve, PREFS_RECOVERY_MS))
    if (isCancelled()) return false
    const readable = await loadProjectPrefs().catch(() => false)
    if (readable) return true
  }
  return false
}

/**
 * Bring the saved layout and client-only fields into the store once the prefs
 * read again. Groups the store already has keep their state, and a project
 * field the store already set (changed while unreadable) wins over the saved one.
 */
function mergeRecoveredPrefs(): void {
  const { groups: saved } = getProjectLayout()
  const state = useProjectStore.getState()
  const knownGroups = new Set(state.groups.map((group) => group.id))
  const missingGroups = saved.filter((group) => !knownGroups.has(group.id))
  const projects = state.projects.map((project) => {
    const savedFields = getProjectPrefs(project.id)
    if (!savedFields) return project
    const fill = Object.fromEntries(
      Object.entries(savedFields).filter(
        ([key, value]) => value !== undefined && project[key as keyof Project] === undefined
      )
    )
    return { ...project, ...fill }
  })
  useProjectStore.setState({ groups: [...state.groups, ...missingGroups], projects })
}

/**
 * Re-grant the Tauri fs scope for project roots and their worktrees the host
 * lists: the dialog plugin's pick-time grant dies with the process, and the
 * static capability only allowlists specific drives, so projects elsewhere
 * would fail the explorer with "forbidden path". Desktop only; a path is
 * granted once.
 */
async function grantProjectScopes(list: ProjectListPayload, granted: Set<string>): Promise<void> {
  const paths = new Set<string>()
  for (const summary of list.projects) {
    if (summary.path) paths.add(summary.path)
    for (const worktree of getProjectPrefs(summary.id)?.worktrees ?? []) {
      if (worktree.path) paths.add(worktree.path)
    }
  }
  const fresh = [...paths].filter((path) => !granted.has(path))
  if (fresh.length === 0) return
  const grant = await filesystemApi.grantFsScope(fresh)
  if (grant.success) {
    for (const path of fresh) granted.add(path)
  } else {
    logFailure('grantFsScope', 'fs scope grant failed', grant.error)
  }
}

/**
 * Boot wiring of the project list, mounted on both renderer roots
 * (`App.tsx`, `TauriApp.tsx`). The browser and the desktop do the same thing:
 *
 * - the store is fed only by the host's `projects` watch (full state on every
 *   subscribe, the replacement list on each change);
 * - the renderer-owned prefs (`project-prefs`) are loaded before the first
 *   state is applied and saved whenever the store changes;
 * - the desktop first migrates its old `projects` record to the host once
 *   (`importLegacyProjects`); a web client never does.
 *
 * Navigation is not here: a project switch writes only the device
 * `active-project` key (`selectProject`).
 */
export function useProjectRegistry(): void {
  // #854: while the web auth gate reports unauthorized, the host refuses the
  // socket and the watch must not be asked for; it starts once the gate is ok.
  const webAuthGateOk = useWebAuthGateOk()

  useEffect(() => {
    if (!isTauriContext() && !webAuthGateOk) return

    let cancelled = false
    let unwatch: (() => void) | undefined
    let unsubscribeStore: (() => void) | undefined

    async function start(): Promise<void> {
      if (isTauriContext()) {
        await importLegacyProjects(() => useShellLayoutStore.getState().hydrate()).catch(
          (error: unknown) => logFailure('import', 'the project import threw', error)
        )
      }
      const prefsReadable = await loadProjectPrefsWithRetry(() => cancelled)
      const savedActiveProjectId = await readActiveProject().catch(() => null)
      if (cancelled) return

      const granted = new Set<string>()
      let lastDefaultProjectId: string | null | undefined
      let queued: ProjectListPayload | null = null
      let draining = false

      async function applyOne(list: ProjectListPayload): Promise<void> {
        if (isTauriContext()) await grantProjectScopes(list, granted)
        if (cancelled) return
        const firstState = !useProjectStore.getState().isLoaded
        applyRegistryList(list, savedActiveProjectId)
        if (firstState) {
          for (const project of useProjectStore.getState().projects) {
            if (project.path) void reconcileProjectWorktrees(project.id)
          }
        }
        // CAP-7 interim bridge: the host MCP file follows the host default, so
        // mirror the MCP registry when the default moves while shared-live runs.
        if (
          lastDefaultProjectId !== undefined &&
          lastDefaultProjectId !== list.defaultProjectId &&
          useRemoteStatusStore.getState().status?.running
        ) {
          void useAcpStore
            .getState()
            .syncMcpRegistryToProjectFile(useProjectStore.getState().activeProjectId)
        }
        lastDefaultProjectId = list.defaultProjectId
      }

      // States and deltas both carry the whole list, so only the newest
      // matters: a list that arrives while one is being applied replaces the
      // queued one.
      async function drain(): Promise<void> {
        draining = true
        try {
          while (queued && !cancelled) {
            const list = queued
            queued = null
            await applyOne(list).catch((error: unknown) =>
              logFailure('apply', 'applying the project list failed', error)
            )
          }
        } finally {
          draining = false
        }
      }

      const onList = (list: ProjectListPayload): void => {
        if (!Array.isArray(list?.projects)) return
        queued = list
        if (!draining) void drain()
      }

      const watches = getAcpTransport().watches
      if (!watches) {
        logFailure('watch', 'the transport has no watches', 'unavailable')
      } else {
        unwatch = watches.subscribe<ProjectListPayload, ProjectListPayload>('projects', {
          onState: onList,
          onDelta: onList
        })
      }

      const installSaves = (): void => {
        unsubscribeStore = useProjectStore.subscribe((state, prevState) => {
          if (!state.isLoaded) return
          if (state.projects === prevState.projects && state.groups === prevState.groups) return
          persistProjectPrefs(state.projects, state.groups, prevState.projects).catch(
            (error: unknown) =>
              logFailure('persistProjectPrefs', 'saving the project prefs failed', error)
          )
        })
      }
      if (prefsReadable) {
        installSaves()
      } else {
        // Keep trying in the background: a store that was slow at boot must not
        // leave every group of this session unsaved. Once the record reads, the
        // groups it holds join the store and the current state is saved.
        void recoverProjectPrefs(() => cancelled).then((recovered) => {
          if (!recovered || cancelled) return
          mergeRecoveredPrefs()
          installSaves()
          const state = useProjectStore.getState()
          if (state.isLoaded) {
            persistProjectPrefs(state.projects, state.groups, []).catch((error: unknown) =>
              logFailure('persistProjectPrefs', 'saving the recovered project prefs failed', error)
            )
          }
        })
      }
    }

    void start()
    return () => {
      cancelled = true
      unwatch?.()
      unsubscribeStore?.()
    }
  }, [webAuthGateOk])
}
