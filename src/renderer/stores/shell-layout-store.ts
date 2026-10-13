/**
 * Shell-layout store (shell revamp AD-4, CAP-16/CAP-18): the one persisted
 * owner of rail, side panel, SSH section and graph layout plus the per-project
 * last column tab and worktree pick.
 *
 * Persistence runs only through `persistenceApi` under `PersistenceKeys.shellLayout`
 * (the host store on every surface). A hydration gate protects the saved
 * record: nothing is written until the record has been read (or migrated), and
 * a store that could not read it (`unavailable`) stays usable in memory but
 * never writes, so defaults cannot overwrite a record that merely failed to load.
 *
 * No consumer reads this yet; the legacy stores keep driving the layout until
 * the later stories retarget them.
 */

import { PersistenceKeys } from '@shared/types/persistence.types'
import { create } from 'zustand'
import { editorStateKey } from '@/hooks/editor-persistence/types'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import {
  buildMigratedShellLayout,
  countLegacyShellLayoutSources,
  readLegacyShellLayoutSources
} from '@/lib/shell-layout-migration'
import {
  clampToBounds,
  defaultShellLayoutRecord,
  isShellLastColumnTab,
  SHELL_LAYOUT_BOUNDS,
  SHELL_LAYOUT_VERSION,
  type ShellLastColumnTab,
  type ShellLayoutRecord,
  sanitizeShellLayout
} from '@/lib/shell-layout-record'
import { normalizePath } from '@/lib/working-copy'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'

export {
  defaultShellLayoutRecord,
  SHELL_LAST_COLUMN_TABS,
  SHELL_LAYOUT_BOUNDS,
  SHELL_LAYOUT_VERSION,
  type ShellLastColumnTab,
  type ShellLayoutRecord,
  sanitizeShellLayout
} from '@/lib/shell-layout-record'

export type ShellLayoutStatus = 'idle' | 'hydrating' | 'ready' | 'unavailable'

interface ShellLayoutState extends ShellLayoutRecord {
  status: ShellLayoutStatus
  /** In-memory only: whether the graph is open. Never persisted. */
  graphOpen: boolean

  hydrate: () => Promise<void>
  setRailExpanded: (expanded: boolean) => void
  setRailWidth: (width: number) => void
  setSidePanelVisible: (visible: boolean) => void
  setSidePanelWidth: (width: number) => void
  setSshSectionVisible: (visible: boolean) => void
  setSshSectionHeight: (height: number) => void
  setGraphHeight: (height: number) => void
  setGraphOpen: (open: boolean) => void
  setLastColumnTab: (projectId: string, tab: ShellLastColumnTab) => void
  /** Stores `normalizePath(path)`; `null` clears the pick. */
  setWorktreePick: (projectId: string, path: string | null) => void
  /** Drops everything remembered for a Project that no longer exists. */
  removeProject: (projectId: string) => Promise<void>
}

const SOURCE = 'shell-layout-store'

function log(level: 'warn' | 'info', message: string): void {
  void logFrontendError({ level, source: SOURCE, message })
}

function logIgnored(action: string, status: ShellLayoutStatus): void {
  console.debug(`[shell] ${action} ignored while shell layout is ${status}`)
}

/** The persisted part of the state, in record shape. */
function snapshotOf(state: ShellLayoutRecord): ShellLayoutRecord {
  return {
    version: SHELL_LAYOUT_VERSION,
    railExpanded: state.railExpanded,
    railWidth: state.railWidth,
    sidePanelVisible: state.sidePanelVisible,
    sidePanelWidth: state.sidePanelWidth,
    sshSectionVisible: state.sshSectionVisible,
    sshSectionHeight: state.sshSectionHeight,
    graphHeight: state.graphHeight,
    lastColumnTabByProject: { ...state.lastColumnTabByProject },
    worktreePickByProject: { ...state.worktreePickByProject }
  }
}

function persistSnapshot(): void {
  const state = useShellLayoutStore.getState()
  if (state.status !== 'ready') return
  void persistenceApi
    .writeDebounced(PersistenceKeys.shellLayout, snapshotOf(state))
    .then((result) => {
      if (!result.success) {
        log('warn', `[shell] persist failed: ${result.code ?? 'UNKNOWN'}`)
      }
    })
    .catch(() => {
      log('warn', '[shell] persist failed: UNKNOWN')
    })
}

/** Applies `update` when the gate allows it, then persists when `ready`. */
function mutate(action: string, update: (state: ShellLayoutState) => Partial<ShellLayoutState>) {
  const { status } = useShellLayoutStore.getState()
  if (status !== 'ready' && status !== 'unavailable') {
    logIgnored(action, status)
    return
  }
  useShellLayoutStore.setState(update)
  persistSnapshot()
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map }
  delete next[key]
  return next
}

