import type { RefObject } from 'react'
import type { FileMentionMenuHandle } from './FileMentionMenu'
import type { ComposerKeyboardEvent } from './slash-menu-keyboard'

export interface MentionMenuKeyboardOptions {
  menuOpen: boolean
  sectionsLength: number
  menuRef: RefObject<FileMentionMenuHandle | null>
  filter: string
  canGoBack: boolean
  onBack: () => void
  /** Escape closes the picker but leaves the `@tok` text in place (ADR 0003). */
  onReset: () => void
}

export function tryHandleMentionMenuKeyDown(
  e: ComposerKeyboardEvent,
  options: MentionMenuKeyboardOptions
): boolean {
  const { menuOpen, sectionsLength, menuRef, filter, canGoBack, onBack, onReset } = options
  if (!menuOpen) return false

  if (e.key === 'Escape') {
    e.preventDefault()
    onReset()
    return true
  }
  const noModifier = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
  if (
    canGoBack &&
    noModifier &&
    (e.key === 'ArrowLeft' || (e.key === 'Backspace' && filter === ''))
  ) {
    e.preventDefault()
    onBack()
    return true
  }
  if (e.key === 'ArrowRight' && noModifier && menuRef.current?.drillHighlighted()) {
    e.preventDefault()
    return true
  }
  if (sectionsLength === 0 && !canGoBack) return false

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

  return false
}
