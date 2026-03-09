import { useEffect, useRef } from 'react'
import { useProjectStore } from '../stores/project-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useAppSettingsStore } from '../stores/app-settings-store'
import { useWorkspaceStore, terminalTabId } from '../stores/workspace-store'
import { terminalApi } from '@/lib/api'
import { shellApi } from '@/lib/shell-api'
import {
  loadPersistedTerminals,
  saveTerminalLayout,
  setTerminalRestoreInProgress
} from './useTerminalAutoSave'
import type { PersistedTerminalLayout } from '../../shared/types/persistence.types'

const PROJECT_RESTORE_LOCKS = new Set<string>()
const TERMINALS_PENDING_PTY_ASSIGNMENT = new Set<string>()

export function isTerminalPendingPtyAssignment(terminalStoreId: string): boolean {
  return TERMINALS_PENDING_PTY_ASSIGNMENT.has(terminalStoreId)
}

// DEBUG: Track spawn calls globally
const SPAWN_TRACKER = new Map<string, number>()
const RESTORE_CALL_STACK: string[] = []

// CRITICAL: Global spawn lock with owner tracking to prevent race conditions
let GLOBAL_SPAWN_LOCK_OWNER: string | null = null
let SPAWN_CALL_COUNT = 0
const MAX_SPAWN_LIMIT = 50 // Safety limit

/**
 * Acquire the global spawn lock
 * @returns true if lock was acquired, false if already held by another caller
 */
function acquireGlobalSpawnLock(ownerId: string): boolean {
  if (GLOBAL_SPAWN_LOCK_OWNER !== null) {
    debugLog('SPAWN_LOCK', `LOCK ACQUIRE FAILED [${ownerId}]`, {
      owner: GLOBAL_SPAWN_LOCK_OWNER
    })
    return false
  }
  GLOBAL_SPAWN_LOCK_OWNER = ownerId
  debugLog('SPAWN_LOCK', `LOCK ACQUIRED [${ownerId}]`)
  return true
}

/**
 * Release the global spawn lock
 * @param ownerId The caller ID attempting to release
 */
function releaseGlobalSpawnLock(ownerId: string): void {
  if (GLOBAL_SPAWN_LOCK_OWNER === ownerId) {
    GLOBAL_SPAWN_LOCK_OWNER = null
    debugLog('SPAWN_LOCK', `LOCK RELEASED [${ownerId}]`)
  } else {
    debugLog('SPAWN_LOCK', `LOCK RELEASE FAILED [${ownerId}] - owned by ${GLOBAL_SPAWN_LOCK_OWNER}`)
  }
}

const IS_DEV = import.meta.env.DEV

function debugLog(category: string, message: string, data?: unknown) {
  if (!IS_DEV) return
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 12)
  const prefix = `[${timestamp}] [${category}]`
  if (data) {
    console.log(prefix, message, data)
  } else {
    console.log(prefix, message)
  }
}

// Summary interval tracker
let summaryInterval: ReturnType<typeof setInterval> | null = null

export function printTerminalSummary(): void {
  const terminalStore = useTerminalStore.getState()
  const projectStore = useProjectStore.getState()

  console.log('═══════════════════════════════════════════════════════════════')
  console.log('[TERMINAL SPAWN TRACKER SUMMARY]', {
    timestamp: new Date().toISOString(),
    totalTerminalsInStore: terminalStore.terminals.length,
    terminalsByProject: terminalStore.terminals.reduce((acc, t) => {
      acc[t.projectId] = (acc[t.projectId] || 0) + 1
      return acc
    }, {} as Record<string, number>),
    activeProjectId: projectStore.activeProjectId,
    spawnTrackerEntries: Array.from(SPAWN_TRACKER.entries()),
    restoreLocks: Array.from(PROJECT_RESTORE_LOCKS),
    restoreCallStack: [...RESTORE_CALL_STACK],
    terminalsWithPtyId: terminalStore.terminals.filter(t => t.ptyId).length,
    terminalsWithoutPtyId: terminalStore.terminals.filter(t => !t.ptyId).length
  })
  console.log('═══════════════════════════════════════════════════════════════')
}

