import { useCallback, useEffect } from 'react'
import { persistenceApi } from '@/lib/api'
import { usePinnedCommandsStore } from '@/stores/pinned-commands-store'

export const PINNED_COMMANDS_KEY = 'settings/pinned-commands'

export function usePinnedCommandsLoader(): void {
  const setPinned = usePinnedCommandsStore((state) => state.setPinned)

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await persistenceApi.read<string[]>(PINNED_COMMANDS_KEY)
      // Guard against corrupt persisted data: only accept an array of strings.
      if (
        result.success &&
        Array.isArray(result.data) &&
        result.data.every((id) => typeof id === 'string')
      ) {
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
      await persistenceApi.write(PINNED_COMMANDS_KEY, pinnedCommandIds)
    },
    [togglePinned]
  )
}

export function usePinnedCommandIds(): string[] {
  return usePinnedCommandsStore((state) => state.pinnedCommandIds)
}
