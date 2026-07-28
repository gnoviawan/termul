import type { KeyboardEvent, RefObject } from 'react'
import type { FileMentionMenuHandle } from './FileMentionMenu'

export interface MentionMenuKeyboardOptions {
  menuOpen: boolean
  sectionsLength: number
  menuRef: RefObject<FileMentionMenuHandle | null>
  /** Escape closes the picker but leaves the `@tok` text in place (ADR 0003). */
  onReset: () => void
}

/** Route ↑/↓/Tab/Enter/Escape to the @-mention menu when it is open. Returns true if handled. */
export function tryHandleMentionMenuKeyDown(
  e: KeyboardEvent,
  options: MentionMenuKeyboardOptions
): boolean {
  const { menuOpen, sectionsLength, menuRef, onReset } = options
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
    onReset()
    return true
  }

  return false
}