export function startPeriodicSummary(intervalMs: number = 5000): () => void {
  if (summaryInterval) clearInterval(summaryInterval)
  summaryInterval = setInterval(printTerminalSummary, intervalMs)
  return () => {
    if (summaryInterval) {
      clearInterval(summaryInterval)
      summaryInterval = null
    }
  }
}

// Make summary available globally for debugging
if (typeof window !== 'undefined' && IS_DEV) {
  ;(window as unknown as Record<string, unknown>).__TERMUL_DEBUG__ = {
    printTerminalSummary,
    startPeriodicSummary,
    SPAWN_TRACKER,
    PROJECT_RESTORE_LOCKS,
    RESTORE_CALL_STACK,
    get GLOBAL_SPAWN_LOCK_OWNER() {
      return GLOBAL_SPAWN_LOCK_OWNER
    },
    SPAWN_CALL_COUNT,
    MAX_SPAWN_LIMIT,
    resetSpawnCount: () => {
      SPAWN_CALL_COUNT = 0
      GLOBAL_SPAWN_LOCK_OWNER = null
    }
  }
}

export function normalizeShellForStartup(shell?: string): string {
  const fallback = 'powershell'
  if (!shell) return fallback

  if (typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined') {
    const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.platform)
    if (isWindows) {
      const normalized = shell.trim().toLowerCase()
      if (normalized === 'cmd' || normalized === 'cmd.exe') {
        return fallback
      }
    }
  }

  return shell
}

/**
 * Resolve shell identifier to an absolute path.
 * If the shell is already a path (contains \ or /), return it as-is.
 * If it's just a name (e.g., "pwsh", "bash"), look up the path from available shells.
 * Also matches by executable basename (e.g., "pwsh.exe" matches shell with path ending in "pwsh.exe").
 */
async function resolveShellToPath(shell: string): Promise<string> {
  // If shell is already a path, return it as-is
  if (shell.includes('\\') || shell.includes('/')) {
    return shell
  }

  // Otherwise, look up the path from available shells
  try {
    const result = await shellApi.getAvailableShells()
    if (result.success && result.data.available) {
      // Match by name or by executable basename
      const match = result.data.available.find((s) => {
        if (s.name === shell) return true
        // Also match by basename of path (e.g., "pwsh.exe" matches "C:\...\pwsh.exe")
        const pathBasename = s.path.split(/[\\/]/).pop()
        return pathBasename === shell
      })
      if (match) {
        return match.path
      }
    }
  } catch (error) {
    console.error('Failed to resolve shell path:', error)
  }

  // Fallback: return original value
  return shell
}

/**
 * Hook to restore terminals when switching projects
 * Loads persisted terminal layout and creates terminal instances
 */
