import { PersistenceKeys } from '@shared/types/persistence.types'
import { useCallback, useEffect } from 'react'
import { persistenceApi } from '@/lib/api'
import { useSharedKeySync } from '@/lib/shared-key-sync'
import { usePinnedCommandsStore } from '@/stores/pinned-commands-store'

// Guard against corrupt persisted data: only accept an array of strings.
function isCommandIdList(data: unknown): data is string[] {
  return Array.isArray(data) && data.every((id) => typeof id === 'string')
}

export function usePinnedCommandsLoader(): void {
  const setPinned = usePinnedCommandsStore((state) => state.setPinned)

  // A change another device or tab saved: show it without a reload.
  useSharedKeySync<unknown>(PersistenceKeys.pinnedCommands, (change) => {
    if (change.exists && isCommandIdList(change.data)) setPinned(change.data)
  })

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await persistenceApi.read<string[]>(PersistenceKeys.pinnedCommands)
      if (result.success && isCommandIdList(result.data)) {
        setPinned(result.data)
      }
    }
    load()
  }, [setPinned])
}

export function useTogglePinnedCommand(): (commandId: string) => Promise<void> {
  const togglePinned = usePinnedCommandsStore((state) => state.togglePinned)

  return useCallback(
    async (commandId: string) => {
      togglePinned(commandId)
      // Persist after optimistic update
      const { pinnedCommandIds } = usePinnedCommandsStore.getState()
      await persistenceApi.write(PersistenceKeys.pinnedCommands, pinnedCommandIds)
    },
    [togglePinned]
  )
}

export function usePinnedCommandIds(): string[] {
  return usePinnedCommandsStore((state) => state.pinnedCommandIds)
}
