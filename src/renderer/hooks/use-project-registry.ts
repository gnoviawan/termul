import type { ProjectListPayload } from '@shared/types/web-projects.types'
import { useEffect } from 'react'
import { getAcpTransport } from '@/lib/acp-transport'
import { readActiveProject } from '@/lib/active-project'
import { filesystemApi } from '@/lib/api'
import { importLegacyProjects } from '@/lib/legacy-project-import'
import { logFrontendError } from '@/lib/log-api'
import { getProjectPrefs, loadProjectPrefs, persistProjectPrefs } from '@/lib/project-prefs'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useWebAuthGateOk } from '@/lib/web-auth-gate'
import { reconcileProjectWorktrees } from '@/lib/worktree-reconciler'
import { useAcpStore } from '@/stores/acp-store'
import { applyRegistryList } from '@/stores/project-registry-feed'
import { useProjectStore } from '@/stores/project-store'
import { useRemoteStatusStore } from '@/stores/remote-status-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'

function logFailure(source: string, message: string, error: unknown): void {
  void logFrontendError({
    level: 'warn',
    source: `use-project-registry.${source}`,
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`
  })
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
      const prefsReadable = await loadProjectPrefs().catch((error: unknown) => {
        logFailure('loadProjectPrefs', 'reading the project prefs failed', error)
        return false
      })
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

      if (prefsReadable) {
        unsubscribeStore = useProjectStore.subscribe((state, prevState) => {
          if (!state.isLoaded) return
          if (state.projects === prevState.projects && state.groups === prevState.groups) return
          persistProjectPrefs(state.projects, state.groups, prevState.projects).catch(
            (error: unknown) =>
              logFailure('persistProjectPrefs', 'saving the project prefs failed', error)
          )
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
