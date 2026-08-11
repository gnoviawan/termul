import type { RefObject } from 'react'
import type { SlashMenuHandle } from './SlashCommandMenu'

/**
 * Minimal keyboard-event shape the slash/mention menu keyboard helpers need.
 * Both the pre-refactor React `KeyboardEvent` and a DOM `KeyboardEvent`
 * (adapted) satisfy this contract — `nativeEvent.isComposing` reads the real
 * composing flag (DOM events expose `isComposing` directly; the adapter exposes
 * the DOM event as `nativeEvent`). `target`/`currentTarget` are included so
 * future helpers that need the editor element can read them without the adapter
 * lying about the shape (a contenteditable has no `selectionStart`; if a
 * helper needs the caret, it must compute it from the editor, not the event).
 */
export interface ComposerKeyboardEvent {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  readonly defaultPrevented: boolean
  readonly nativeEvent: { isComposing: boolean }
  readonly target: HTMLElement | null
  readonly currentTarget: HTMLElement | null
  preventDefault(): void
  stopPropagation(): void
}

export interface SlashMenuKeyboardOptions {
  menuOpen: boolean
  sectionsLength: number
  menuRef: RefObject<SlashMenuHandle | null>
  onClearInput: () => void
}

/** Route ↑/↓/Tab/Enter/Escape to the slash menu when it is open. Returns true if handled. */
export function tryHandleSlashMenuKeyDown(
  e: ComposerKeyboardEvent,
  options: SlashMenuKeyboardOptions
): boolean {
  const { menuOpen, sectionsLength, menuRef, onClearInput } = options
  if (!menuOpen || sectionsLength === 0) return false

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    menuRef.current?.move(1)
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    menuRef.current?.move(-1)
    return true
  }
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault()
    menuRef.current?.selectHighlighted()
    return true
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault()
    menuRef.current?.selectHighlighted()
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    onClearInput()
    return true
  }

  return false
}