export function useTerminalRestore(): void {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const previousProjectIdRef = useRef<string>('')
  // FIX #4: Use Set instead of boolean to track multiple restoring projects
  const isRestoringRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const callId = Math.random().toString(36).slice(2, 9)
    RESTORE_CALL_STACK.push(callId)

    debugLog('useTerminalRestore', `EFFECT RUN [callId: ${callId}]`, {
      activeProjectId,
      previousProjectId: previousProjectIdRef.current,
      isRestoring: Array.from(isRestoringRef.current),
      hasLock: PROJECT_RESTORE_LOCKS.has(activeProjectId || ''),
      locks: Array.from(PROJECT_RESTORE_LOCKS),
      callStack: [...RESTORE_CALL_STACK]
    })

    // Skip if no project selected or same project
    if (!activeProjectId || activeProjectId === previousProjectIdRef.current) {
      debugLog('useTerminalRestore', `SKIPPED [${callId}]: no project or same project`)
      return
    }

    // FIX #4: Check if this specific project is already being restored
    if (isRestoringRef.current.has(activeProjectId) || PROJECT_RESTORE_LOCKS.has(activeProjectId)) {
      debugLog('useTerminalRestore', `SKIPPED [${callId}]: already restoring`, {
        isRestoring: Array.from(isRestoringRef.current),
        hasLock: PROJECT_RESTORE_LOCKS.has(activeProjectId)
      })
      return
    }

    // Set flag immediately to prevent race condition
    isRestoringRef.current.add(activeProjectId)
    PROJECT_RESTORE_LOCKS.add(activeProjectId)
    const projectIdToRestore = activeProjectId
    setTerminalRestoreInProgress(projectIdToRestore, true)

    debugLog('useTerminalRestore', `STARTING RESTORE [${callId}]`, {
      projectId: projectIdToRestore
    })

    // FIX #3: Capture ACTUAL previous project ID BEFORE overwriting the ref
    // This is critical for the PTY cleanup logic below
    const actualPreviousProjectId = previousProjectIdRef.current

    // FIX #3: Move previousProjectIdRef update BEFORE async to prevent rapid switch bugs
    previousProjectIdRef.current = projectIdToRestore

    // FIX #5: Add cancellation token to handle cleanup properly
    let cancelled = false
    const cancelRestore = () => { cancelled = true }
    const isCancelled = (): boolean => cancelled || previousProjectIdRef.current !== projectIdToRestore

    const restoreTerminals = async (): Promise<void> => {
      try {
        // Check for cancellation before starting
        if (isCancelled()) {
          debugLog('useTerminalRestore', `CANCELLED [${callId}] before restore`)
          return
        }

        if (actualPreviousProjectId && actualPreviousProjectId !== projectIdToRestore) {
          await saveTerminalLayout(actualPreviousProjectId)
        }

        if (isCancelled()) {
          debugLog('useTerminalRestore', `CANCELLED [${callId}] after save`)
          return
        }

        const terminalStore = useTerminalStore.getState()
        const existingTerminals = terminalStore.terminals.filter(
          (t) => t.projectId === projectIdToRestore
        )
        const liveProjectTerminals = existingTerminals.filter((terminal) => !!terminal.ptyId)

        if (liveProjectTerminals.length > 0) {
          const layout = await loadPersistedTerminals(projectIdToRestore)
          if (isCancelled()) {
            debugLog('useTerminalRestore', `CANCELLED [${callId}] after live layout load`)
            return
          }

          const workspaceStore = useWorkspaceStore.getState()
          const terminalIdToSelect = selectTerminalForProject(
            liveProjectTerminals,
            layout
          )

          for (const terminal of liveProjectTerminals) {
            workspaceStore.ensureTerminalTab(
              terminal.id,
              undefined,
              terminal.id === terminalIdToSelect
            )
          }

          if (isCancelled()) {
            debugLog('useTerminalRestore', `CANCELLED [${callId}] before workspace selection`)
            return
          }

          const activePane = workspaceStore.getActivePaneLeaf()
          if (terminalIdToSelect && activePane) {
            workspaceStore.setActiveTab(activePane.id, terminalTabId(terminalIdToSelect))
          }
          return
        }

        // No terminals in memory - load from disk or create default
        const layout = await loadPersistedTerminals(projectIdToRestore)
        if (isCancelled()) {
          debugLog('useTerminalRestore', `CANCELLED [${callId}] after persisted layout load`)
          return
        }

        if (layout && layout.terminals.length > 0) {
          await restoreFromLayout(projectIdToRestore, layout)
        } else {
          await createDefaultTerminal(projectIdToRestore)
        }
      } catch (err: unknown) {
        debugLog('useTerminalRestore', `RESTORE ERROR [${callId}]`, {
          error: err instanceof Error ? err.message : String(err)
        })
        console.error('Failed to restore terminals:', err)
        if (isCancelled()) {
          debugLog('useTerminalRestore', `CANCELLED [${callId}] after error`)
          return
        }
        // Fall back to default terminal
        await createDefaultTerminal(projectIdToRestore)
      } finally {
        // Only clean up if this restore was not cancelled
        if (!cancelled && isRestoringRef.current.has(projectIdToRestore) && PROJECT_RESTORE_LOCKS.has(projectIdToRestore)) {
          debugLog('useTerminalRestore', `RESTORE COMPLETE [${callId}]`, {
            projectId: projectIdToRestore
          })
          isRestoringRef.current.delete(projectIdToRestore)
          PROJECT_RESTORE_LOCKS.delete(projectIdToRestore)
          setTerminalRestoreInProgress(projectIdToRestore, false)
          const idx = RESTORE_CALL_STACK.indexOf(callId)
          if (idx > -1) RESTORE_CALL_STACK.splice(idx, 1)
        } else if (cancelled) {
          debugLog('useTerminalRestore', `CLEANUP CANCELLED [${callId}]`, {
            projectId: projectIdToRestore
          })
          isRestoringRef.current.delete(projectIdToRestore)
          PROJECT_RESTORE_LOCKS.delete(projectIdToRestore)
          setTerminalRestoreInProgress(projectIdToRestore, false)
        }
      }
    }

    restoreTerminals()

    // CRITICAL: Cleanup function to handle project switching mid-restore
    // Capture projectId at effect run time to avoid stale closure in cleanup
    const projectIdForCleanup = activeProjectId
    return () => {
      // Signal cancellation to the async function
      cancelRestore()

      // If this effect is being cleaned up (project changed), remove the call from stack
      const idx = RESTORE_CALL_STACK.indexOf(callId)
      if (idx > -1) RESTORE_CALL_STACK.splice(idx, 1)

      // FIX #5: Also clean up the restoring flag for this project on cleanup
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Ref access in cleanup is intentional
      isRestoringRef.current.delete(projectIdForCleanup)
      PROJECT_RESTORE_LOCKS.delete(projectIdForCleanup)
      setTerminalRestoreInProgress(projectIdForCleanup, false)
    }
  }, [activeProjectId])
}

