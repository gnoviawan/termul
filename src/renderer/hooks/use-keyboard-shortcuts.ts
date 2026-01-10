import { useEffect, useCallback } from 'react'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import type { KeyboardShortcutsConfig } from '@/types/settings'
import { DEFAULT_KEYBOARD_SHORTCUTS, KEYBOARD_SHORTCUTS_KEY } from '@/types/settings'

// Deep clone defaults preserving customKey from loaded data
function mergeWithDefaults(
  loaded: Partial<KeyboardShortcutsConfig>
): KeyboardShortcutsConfig {
  const result: KeyboardShortcutsConfig = {}

  for (const [key, defaultShortcut] of Object.entries(DEFAULT_KEYBOARD_SHORTCUTS)) {
    const loadedShortcut = loaded[key]
    result[key] = {
      ...defaultShortcut,
      customKey: loadedShortcut?.customKey
    }
  }

  return result
}

export function useKeyboardShortcutsLoader(): void {
  const setShortcuts = useKeyboardShortcutsStore((state) => state.setShortcuts)

  useEffect(() => {
    async function load(): Promise<void> {
      const result =
        await window.api.persistence.read<KeyboardShortcutsConfig>(KEYBOARD_SHORTCUTS_KEY)
      if (result.success && result.data) {
        // Merge with defaults to handle new shortcuts added in updates
        setShortcuts(mergeWithDefaults(result.data))
      } else {
        // First load or read error - use defaults
        const defaults: KeyboardShortcutsConfig = {}
        for (const [key, shortcut] of Object.entries(DEFAULT_KEYBOARD_SHORTCUTS)) {
          defaults[key] = { ...shortcut }
        }
        setShortcuts(defaults)
      }
    }
    load()
  }, [setShortcuts])
}

export function useUpdateShortcut(): (id: string, customKey: string) => Promise<void> {
  const updateShortcut = useKeyboardShortcutsStore((state) => state.updateShortcut)

  return useCallback(
    async (id: string, customKey: string) => {
      updateShortcut(id, customKey)
      // Zustand updates are synchronous, so getState() returns updated state
      const updatedShortcuts = useKeyboardShortcutsStore.getState().shortcuts
      await window.api.persistence.writeDebounced(KEYBOARD_SHORTCUTS_KEY, updatedShortcuts)
    },
    [updateShortcut]
  )
}

export function useResetShortcut(): (id: string) => Promise<void> {
  const resetShortcut = useKeyboardShortcutsStore((state) => state.resetShortcut)

  return useCallback(
    async (id: string) => {
      resetShortcut(id)
      const updatedShortcuts = useKeyboardShortcutsStore.getState().shortcuts
      await window.api.persistence.writeDebounced(KEYBOARD_SHORTCUTS_KEY, updatedShortcuts)
    },
    [resetShortcut]
  )
}

export function useResetAllShortcuts(): () => Promise<void> {
  const resetAllShortcuts = useKeyboardShortcutsStore((state) => state.resetAllShortcuts)

  return useCallback(async () => {
    resetAllShortcuts()
    const updatedShortcuts = useKeyboardShortcutsStore.getState().shortcuts
    await window.api.persistence.write(KEYBOARD_SHORTCUTS_KEY, updatedShortcuts)
  }, [resetAllShortcuts])
}
