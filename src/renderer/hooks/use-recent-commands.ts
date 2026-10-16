import { PersistenceKeys } from '@shared/types/persistence.types'
import { useCallback, useEffect } from 'react'
import { persistenceApi } from '@/lib/api'
import { useRecentCommandsStore } from '@/stores/recent-commands-store'

export function useRecentCommandsLoader(): void {
  const setRecentCommands = useRecentCommandsStore((state) => state.setRecentCommands)

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await persistenceApi.read<string[]>(PersistenceKeys.recentCommands)
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
      await persistenceApi.write(PersistenceKeys.recentCommands, recentCommandIds)
    },
    [addRecentCommand]
  )
}

export function useRecentCommandIds(): string[] {
  return useRecentCommandsStore((state) => state.recentCommandIds)
}
