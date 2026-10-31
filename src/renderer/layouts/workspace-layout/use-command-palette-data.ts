import { PersistenceKeys } from '@shared/types/persistence.types'
import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  findEditorInputTarget,
  routeForeignInsert
} from '@/components/terminal/command-editor/foreign-insert'
import {
  useAllCommandHistory,
  useCommandHistory,
  useCommandHistoryLoader
} from '@/hooks/use-command-history'
import { usePinnedCommandsLoader } from '@/hooks/use-pinned-commands'
import { useRecentCommandsLoader } from '@/hooks/use-recent-commands'
import { useCreateSnapshot, useSnapshotLoader } from '@/hooks/use-snapshots'
import { persistenceApi, terminalApi } from '@/lib/api'
import { canTerminalWriteToPty } from '@/lib/command-lifecycle/input-guard'
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
      if (activeTerminal?.ptyId) {
        const target = findEditorInputTarget(activeTerminal.ptyId)
        if (target) {
          void routeForeignInsert(
            target,
            'history',
            command,
            async (text) => {
              await terminalApi.write(activeTerminal.ptyId!, text)
            },
            (message) => toast.error(message)
          )
          return
        }
        if (
          !canTerminalWriteToPty(activeTerminal.id, command) ||
          !canTerminalWriteToPty(activeTerminal.ptyId, command)
        ) {
          return
        }
        terminalApi.write(activeTerminal.ptyId, command)
      }
    },
    [activeTerminal]
  )

  const handleClearCommandHistory = useCallback(async () => {
    if (!activeProjectId) return
    // Persist empty array first, then clear in-memory on success
    const result = await persistenceApi.write(PersistenceKeys.commandHistory(activeProjectId), [])
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
