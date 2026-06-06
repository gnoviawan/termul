import type { KeyboardEvent, RefObject } from 'react'
import type { SlashMenuHandle } from './SlashCommandMenu'

export interface SlashMenuKeyboardOptions {
  menuOpen: boolean
  sectionsLength: number
  menuRef: RefObject<SlashMenuHandle | null>
  onClearInput: () => void
}

/** Route ↑/↓/Tab/Enter/Escape to the slash menu when it is open. Returns true if handled. */
export function tryHandleSlashMenuKeyDown(
  e: KeyboardEvent,
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
