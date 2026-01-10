import { useEffect, useCallback } from 'react'
import { useRecentCommandsStore } from '@/stores/recent-commands-store'

export const RECENT_COMMANDS_KEY = 'settings/recent-commands'

export function useRecentCommandsLoader(): void {
  const setRecentCommands = useRecentCommandsStore((state) => state.setRecentCommands)

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await window.api.persistence.read<string[]>(RECENT_COMMANDS_KEY)
      if (result.success && result.data) {
        setRecentCommands(result.data)
      }
    }
    load()
  }, [setRecentCommands])
}

export function useSaveRecentCommand(): (commandId: string) => Promise<void> {
  const addRecentCommand = useRecentCommandsStore((state) => state.addRecentCommand)

  return useCallback(
    async (commandId: string) => {
      addRecentCommand(commandId)
      // Persist after optimistic update
      const { recentCommandIds } = useRecentCommandsStore.getState()
      await window.api.persistence.write(RECENT_COMMANDS_KEY, recentCommandIds)
    },
    [addRecentCommand]
  )
}

export function useRecentCommandIds(): string[] {
  return useRecentCommandsStore((state) => state.recentCommandIds)
}