/**
 * Select the appropriate terminal for a project
 * Uses multiple matching strategies: ID match, then name match, then fallback
 */
function selectTerminalForProject(
  existingTerminals: Array<{ id: string; name: string; projectId: string }>,
  layout: PersistedTerminalLayout | null
): string | null {
  if (existingTerminals.length === 0) {
    return null
  }

  let terminalIdToSelect: string | null = null

  if (layout?.activeTerminalId) {
    // Strategy 1: Direct ID match (terminals stayed in memory with same IDs)
    const directMatch = existingTerminals.find(
      (t) => t.id === layout.activeTerminalId
    )
    if (directMatch) {
      terminalIdToSelect = directMatch.id
    } else {
      // Strategy 2: Match by name (IDs regenerated but names preserved)
      const persistedActive = layout.terminals.find(
        (pt) => pt.id === layout.activeTerminalId
      )
      if (persistedActive) {
        const nameMatch = existingTerminals.find(
          (t) => t.name === persistedActive.name
        )
        if (nameMatch) {
          terminalIdToSelect = nameMatch.id
        }
      }
    }
  }

  // Fallback: select first terminal for this project
  if (!terminalIdToSelect) {
    terminalIdToSelect = existingTerminals[0].id
  }

  return terminalIdToSelect
}

/**
 * Restore terminals from persisted layout (only when no terminals exist in memory)
 */
