import { isMac } from '@/lib/platform'
import { matchesShortcut, type useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'

// Common readline/shell Ctrl sequences that should always pass through to the
// PTY regardless of platform. On macOS these are already protected by the
// isMac guard, but on Windows/Linux they would otherwise be swallowed when a
// matching app shortcut exists (e.g. commandPalette=ctrl+k, commandHistory=ctrl+r).
export const READLINE_PASSTHROUGH_KEYS = new Set([
  'a', // Ctrl+A  move to beginning of line
  'e', // Ctrl+E  move to end of line
  'k', // Ctrl+K  kill to end of line
  'r', // Ctrl+R  reverse-i-search
  'f', // Ctrl+F  move forward one char
  'b', // Ctrl+B  move back one char
  'w', // Ctrl+W  delete previous word
  'u', // Ctrl+U  delete to beginning of line
  'p', // Ctrl+P  previous history entry
  'n', // Ctrl+N  next history entry
  'l', // Ctrl+L  clear screen
  'd' // Ctrl+D  EOF / delete char
])

export function isReadlinePassthrough(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    READLINE_PASSTHROUGH_KEYS.has(event.key.toLowerCase())
  )
}

export function isAppOwnedTerminalShortcut(
  event: KeyboardEvent,
  shortcuts: ReturnType<typeof useKeyboardShortcutsStore.getState>['shortcuts']
): boolean {
  // 1. App shortcuts take priority over readline passthrough.
  // This ensures commandPalette, commandHistory, etc. work from terminal
  // focus even though their Ctrl+key also matches a readline binding.
  for (const shortcut of Object.values(shortcuts)) {
    const activeKey = shortcut.customKey ?? shortcut.defaultKey
    if (matchesShortcut(event, activeKey)) {
      return true
    }
  }

  // 2. No app shortcut matched — check readline passthrough.
  // Ctrl+letter readline bindings must reach the PTY on every platform.
  // On macOS the isMac guard in matchesShortcut already prevents Ctrl+key
  // from matching app shortcuts, so the readline behavior is preserved.
  if (isReadlinePassthrough(event)) {
    return false
  }

  return false
}

/** Prevent browser reverse-tab focus traversal; xterm still handles Tab / Shift+Tab. */
export function trapTerminalTabFocusNavigation(event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') {
    return false
  }
  event.preventDefault()
  return true
}

// Platform-aware shortcut modifier for the terminal context-menu labels
// (⌘ on macOS, Ctrl elsewhere). Mirrors GlobalContextMenu's SHORTCUT_MOD.
export const SHORTCUT_MOD = isMac ? '⌘' : 'Ctrl'
