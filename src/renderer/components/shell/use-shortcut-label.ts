import { formatKeyForDisplay, useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'

/**
 * Display label of a shortcut's resolved binding (custom key first, then the
 * platform default), such as `Ctrl+K`. `undefined` when the shortcut is
 * unknown or unbound.
 */
export function useShortcutLabel(id: string): string | undefined {
  const shortcut = useKeyboardShortcutsStore((state) => state.shortcuts[id])
  const key = shortcut?.customKey ?? shortcut?.defaultKey
  return key ? formatKeyForDisplay(key) : undefined
}

/** "Label (Ctrl+B)" when a shortcut is bound, else the label alone. */
export function withShortcut(label: string, shortcut: string | undefined): string {
  return shortcut ? `${label} (${shortcut})` : label
}