async function restoreFromLayout(projectId: string, layout: PersistedTerminalLayout): Promise<void> {
  const restoreId = `restore-${Math.random().toString(36).slice(2, 7)}`

  // FIX #2: Use proper lock acquire/release with owner tracking
  if (!acquireGlobalSpawnLock(restoreId)) {
    debugLog('restoreFromLayout', `BLOCKED [${restoreId}] Global spawn lock is active!`)
    return
  }

  if (SPAWN_CALL_COUNT >= MAX_SPAWN_LIMIT) {
    debugLog('restoreFromLayout', `BLOCKED [${restoreId}] Spawn limit exceeded`, {
      count: SPAWN_CALL_COUNT,
      limit: MAX_SPAWN_LIMIT
    })
    releaseGlobalSpawnLock(restoreId)
    return
  }

  try {
    const terminalStore = useTerminalStore.getState()

    debugLog('restoreFromLayout', `START [${restoreId}] ACQUIRING LOCK`, {
      projectId,
      terminalCount: layout.terminals.length,
      existingTerminalsCount: terminalStore.terminals.filter((t) => t.projectId === projectId).length,
      allTerminalsCount: terminalStore.terminals.length,
      spawnCallCount: SPAWN_CALL_COUNT
    })

  // Create all terminals at once to avoid multiple re-renders
  const newTerminals: Array<{
    id: string
    name: string
    projectId: string
    shell: string
    cwd?: string
    output: never[]
    pendingScrollback?: string[]
    ptyId?: string
  }> = []

  // Map old IDs to new IDs for active terminal selection and pane remapping
  const idMap = new Map<string, string>()

  for (const persistedTerminal of layout.terminals) {
    const terminalCallId = `${restoreId}-${persistedTerminal.name}-${Math.random().toString(36).slice(2, 5)}`
    SPAWN_TRACKER.set(terminalCallId, (SPAWN_TRACKER.get(terminalCallId) || 0) + 1)

    debugLog('restoreFromLayout', `Spawning terminal [${terminalCallId}]`, {
      name: persistedTerminal.name,
      shell: persistedTerminal.shell,
      cwd: persistedTerminal.cwd,
      spawnCount: SPAWN_TRACKER.get(terminalCallId)
    })

    const newId = Date.now().toString() + Math.random().toString(36).slice(2, 5)
    TERMINALS_PENDING_PTY_ASSIGNMENT.add(newId)

    try {
      const resolvedShell = await resolveShellToPath(persistedTerminal.shell)
      const normalizedShell = normalizeShellForStartup(resolvedShell)
      const spawnResult = await terminalApi.spawn({
        shell: normalizedShell,
        cwd: persistedTerminal.cwd
      })

      debugLog('restoreFromLayout', `Spawn result [${terminalCallId}]`, {
        success: spawnResult.success,
        error: spawnResult.success ? undefined : spawnResult.error,
        ptyId: spawnResult.success ? spawnResult.data.id : 'FAILED'
      })

      if (!spawnResult.success) {
        debugLog('restoreFromLayout', `Spawn FAILED, skipping [${terminalCallId}]`)
        continue
      }

      // FIX #6: Increment SPAWN_CALL_COUNT for each successful spawn in the loop
      SPAWN_CALL_COUNT++

      idMap.set(persistedTerminal.id, newId)
      newTerminals.push({
        id: newId,
        name: persistedTerminal.name,
        projectId,
        shell: normalizedShell,
        cwd: persistedTerminal.cwd,
        output: [],
        pendingScrollback: persistedTerminal.scrollback,
        ptyId: spawnResult.data.id
      })
    } finally {
      TERMINALS_PENDING_PTY_ASSIGNMENT.delete(newId)
    }
  }

  // Add all terminals at once
  const existingTerminals = terminalStore.terminals
  terminalStore.setTerminals([...existingTerminals, ...newTerminals])

  if (idMap.size > 0) {
    useWorkspaceStore.getState().remapTerminalTabs(Object.fromEntries(idMap))
  }

  // Determine which terminal should be active
  let activeId = newTerminals[0]?.id || ''
  if (layout.activeTerminalId && idMap.has(layout.activeTerminalId)) {
    activeId = idMap.get(layout.activeTerminalId)!
  }

  // Select the active terminal
  if (activeId) {
    terminalStore.selectTerminal(activeId)
  }

  // CRITICAL: Get fresh state after mutations for accurate logging
  const freshTerminalStore = useTerminalStore.getState()

  debugLog('restoreFromLayout', `COMPLETE [${restoreId}]`, {
    terminalsCreated: newTerminals.length,
    totalTerminalsInStore: freshTerminalStore.terminals.length,
    terminalIds: freshTerminalStore.terminals.map(t => ({ id: t.id, ptyId: t.ptyId })),
    spawnTrackerEntries: SPAWN_TRACKER.size,
    totalSpawnCalls: SPAWN_CALL_COUNT
  })
  } finally {
    // FIX #2: Always release the global spawn lock
    releaseGlobalSpawnLock(restoreId)
    debugLog('restoreFromLayout', `RELEASED LOCK [${restoreId}]`, {
      totalSpawnCalls: SPAWN_CALL_COUNT
    })
  }
}

/**
 * Create a default terminal when no persisted data exists
 */