let hydration: Promise<void> | null = null

/** Projects removed before hydration finished; their entries are dropped as
 * soon as the store can apply it, so a legacy pick never outlives them. */
const pendingRemovedProjects = new Set<string>()

function withoutPendingRemovals(record: ShellLayoutRecord): ShellLayoutRecord {
  if (pendingRemovedProjects.size === 0) return record
  const lastColumnTabByProject = { ...record.lastColumnTabByProject }
  const worktreePickByProject = { ...record.worktreePickByProject }
  for (const projectId of pendingRemovedProjects) {
    delete lastColumnTabByProject[projectId]
    delete worktreePickByProject[projectId]
  }
  return { ...record, lastColumnTabByProject, worktreePickByProject }
}

/** Applies queued removals to the live state once hydration has settled. */
function flushPendingRemovals(): void {
  if (pendingRemovedProjects.size === 0) return
  const { lastColumnTabByProject, worktreePickByProject } = withoutPendingRemovals(
    snapshotOf(useShellLayoutStore.getState())
  )
  pendingRemovedProjects.clear()
  useShellLayoutStore.setState({ lastColumnTabByProject, worktreePickByProject })
  persistSnapshot()
}

async function runHydration(): Promise<void> {
  const set = useShellLayoutStore.setState
  set({ status: 'hydrating' })

  try {
    const result = await persistenceApi.read<unknown>(PersistenceKeys.shellLayout)

    if (result.success) {
      const version = (result.data as { version?: unknown } | null | undefined)?.version
      if (typeof version === 'number' && version > SHELL_LAYOUT_VERSION) {
        set({ status: 'unavailable' })
        flushPendingRemovals()
        log('warn', `[shell] unsupported shell-layout version ${version}; layout is not saved`)
        return
      }
      set({ ...sanitizeShellLayout(result.data), status: 'ready' })
      flushPendingRemovals()
      log('info', '[shell] shell layout hydrated')
      return
    }

    if (result.code !== 'KEY_NOT_FOUND') {
      set({ status: 'unavailable' })
      flushPendingRemovals()
      log('warn', `[shell] shell layout read failed (${result.code ?? 'UNKNOWN'}); not saved`)
      return
    }

    // No record yet: one-time carry-over from the legacy sources.
    const legacy = await readLegacyShellLayoutSources()
    // Dropped before the first write so a removed project's legacy pick is
    // never recorded.
    const migrated = withoutPendingRemovals(buildMigratedShellLayout(legacy))
    pendingRemovedProjects.clear()
    const counts = countLegacyShellLayoutSources(legacy)
    set({ ...migrated, status: 'ready' })

    const written = await persistenceApi.write(PersistenceKeys.shellLayout, migrated)
    if (written.success) {
      void logFrontendError({
        level: 'info',
        source: 'shell-layout-migration',
        message: `[shell-migrate] migrated (flags ${counts.flags}, sizes ${counts.widths}, picks ${counts.picks})`
      })
    } else {
      void logFrontendError({
        level: 'warn',
        source: 'shell-layout-migration',
        message: `[shell-migrate] write failed (${written.code ?? 'UNKNOWN'}); retried next launch`
      })
    }
  } catch (error) {
    // Only reachable while still gated; a ready store never throws here.
    if (useShellLayoutStore.getState().status !== 'ready') {
      set({ status: 'unavailable' })
    }
    flushPendingRemovals()
    log(
      'warn',
      `[shell] shell layout hydration failed: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

export const useShellLayoutStore = create<ShellLayoutState>((_set, get) => ({
  ...defaultShellLayoutRecord(),
  status: 'idle',
  graphOpen: true,

  hydrate: () => {
    if (hydration) return hydration
    if (get().status !== 'idle') return Promise.resolve()
    hydration = runHydration()
    return hydration
  },

  setRailExpanded: (expanded) => {
    if (typeof expanded !== 'boolean') return
    mutate('setRailExpanded', () => ({ railExpanded: expanded }))
  },
  setRailWidth: (width) =>
    mutate('setRailWidth', () => ({
      railWidth: clampToBounds(width, SHELL_LAYOUT_BOUNDS.railWidth)
    })),
  setSidePanelVisible: (visible) => {
    if (typeof visible !== 'boolean') return
    mutate('setSidePanelVisible', () => ({ sidePanelVisible: visible }))
  },
  setSidePanelWidth: (width) =>
    mutate('setSidePanelWidth', () => ({
      sidePanelWidth: clampToBounds(width, SHELL_LAYOUT_BOUNDS.sidePanelWidth)
    })),
  setSshSectionVisible: (visible) => {
    if (typeof visible !== 'boolean') return
    mutate('setSshSectionVisible', () => ({ sshSectionVisible: visible }))
  },
  setSshSectionHeight: (height) =>
    mutate('setSshSectionHeight', () => ({
      sshSectionHeight: clampToBounds(height, SHELL_LAYOUT_BOUNDS.sshSectionHeight)
    })),
  setGraphHeight: (height) =>
    mutate('setGraphHeight', () => ({
      graphHeight: clampToBounds(height, SHELL_LAYOUT_BOUNDS.graphHeight)
    })),
  setGraphOpen: (open) => {
    if (typeof open !== 'boolean') return
    // In-memory only: no persist, but gated like every other mutation.
    const { status } = get()
    if (status !== 'ready' && status !== 'unavailable') {
      logIgnored('setGraphOpen', status)
      return
    }
    useShellLayoutStore.setState({ graphOpen: open })
  },
  setLastColumnTab: (projectId, tab) => {
    // SSH is a mode, never a last tab: anything else is ignored.
    if (!projectId || projectId === '__proto__' || !isShellLastColumnTab(tab)) return
    mutate('setLastColumnTab', (state) => ({
      lastColumnTabByProject: { ...state.lastColumnTabByProject, [projectId]: tab }
    }))
  },
  setWorktreePick: (projectId, path) => {
    if (!projectId || projectId === '__proto__') return
    if (path === null) {
      mutate('setWorktreePick', (state) => ({
        worktreePickByProject: withoutKey(state.worktreePickByProject, projectId)
      }))
      return
    }
    const key = typeof path === 'string' ? normalizePath(path) : ''
    if (key === '') return
    mutate('setWorktreePick', (state) => ({
      worktreePickByProject: { ...state.worktreePickByProject, [projectId]: key }
    }))
  },

  removeProject: async (projectId) => {
    if (!projectId || projectId === '__proto__') return

    // Map entries follow the mutation gate; the rest is plain cleanup and
    // runs whatever the status, each step on its own so one failure cannot
    // stop the others.
    const state = get()
    if (state.status === 'idle' || state.status === 'hydrating') {
      pendingRemovedProjects.add(projectId)
    } else if (
      projectId in state.lastColumnTabByProject ||
      projectId in state.worktreePickByProject
    ) {
      mutate('removeProject', (current) => ({
        lastColumnTabByProject: withoutKey(current.lastColumnTabByProject, projectId),
        worktreePickByProject: withoutKey(current.worktreePickByProject, projectId)
      }))
    }

    try {
      useAgentChatLifetimeStore.getState().forgetProject(projectId)
    } catch {
      log('warn', '[shell] forgetting retained chats failed')
    }

    try {
      const result = await persistenceApi.delete(editorStateKey(projectId))
      if (!result.success && result.code !== 'KEY_NOT_FOUND') {
        log('warn', `[shell] workspace record cleanup failed: ${result.code ?? 'UNKNOWN'}`)
      }
    } catch {
      log('warn', '[shell] workspace record cleanup failed: UNKNOWN')
    }
  }
}))

/** @internal Test-only: back to the pre-hydration state. */
export function resetShellLayoutStoreForTests(): void {
  hydration = null
  pendingRemovedProjects.clear()
  useShellLayoutStore.setState({ ...defaultShellLayoutRecord(), status: 'idle', graphOpen: true })
}

export const useShellLayoutStatus = (): ShellLayoutStatus =>
  useShellLayoutStore((state) => state.status)
export const useRailExpanded = (): boolean => useShellLayoutStore((state) => state.railExpanded)
export const useRailWidth = (): number => useShellLayoutStore((state) => state.railWidth)
export const useSidePanelVisible = (): boolean =>
  useShellLayoutStore((state) => state.sidePanelVisible)
export const useSidePanelWidth = (): number => useShellLayoutStore((state) => state.sidePanelWidth)
export const useSshSectionVisible = (): boolean =>
  useShellLayoutStore((state) => state.sshSectionVisible)
export const useSshSectionHeight = (): number =>
  useShellLayoutStore((state) => state.sshSectionHeight)
export const useGraphHeight = (): number => useShellLayoutStore((state) => state.graphHeight)
export const useGraphOpen = (): boolean => useShellLayoutStore((state) => state.graphOpen)
export const useLastColumnTab = (projectId: string): ShellLastColumnTab | undefined =>
  useShellLayoutStore((state) => state.lastColumnTabByProject[projectId])
export const useWorktreePick = (projectId: string): string | undefined =>
  useShellLayoutStore((state) => state.worktreePickByProject[projectId])
