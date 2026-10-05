import type { MouseEvent, ReactNode } from 'react'
import { Copy, CopyX, Edit2, Skull, X, XCircle } from '@/components/icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { WorkspaceTab } from '@/stores/workspace-store'

/**
 * Shared middle-click-to-close handler for workspace tab surfaces.
 *
 * Every tab kind closes through its normal close path on `auxclick` button 1.
 * `closeDisabled` mirrors the kind's close guard (terminal close in flight,
 * editor `saving`/`reloading`, inline rename editing) so a guarded middle
 * click is a no-op rather than a parallel close path.
 */
export function handleTabAuxClick(e: MouseEvent, onClose: () => void, closeDisabled = false): void {
  if (e.button !== 1) return
  e.preventDefault()
  e.stopPropagation()
  if (closeDisabled) return
  onClose()
}

/**
 * Shared context-menu wrapper for every workspace tab kind.
 *
 * Each tab surface wraps its tab element in `<TabContextMenu kind="…">`; every
 * kind renders the identical core item set — Close, kind-scoped Close
 * Other/Close All, pane-scoped Close Other Tabs/Close All Tabs — plus
 * kind-specific extras (Rename on terminal, Copy Path on editor, Kill Process
 * on terminal). This dedupes the per-kind tab menus into one source of truth
 * so every tab shares identical chrome, keyboard navigation, viewport-aware
 * positioning, and touch long-press parity.
 *
 * Per spec: tab menus carry NO shortcut labels (shortcuts are a general-menu
 * concern) — icons use the canonical `mr-2 h-4 w-4` left-of-label convention.
 * The content width is `w-max` so the longest label ("Close Other Git History
 * Tabs") never wraps.
 */

// Derived from WorkspaceTab['type'] so the tab kinds and the menu kinds can
// never drift apart.
export type TabContextMenuKind = WorkspaceTab['type']

/** Plural label used by the kind-scoped bulk-close items. */
export const KIND_PLURAL_LABELS: Record<TabContextMenuKind, string> = {
  terminal: 'Terminals',
  editor: 'Editors',
  browser: 'Browser Tabs',
  git: 'Git Tabs',
  'git-history': 'Git History Tabs',
  'agent-chat': 'Agent Chats',
  canvas: 'Canvas Tabs'
}

/**
 * Bulk-close menu props shared by every workspace tab kind. The workspace tab
 * bar wires all of them; surfaces that only want the minimal menu (e.g. the
 * bottom TerminalTabBar) leave them undefined and the items stay hidden.
 */
export interface TabBulkMenuProps {
  /** Close every OTHER tab of this kind in the same pane. */
  onCloseOthers?: () => void
  /** Close ALL tabs of this kind in the same pane (including this one). */
  onCloseAll?: () => void
  /** Close every OTHER tab in the same pane (any kind). */
  onCloseOtherTabs?: () => void
  /** Close ALL tabs in the same pane (any kind, including this one). */
  onCloseAllTabs?: () => void
  /** Enables `Close Other {Kind}` — false when no other same-kind closable tab exists. */
  hasOtherTabsOfKind?: boolean
  /** Enables `Close Other Tabs` — false when the pane holds only this tab. */
  hasOtherTabsInPane?: boolean
}

interface TabContextMenuProps extends TabBulkMenuProps {
  kind: TabContextMenuKind
  /** Primary close action (every kind). */
  onClose: () => void
  /** Terminal rename. */
  onRename?: () => void
  /** Terminal kill (destructive styling). */
  onKill?: () => void
  /** Editor: copy the file path. */
  onCopyPath?: () => void
  /** Disable close/kill while a close is already in flight (terminal). */
  isClosing?: boolean
  /** Disable close while the editor is saving/reloading (editor). */
  isBusy?: boolean
  /** The tab element to wrap (`asChild` trigger). */
  children: ReactNode
}

export function TabContextMenu({
  kind,
  onClose,
  onRename,
  onKill,
  onCloseOthers,
  onCloseAll,
  onCloseOtherTabs,
  onCloseAllTabs,
  onCopyPath,
  hasOtherTabsOfKind = false,
  hasOtherTabsInPane = false,
  isClosing = false,
  isBusy = false,
  children
}: TabContextMenuProps): React.JSX.Element {
  const kindPlural = KIND_PLURAL_LABELS[kind]
  const closeDisabled = isClosing || isBusy

  const showRename = kind === 'terminal' && onRename !== undefined
  const showCopyPath = kind === 'editor' && onCopyPath !== undefined
  const showKill = kind === 'terminal' && onKill !== undefined
  const hasPaneGroup = onCloseOtherTabs !== undefined || onCloseAllTabs !== undefined
  const hasExtras = showCopyPath || showKill

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-max min-w-56">
        {showRename && (
          <ContextMenuItem onSelect={onRename}>
            <Edit2 className="mr-2 h-4 w-4" /> Rename
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={onClose} disabled={closeDisabled}>
          <X className="mr-2 h-4 w-4" /> Close
        </ContextMenuItem>
        {onCloseOthers && (
          <ContextMenuItem onSelect={onCloseOthers} disabled={!hasOtherTabsOfKind}>
            <CopyX className="mr-2 h-4 w-4" /> Close Other {kindPlural}
          </ContextMenuItem>
        )}
        {onCloseAll && (
          <ContextMenuItem onSelect={onCloseAll}>
            <XCircle className="mr-2 h-4 w-4" /> Close All {kindPlural}
          </ContextMenuItem>
        )}
        {hasPaneGroup && <ContextMenuSeparator />}
        {onCloseOtherTabs && (
          <ContextMenuItem onSelect={onCloseOtherTabs} disabled={!hasOtherTabsInPane}>
            <CopyX className="mr-2 h-4 w-4" /> Close Other Tabs
          </ContextMenuItem>
        )}
        {onCloseAllTabs && (
          <ContextMenuItem onSelect={onCloseAllTabs}>
            <XCircle className="mr-2 h-4 w-4" /> Close All Tabs
          </ContextMenuItem>
        )}
        {hasExtras && <ContextMenuSeparator />}
        {showCopyPath && (
          <ContextMenuItem onSelect={onCopyPath}>
            <Copy className="mr-2 h-4 w-4" /> Copy Path
          </ContextMenuItem>
        )}
        {showKill && (
          <ContextMenuItem variant="destructive" onSelect={onKill} disabled={isClosing}>
            <Skull className="mr-2 h-4 w-4" /> Kill Process
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