async function createDefaultTerminal(projectId: string): Promise<void> {
  const defaultId = `default-${Math.random().toString(36).slice(2, 7)}`

  // FIX #2: Use proper lock acquire/release with owner tracking
  if (!acquireGlobalSpawnLock(defaultId)) {
    debugLog('createDefaultTerminal', `BLOCKED [${defaultId}] Global spawn lock is active`)
    return
  }

  if (SPAWN_CALL_COUNT >= MAX_SPAWN_LIMIT) {
    debugLog('createDefaultTerminal', `BLOCKED [${defaultId}] Spawn limit exceeded`, {
      count: SPAWN_CALL_COUNT,
      limit: MAX_SPAWN_LIMIT
    })
    releaseGlobalSpawnLock(defaultId)
    return
  }

  try {
    const terminalStore = useTerminalStore.getState()
    const projectStore = useProjectStore.getState()
    const appSettings = useAppSettingsStore.getState()

    debugLog('createDefaultTerminal', `START [${defaultId}] ACQUIRING LOCK`, {
      projectId,
      existingTerminals: terminalStore.terminals.filter((t) => t.projectId === projectId).length,
      spawnCallCount: SPAWN_CALL_COUNT
    })

    // CRITICAL: Double-check if project already has terminals (including those just added)
    // This prevents race conditions where multiple createDefaultTerminal calls happen
    const existingTerminals = terminalStore.terminals.filter((t) => t.projectId === projectId)
    if (existingTerminals.length > 0) {
      debugLog('createDefaultTerminal', `SKIPPED [${defaultId}]: terminals already exist`, {
        count: existingTerminals.length,
        terminalIds: existingTerminals.map(t => t.id)
      })
      terminalStore.selectTerminal(existingTerminals[0].id)
      return
    }

    // CRITICAL: Also check if a spawn is already in progress for this project
    // by checking if any terminal in the store is being restored
    const restoringTerminals = terminalStore.terminals.filter(
      (t) => !t.ptyId && t.projectId === projectId
    )
    if (restoringTerminals.length > 0) {
      debugLog('createDefaultTerminal', `SKIPPED [${defaultId}]: terminals already being created`, {
        count: restoringTerminals.length
      })
      return
    }

    // Get shell from fallback chain: project -> app settings -> system default
    // Then resolve shell name to path for backward compatibility
    const project = projectStore.projects.find((p) => p.id === projectId)
    const shellSetting = project?.defaultShell || appSettings.settings.defaultShell || ''
    const resolvedShell = await resolveShellToPath(shellSetting)
    const shell = normalizeShellForStartup(resolvedShell)

    debugLog('createDefaultTerminal', `Spawning default terminal [${defaultId}]`, {
      shell,
      cwd: project?.path
    })

    const spawnResult = await terminalApi.spawn({
      shell,
      cwd: project?.path
    })

    debugLog('createDefaultTerminal', `Spawn result [${defaultId}]`, {
      success: spawnResult.success,
      error: spawnResult.success ? undefined : spawnResult.error,
      ptyId: spawnResult.success ? spawnResult.data.id : 'FAILED'
    })

    if (!spawnResult.success) {
      debugLog('createDefaultTerminal', `Spawn FAILED [${defaultId}]`)
      return
    }

    SPAWN_CALL_COUNT++

    // Create default terminal - addTerminal also sets it as active
  const newTerminal = terminalStore.addTerminal('Terminal 1', projectId, shell, project?.path)
  terminalStore.setTerminalPtyId(newTerminal.id, spawnResult.data.id)

  // Explicitly select to ensure activeTerminalId is set correctly
  terminalStore.selectTerminal(newTerminal.id)

  // CRITICAL: Get fresh state after mutations for accurate logging
  const freshTerminalStore = useTerminalStore.getState()

  debugLog('createDefaultTerminal', `COMPLETE [${defaultId}]`, {
    terminalId: newTerminal.id,
    ptyId: spawnResult.data.id,
    totalTerminalsInStore: freshTerminalStore.terminals.length,
    totalSpawnCalls: SPAWN_CALL_COUNT
  })
  } finally {
    // FIX #2: Always release the global spawn lock
    releaseGlobalSpawnLock(defaultId)
    debugLog('createDefaultTerminal', `RELEASED LOCK [${defaultId}]`, {
      totalSpawnCalls: SPAWN_CALL_COUNT
    })
  }
}
