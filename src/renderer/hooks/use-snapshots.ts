import { useEffect, useCallback } from 'react'
import { useSnapshotActions, useSnapshots } from '@/stores/snapshot-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useProjectStore } from '@/stores/project-store'
import { getTerminal } from '@/utils/terminal-registry'
import type { PersistedTerminal, PersistedSnapshot } from '../../shared/types/persistence.types'
import { DEFAULT_SCROLLBACK_LIMIT } from '../../shared/types/persistence.types'
import type { Snapshot } from '@/types/project'

// Hook to load snapshots when project changes
export function useSnapshotLoader(): void {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const { loadSnapshots } = useSnapshotActions()

  useEffect(() => {
    if (activeProjectId) {
      loadSnapshots(activeProjectId)
    }
  }, [activeProjectId, loadSnapshots])
}

// Hook to create a snapshot of current workspace
export function useCreateSnapshot(): (name: string, description?: string) => Promise<Snapshot> {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const terminals = useTerminalStore((state) => state.terminals)
  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId)
  const { createSnapshot } = useSnapshotActions()

  return useCallback(
    async (name: string, description?: string): Promise<Snapshot> => {
      if (!activeProjectId) {
        throw new Error('No active project')
      }

      // Get terminals for the active project
      const projectTerminals = terminals.filter((t) => t.projectId === activeProjectId)

      // Serialize terminals for persistence
      const persistedTerminals: PersistedTerminal[] = projectTerminals.map((terminal) => {
        // Get scrollback from terminal registry if available
        const xtermInstance = getTerminal(terminal.id)
        let scrollback: string[] = []

        if (xtermInstance) {
          const buffer = xtermInstance.buffer.active
          const lines: string[] = []
          const lineCount = buffer.length
          // Use a reasonable limit for snapshots (1/10th of default to save space)
          const snapshotScrollbackLimit = Math.min(1000, DEFAULT_SCROLLBACK_LIMIT / 10)

          for (let i = Math.max(0, lineCount - snapshotScrollbackLimit); i < lineCount; i++) {
            const line = buffer.getLine(i)
            if (line) {
              lines.push(line.translateToString(true))
            }
          }
          scrollback = lines
        }

        return {
          id: terminal.id,
          name: terminal.name,
          shell: terminal.shell,
          cwd: terminal.cwd,
          scrollback
        }
      })

      return createSnapshot(
        name,
        description,
        activeProjectId,
        persistedTerminals,
        activeTerminalId || null
      )
    },
    [activeProjectId, terminals, activeTerminalId, createSnapshot]
  )
}

// Hook to restore workspace from a snapshot
export function useRestoreSnapshot(): (snapshotId: string) => Promise<void> {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const { getSnapshot } = useSnapshotActions()

  return useCallback(
    async (snapshotId: string): Promise<void> => {
      if (!activeProjectId) {
        throw new Error('No active project')
      }

      // Get full snapshot data from persistence
      const snapshot = await getSnapshot(snapshotId)
      if (!snapshot) {
        throw new Error('Snapshot not found')
      }

      // Restore terminals from snapshot
      restoreFromSnapshot(activeProjectId, snapshot)
    },
    [activeProjectId, getSnapshot]
  )
}

/**
 * Restore terminals from a persisted snapshot
 * Follows the pattern from use-terminal-restore.ts
 */
function restoreFromSnapshot(projectId: string, snapshot: PersistedSnapshot): void {
  const terminalStore = useTerminalStore.getState()

  // Close all existing terminals for this project
  const existingTerminals = terminalStore.terminals.filter((t) => t.projectId === projectId)
  for (const terminal of existingTerminals) {
    terminalStore.closeTerminal(terminal.id, projectId)
  }

  // Create terminals from snapshot and track the active one
  let activeCreatedId: string | null = null
  let firstCreatedId: string | null = null

  for (const persistedTerminal of snapshot.terminals) {
    const created = terminalStore.addTerminal(
      persistedTerminal.name,
      projectId,
      persistedTerminal.shell as 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | undefined,
      persistedTerminal.cwd,
      persistedTerminal.scrollback
    )

    if (!firstCreatedId) {
      firstCreatedId = created.id
    }

    // Track the terminal that should be active
    if (persistedTerminal.id === snapshot.activeTerminalId) {
      activeCreatedId = created.id
    }
  }

  // Set active terminal - use tracked ID from creation
  if (activeCreatedId) {
    terminalStore.selectTerminal(activeCreatedId)
  } else if (firstCreatedId) {
    // Fallback to first created terminal if no active terminal in snapshot
    terminalStore.selectTerminal(firstCreatedId)
  }
}

// Re-export for convenience
export { useSnapshots, useSnapshotActions, useSnapshotLoading } from '@/stores/snapshot-store'
