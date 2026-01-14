import { create } from 'zustand'
import type { KeyboardShortcut, KeyboardShortcutsConfig } from '@/types/settings'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@/types/settings'

interface KeyboardShortcutsState {
  shortcuts: KeyboardShortcutsConfig
  isLoaded: boolean
  setShortcuts: (shortcuts: KeyboardShortcutsConfig) => void
  updateShortcut: (id: string, customKey: string) => void
  resetShortcut: (id: string) => void
  resetAllShortcuts: () => void
}

// Deep clone defaults to avoid mutation
function cloneDefaults(): KeyboardShortcutsConfig {
  const result: KeyboardShortcutsConfig = {}
  for (const [key, shortcut] of Object.entries(DEFAULT_KEYBOARD_SHORTCUTS)) {
    result[key] = { ...shortcut }
  }
  return result
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsState>((set) => ({
  shortcuts: cloneDefaults(),
  isLoaded: false,

  setShortcuts: (shortcuts) => set({ shortcuts, isLoaded: true }),

  updateShortcut: (id, customKey) =>
    set((state) => {
      const shortcut = state.shortcuts[id]
      if (!shortcut) return state

      return {
        shortcuts: {
          ...state.shortcuts,
          [id]: {
            ...shortcut,
            customKey: customKey === shortcut.defaultKey ? undefined : customKey
          }
        }
      }
    }),

  resetShortcut: (id) =>
    set((state) => {
      const shortcut = state.shortcuts[id]
      if (!shortcut) return state

      return {
        shortcuts: {
          ...state.shortcuts,
          [id]: {
            ...shortcut,
            customKey: undefined
          }
        }
      }
    }),

  resetAllShortcuts: () => set({ shortcuts: cloneDefaults() })
}))

// Helper: Check if a key combination conflicts with any other shortcut
export function findConflictingShortcut(
  shortcuts: KeyboardShortcutsConfig,
  key: string,
  excludeId: string
): KeyboardShortcut | undefined {
  for (const shortcut of Object.values(shortcuts)) {
    if (shortcut.id === excludeId) continue
    const activeKey = shortcut.customKey ?? shortcut.defaultKey
    if (activeKey === key) {
      return shortcut
    }
  }
  return undefined
}

// Helper: Normalize a keyboard event to our key format
export function normalizeKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []

  // Add modifiers in alphabetical order
  if (e.altKey) parts.push('alt')
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.shiftKey) parts.push('shift')

  // Add the key itself (lowercase)
  let key = e.key.toLowerCase()

  // Handle special keys
  if (key === ' ') key = 'space'
  if (key === 'escape') key = 'esc'

  // Normalize key values for common keys that might have variations
  // Minus/hyphen keys
  if (key === '-' || key === '–' || key === '—' || key === '_') key = '-'
  // Plus/equal keys (often on same key)
  if (key === '=' || key === '+') key = '='
  // Number row (when shift is not held)
  if (/^[0-9]$/.test(key)) key = key

  // Skip if only modifier was pressed
  if (['control', 'alt', 'shift', 'meta'].includes(key)) {
    return parts.join('+')
  }

  parts.push(key)
  return parts.join('+')
}

// Helper: Format a key combination for display
export function formatKeyForDisplay(key: string): string {
  if (!key) return ''

  const isMac = navigator.platform.toUpperCase().includes('MAC')

  return key
    .split('+')
    .map((part) => {
      switch (part) {
        case 'ctrl':
          return isMac ? '⌘' : 'Ctrl'
        case 'alt':
          return isMac ? '⌥' : 'Alt'
        case 'shift':
          return isMac ? '⇧' : 'Shift'
        case 'tab':
          return 'Tab'
        case 'esc':
          return 'Esc'
        case 'space':
          return 'Space'
        default:
          return part.toUpperCase()
      }
    })
    .join(isMac ? '' : '+')
}

// Helper: Check if a keyboard event matches a shortcut key
export function matchesShortcut(e: KeyboardEvent, shortcutKey: string): boolean {
  const normalized = normalizeKeyEvent(e)
  return normalized === shortcutKey
}
