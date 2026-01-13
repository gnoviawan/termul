import { useEffect, useCallback } from 'react'
import { useCommandHistoryStore, CommandHistoryEntry } from '@/stores/command-history-store'

export const COMMAND_HISTORY_KEY = (projectId: string) => `projects/${projectId}/command-history`

export function useCommandHistoryLoader(projectId: string | null): void {
  const setHistory = useCommandHistoryStore((state) => state.setHistory)
  const entries = useCommandHistoryStore((state) => state.entries)

  useEffect(() => {
    if (!projectId) return

    async function load(): Promise<void> {
      const result = await window.api.persistence.read<CommandHistoryEntry[]>(
        COMMAND_HISTORY_KEY(projectId!) // projectId is guaranteed non-null here due to early return
      )
      if (result.success && result.data) {
        // Merge with existing entries from other projects
        const otherProjectEntries = entries.filter((e) => e.projectId !== projectId)
        setHistory([...result.data, ...otherProjectEntries])
      }
    }
    load()
    // Only run on projectId change, not on entries change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, setHistory])
}

export function useSaveCommandHistory(projectId: string | null): () => Promise<void> {
  const entries = useCommandHistoryStore((state) => state.entries)

  return useCallback(async () => {
    if (!projectId) return
    const projectEntries = entries.filter((e) => e.projectId === projectId)
    await window.api.persistence.write(COMMAND_HISTORY_KEY(projectId), projectEntries)
  }, [projectId, entries])
}

export function useAddCommand(): (
  command: string,
  terminalName: string,
  terminalId: string,
  projectId: string
) => Promise<void> {
  const addCommand = useCommandHistoryStore((state) => state.addCommand)

  return useCallback(
    async (command: string, terminalName: string, terminalId: string, projectId: string) => {
      // Don't store empty or whitespace-only commands
      const trimmed = command.trim()
      if (!trimmed) return

      addCommand({
        command: trimmed,
        terminalName,
        terminalId,
        projectId,
        timestamp: Date.now()
      })

      // Persist after adding
      const { entries } = useCommandHistoryStore.getState()
      const projectEntries = entries.filter((e) => e.projectId === projectId)
      await window.api.persistence.write(COMMAND_HISTORY_KEY(projectId), projectEntries)
    },
    [addCommand]
  )
}

export function useCommandHistory(projectId: string | null): CommandHistoryEntry[] {
  const entries = useCommandHistoryStore((state) => state.entries)
  if (!projectId) return []
  return entries.filter((e) => e.projectId === projectId)
}
