import { create } from 'zustand'
import { isMac } from '@/lib/platform'
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

// Helper: Normalize a keyboard event to our key format.
//
// Modifier tokens (preserved in output):
//   ctrl → Ctrl key on Windows/Linux, or Ctrl key on macOS
//   cmd  → Meta/⌘ key on macOS (only emitted on macOS)
//
// On macOS both modifiers can technically be held simultaneously, but in
// practice users only use one at a time for app shortcuts, so we emit the
// first that matches the platform convention.
export function normalizeKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []

  // Add modifiers in canonical order: alt → cmd/ctrl → shift
  if (e.altKey) parts.push('alt')

  if (isMac) {
    // macOS: prefer cmd (metaKey) but also track ctrl if only ctrl is held.
    // This lets us distinguish ⌘+K from Ctrl+K on macOS.
    if (e.metaKey) parts.push('cmd')
    else if (e.ctrlKey) parts.push('ctrl')
  } else {
    if (e.ctrlKey) parts.push('ctrl')
    else if (e.metaKey) parts.push('cmd')
  }

  if (e.shiftKey) parts.push('shift')

  // Add the key itself (lowercase)
  let key = e.key.toLowerCase()

  // Handle special keys
  if (key === ' ') key = 'space'
  if (key === 'escape') key = 'esc'

  // Normalize key values for common keys that might have variations
  if (key === '-' || key === '–' || key === '—' || key === '_') key = '-'
  if (key === '=' || key === '+') key = '='

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

  return key
    .split('+')
    .map((part) => {
      switch (part) {
        case 'ctrl':
          return isMac ? '⌃' : 'Ctrl'
        case 'cmd':
          return isMac ? '⌘' : 'Meta'
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
        case 'pageup':
          return 'PageUp'
        case 'pagedown':
          return 'PageDown'
        default:
          return part.toUpperCase()
      }
    })
    .join(isMac ? '' : '+')
}

// Helper: Check if a keyboard event matches a shortcut key.
//
// Platform-aware matching:
//   - Config stores keys in 'ctrl+...' format (backward compatible).
//   - On macOS, 'cmd+...' from normalizeKeyEvent also matches 'ctrl+...' config entries.
//   - On Windows/Linux, matching is exact.
export function matchesShortcut(e: KeyboardEvent, shortcutKey: string): boolean {
  // On macOS, Ctrl+... (without ⌘) is the shell passthrough modifier.
  // It must never trigger app shortcuts — only ⌘+... does.
  // This mirrors the passthrough guard in ConnectedTerminal.tsx.
  if (isMac && e.ctrlKey && !e.metaKey) return false

  const normalized = normalizeKeyEvent(e)
  if (normalized === shortcutKey) return true

  // macOS cross-modifier alias: 'cmd+x' matches 'ctrl+x' config and vice-versa.
  // This lets the same 'ctrl+k' default work with both ⌘+K and Ctrl+K on Mac.
  if (isMac) {
    const aliased = normalized.startsWith('cmd+')
      ? `ctrl+${normalized.slice(4)}`
      : normalized.startsWith('ctrl+')
        ? `cmd+${normalized.slice(5)}`
        : normalized
    return aliased === shortcutKey
  }

  return false
}
