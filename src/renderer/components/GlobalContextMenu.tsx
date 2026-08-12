/**
 * Global right-click context menu wrapping the app root.
 *
 * Renders Copy / Cut / Paste / Select All (no Reload / Back / Inspect — those
 * are intentionally excluded per the spec) using the existing Radix primitive
 * (`@/components/ui/context-menu`). The trigger wraps the entire app surface
 * (`asChild` on a `display: contents` div so layout is unaffected); Radix's
 * innermost-trigger-wins rule preserves the terminal's own menu and the
 * FileExplorer / ProjectSidebar custom menus (their handlers call
 * `stopPropagation` so the global trigger never fires for those regions).
 *
 * P3: the disabled flags + the focused element are snapshotted synchronously
 * on the capture-phase `contextmenu` event (BEFORE Radix moves focus to the
 * first menu item). `onOpenChange(true)` reads that snapshot. The saved
 * element is re-focused in each item's `onClick` so `execCommand` + the
 * `text-edit-ops` helpers operate on the element that was actually right-
 * clicked, not the menu item Radix focused for accessibility.
 *
 * P8: Copy works on any selection (including readonly inputs); Cut/Paste/
 * Select All are gated on a MUTABLE editable (not readOnly, not disabled).
 * P9: Select All is disabled when no mutable editable is focused (no
 * document-wide selectAll fallback).
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { isMac } from '@/lib/platform'
import {
  copySelection,
  cutSelection,
  pasteIntoFocused,
  selectAllFocused
} from '@/lib/text-edit-ops'

// Platform-aware shortcut modifier for display labels (⌘ on macOS, Ctrl elsewhere).
const SHORTCUT_MOD = isMac ? '⌘' : 'Ctrl'

interface GlobalContextMenuState {
  hasSelection: boolean
  isMutableEditableFocused: boolean
  focusedEditable: HTMLElement | null
}

const CLOSED_STATE: GlobalContextMenuState = {
  hasSelection: false,
  isMutableEditableFocused: false,
  focusedEditable: null
}

function isMutableEditableElement(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return !el.readOnly && !el.disabled
  }
  return el instanceof HTMLElement && el.isContentEditable
}

/**
 * Snapshot the current selection + focused mutable editable. P2: selections
 * inside `<input>`/`<textarea>` use `selectionStart`/`selectionEnd`, NOT
 * `window.getSelection()` — check the focused editable first.
 */
function readState(): GlobalContextMenuState {
  if (typeof window === 'undefined' || typeof document === 'undefined') return CLOSED_STATE
  const activeEl = document.activeElement

  let hasSelection = false
  if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
    const start = activeEl.selectionStart
    const end = activeEl.selectionEnd
    if (start !== null && end !== null && start !== end) {
      hasSelection = true
    }
  }
  if (!hasSelection) {
    const sel = window.getSelection()
    hasSelection = sel ? sel.toString().length > 0 : false
  }

  return {
    hasSelection,
    isMutableEditableFocused: isMutableEditableElement(activeEl),
    focusedEditable: activeEl instanceof HTMLElement ? activeEl : null
  }
}

interface GlobalContextMenuProps {
  children: ReactNode
}

export function GlobalContextMenu({ children }: GlobalContextMenuProps): React.JSX.Element {
  const snapshotRef = useRef<GlobalContextMenuState>(CLOSED_STATE)
  const [state, setState] = useState<GlobalContextMenuState>(CLOSED_STATE)

  // P3: capture the state synchronously on the capture-phase `contextmenu`
  // event, BEFORE Radix moves focus to the first menu item. This fires on
  // every right-click (even in regions that stopPropagation in the bubble
  // phase) but is harmless — it only snapshots state to a ref.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const handler = (): void => {
      snapshotRef.current = readState()
    }
    document.addEventListener('contextmenu', handler, { capture: true })
    return () => document.removeEventListener('contextmenu', handler, { capture: true })
  }, [])

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      setState(snapshotRef.current)
    }
  }, [])

  // P3: re-focus the saved element before running the action so
  // `execCommand` + `getSelectionText()` operate on the right input.
  const refocusEditable = useCallback(() => {
    const el = snapshotRef.current.focusedEditable
    if (el && el.isConnected) {
      el.focus()
    }
  }, [])

  const { hasSelection, isMutableEditableFocused } = state

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild>
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem
          disabled={!hasSelection}
          onClick={() => {
            refocusEditable()
            void copySelection()
          }}
        >
          Copy <ContextMenuShortcut>{SHORTCUT_MOD}+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection || !isMutableEditableFocused}
          onClick={() => {
            refocusEditable()
            void cutSelection()
          }}
        >
          Cut <ContextMenuShortcut>{SHORTCUT_MOD}+X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!isMutableEditableFocused}
          onClick={() => {
            refocusEditable()
            void pasteIntoFocused()
          }}
        >
          Paste <ContextMenuShortcut>{SHORTCUT_MOD}+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!isMutableEditableFocused}
          onClick={() => {
            refocusEditable()
            selectAllFocused()
          }}
        >
          Select All <ContextMenuShortcut>{SHORTCUT_MOD}+A</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
