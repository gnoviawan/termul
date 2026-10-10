import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  useAllCommandHistory,
  useCommandHistory,
  useCommandHistoryLoader
} from '@/hooks/use-command-history'
import { usePinnedCommandsLoader } from '@/hooks/use-pinned-commands'
import { useRecentCommandsLoader } from '@/hooks/use-recent-commands'
import { useCreateSnapshot, useSnapshotLoader } from '@/hooks/use-snapshots'
import { persistenceApi, terminalApi } from '@/lib/api'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import { useActiveTerminal } from '@/stores/terminal-store'

interface UseCommandPaletteDataOptions {
  activeProjectId: string
}

/** Loaders and handlers backing the command palette, snapshot and command-history modals. */
export function useCommandPaletteData({ activeProjectId }: UseCommandPaletteDataOptions) {
  const activeTerminal = useActiveTerminal()

  // Load snapshots when project changes
  useSnapshotLoader()
  // Load recent commands for command palette
  useRecentCommandsLoader()
  // Load pinned commands for command palette
  usePinnedCommandsLoader()
  // Load command history for current project
  useCommandHistoryLoader(activeProjectId)
  const commandHistory = useCommandHistory(activeProjectId)
  const allCommandHistory = useAllCommandHistory()
  const createSnapshot = useCreateSnapshot()

  const handleCreateSnapshot = useCallback(
    async (name: string, description?: string) => {
      await createSnapshot(name, description)
    },
    [createSnapshot]
  )

  // Command history handlers
  const handleInsertCommand = useCallback(
    (command: string) => {
      // TODO: Route to active terminal pane via context
      if (activeTerminal?.ptyId) {
        terminalApi.write(activeTerminal.ptyId, command)
      }
    },
    [activeTerminal]
  )

  const handleClearCommandHistory = useCallback(async () => {
    if (!activeProjectId) return
    // Persist empty array first, then clear in-memory on success
    const result = await persistenceApi.write(`projects/${activeProjectId}/command-history`, [])
    if (!result.success) {
      toast.error(`Failed to clear history: ${result.error}`)
      throw new Error(result.error)
    }
    // Only clear in-memory state after successful persistence
    const { clearHistory } = useCommandHistoryStore.getState()
    clearHistory(activeProjectId)
  }, [activeProjectId])

  return {
    commandHistory,
    allCommandHistory,
    handleCreateSnapshot,
    handleInsertCommand,
    handleClearCommandHistory
  }
}
