import { useEffect, useRef } from 'react'
import { useTerminalStore } from '../stores/terminal-store'
import { persistenceApi } from '@/lib/api'
import { useProjectStore } from '../stores/project-store'
import type { Terminal } from '@/types/project'
import type {
  PersistedTerminal,
  PersistedTerminalLayout
} from '../../shared/types/persistence.types'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import { extractScrollback } from '../utils/terminal-registry'

const terminalRestoreProjectsInProgress = new Map<string, string>()

export function setTerminalRestoreInProgress(
  projectId: string,
  isRestoring: boolean,
  ownerId: string
): void {
  if (!projectId || !ownerId) {
    return
  }

  if (isRestoring) {
    terminalRestoreProjectsInProgress.set(projectId, ownerId)
    return
  }

  if (terminalRestoreProjectsInProgress.get(projectId) === ownerId) {
    terminalRestoreProjectsInProgress.delete(projectId)
  }
}

export function isTerminalRestoreInProgress(): boolean {
  return terminalRestoreProjectsInProgress.size > 0
}

/**
 * Sync extracted scrollback to the terminal store
 * Updates each terminal's pendingScrollback field in memory
 * Skips terminals where scrollback extraction returns undefined
 */
export function syncScrollbackToStore(terminals: PersistedTerminal[]): void {
  const store = useTerminalStore.getState()
  for (const t of terminals) {
    // Skip if scrollback is undefined (terminal not in registry)
    if (t.scrollback === undefined) continue
    store.updateTerminalScrollback(t.id, t.scrollback)
  }
}

/**
 * Serialize terminal store state for persistence
 * Includes scrollback extraction from terminal registry
 */
export function serializeTerminalsForProject(
  terminals: Terminal[],
  projectId: string,
  activeTerminalId: string
): PersistedTerminalLayout {
  const projectTerminals = terminals.filter((t) => t.projectId === projectId)

  return {
    activeTerminalId: projectTerminals.find((t) => t.id === activeTerminalId)?.id ?? null,
    terminals: projectTerminals.map(
      (t): PersistedTerminal => ({
        id: t.id,
        name: t.name,
        shell: t.shell,
        cwd: t.cwd,
        scrollback: extractScrollback(t.ptyId ?? t.id)
      })
    ),
    updatedAt: new Date().toISOString()
  }
}

/**
 * Hook to auto-save terminal layout for the active project
 * Subscribes to terminal store changes and triggers debounced writes
 */
export function useTerminalAutoSave(): void {
  const hasInitialized = useRef(false)
  const activeProjectIdRef = useRef<string>('')
  const activeProjectId = useProjectStore((state) => state.activeProjectId)

  // Keep ref in sync with current activeProjectId
  activeProjectIdRef.current = activeProjectId

  useEffect(() => {
    // Subscribe to terminal store changes
    const unsubscribe = useTerminalStore.subscribe((state, prevState) => {
      // Skip the first state change (from restore)
      if (!hasInitialized.current) {
        hasInitialized.current = true
        return
      }

      // Only save if terminals or activeTerminalId changed
      if (
        state.terminals === prevState.terminals &&
        state.activeTerminalId === prevState.activeTerminalId
      ) {
        return
      }

      // Skip activity-only changes (hasActivity/lastActivityTimestamp)
      // These create new array refs but don't affect persisted layout
      if (state.activeTerminalId === prevState.activeTerminalId) {
        const hasStructuralChange = state.terminals.some((t, i) => {
          const prev = prevState.terminals[i]
          if (!prev) return true
          return (
            t.id !== prev.id ||
            t.name !== prev.name ||
            t.shell !== prev.shell ||
            t.cwd !== prev.cwd ||
            t.projectId !== prev.projectId
          )
        }) || state.terminals.length !== prevState.terminals.length

        if (!hasStructuralChange) {
          return
        }
      }

      if (isTerminalRestoreInProgress()) {
        return
      }

      // Only save if we have an active project (use ref to avoid stale closure)
      const projectId = activeProjectIdRef.current
      if (!projectId) {
        return
      }

      const layout = serializeTerminalsForProject(
        state.terminals,
        projectId,
        state.activeTerminalId
      )

      // Sync scrollback to store before debounced write
      syncScrollbackToStore(layout.terminals)

      // Use debounced write via API
      persistenceApi
        .writeDebounced(PersistenceKeys.terminals(projectId), layout)
        .catch((err: unknown) => {
          console.error('Failed to auto-save terminal layout:', err)
        })
    })

    return () => {
      unsubscribe()
    }
  }, [])
}

/**
 * Load persisted terminals for a project
 * Returns null if no persisted data exists
 */
export async function loadPersistedTerminals(
  projectId: string
): Promise<PersistedTerminalLayout | null> {
  const result = await persistenceApi.read<PersistedTerminalLayout>(
    PersistenceKeys.terminals(projectId)
  )

  if (result.success) {
    return result.data
  }

  // FILE_NOT_FOUND is expected for new projects
  if (result.code === 'FILE_NOT_FOUND') {
    return null
  }

  console.error('Failed to load terminal layout:', result.error)
  return null
}

/**
 * Manually trigger a save of the current terminal layout
 * Useful for ensuring save before app quit
 */
export async function saveTerminalLayout(projectId: string): Promise<void> {
  const state = useTerminalStore.getState()
  const layout = serializeTerminalsForProject(state.terminals, projectId, state.activeTerminalId)

  // Sync scrollback to store before writing to disk
  syncScrollbackToStore(layout.terminals)

  const result = await persistenceApi.write(PersistenceKeys.terminals(projectId), layout)

  if (!result.success) {
    console.error('Failed to save terminal layout:', result.error)
  }
}
