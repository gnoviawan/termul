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
            customKey: shortcutsEqual(customKey, shortcut.defaultKey) ? undefined : customKey
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
    if (shortcutsEqual(activeKey, key)) {
      return shortcut
    }
  }
  return undefined
}

const MODIFIER_ORDER = ['ctrl', 'cmd', 'shift', 'alt'] as const

function canonicalizeShortcutKey(key: string): string {
  const parts = key.split('+').filter(Boolean)
  const shortcutKey = parts[parts.length - 1]
  if (!shortcutKey) return key

  const modifiers = new Set(parts.slice(0, -1))
  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
  return [...orderedModifiers, shortcutKey].join('+')
}

function shortcutsEqual(left: string, right: string): boolean {
  return canonicalizeShortcutKey(left) === canonicalizeShortcutKey(right)
}

// Helper: Normalize a keyboard event to our key format.
//
// Modifier tokens (preserved in output):
//   ctrl → Ctrl key on Windows/Linux, or Ctrl key on macOS
//   cmd  → Meta/⌘ key on macOS (only emitted on macOS)
//
// On macOS both modifiers can be held simultaneously (e.g. ⌘⌃T); each is
// emitted as its own token so multi-modifier combos record correctly.
export function normalizeKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []

  // Add modifiers in canonical order matching persisted defaults.
  if (isMac) {
    // macOS: emit ctrl and cmd independently so multi-modifier combos like
    // ⌘⌃T (cmd+ctrl held together) can be recorded. A single modifier still
    // emits just that token, preserving the ⌘+K vs Ctrl+K distinction.
    // Canonical order is ctrl before cmd (see MODIFIER_ORDER).
    if (e.ctrlKey) parts.push('ctrl')
    if (e.metaKey) parts.push('cmd')
  } else {
    if (e.ctrlKey) parts.push('ctrl')
    else if (e.metaKey) parts.push('cmd')
  }

  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')

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
  if (shortcutsEqual(normalized, shortcutKey)) return true

  // macOS cross-modifier alias: 'cmd+x' matches 'ctrl+x' config and vice-versa.
  // This lets the same 'ctrl+k' default work with both ⌘+K and Ctrl+K on Mac.
  // Only single-modifier combos are aliased — when both ⌘ and ⌃ are held
  // (e.g. ⌘⌃T) the combo is matched exactly, never swapped, otherwise the
  // alias would corrupt it into 'cmd+cmd+t'.
  if (isMac) {
    const parts = normalized.split('+')
    const hasCmd = parts.includes('cmd')
    const hasCtrl = parts.includes('ctrl')
    if (hasCmd !== hasCtrl) {
      const aliased = parts
        .map((part) => (part === 'cmd' ? 'ctrl' : part === 'ctrl' ? 'cmd' : part))
        .join('+')
      return shortcutsEqual(aliased, shortcutKey)
    }
  }

  return false
}
