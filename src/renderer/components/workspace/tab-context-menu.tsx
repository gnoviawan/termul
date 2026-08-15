import { Copy, CopyX, Edit2, Skull, X, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

/**
 * Shared context-menu wrapper for every workspace tab kind.
 *
 * Each tab surface wraps its tab element in `<TabContextMenu kind="…">`; the
 * `kind` selects the declarative item set rendered inside a single Radix
 * `<ContextMenuContent>`. This dedupes the 7 bespoke `{x,y}` tab menus into
 * one source of truth so every tab shares identical chrome, keyboard
 * navigation, viewport-aware positioning, and touch long-press parity.
 *
 * Per spec: tab menus carry NO shortcut labels (shortcuts are a general-menu
 * concern) — icons use the canonical `mr-2 h-4 w-4` left-of-label convention.
 */
export type TabContextMenuKind =
  | 'terminal'
  | 'editor'
  | 'browser'
  | 'git'
  | 'git-history'
  | 'agent-chat'

interface TabContextMenuProps {
  kind: TabContextMenuKind
  /** Primary close action (every kind). */
  onClose: () => void
  /** Terminal rename. */
  onRename?: () => void
  /** Terminal kill (destructive styling). */
  onKill?: () => void
  /** Editor: close every other editor tab. */
  onCloseOthers?: () => void
  /** Editor: close all editor tabs. */
  onCloseAll?: () => void
  /** Editor: copy the file path. */
  onCopyPath?: () => void
  /** Disable close/kill while a close is already in flight (terminal). */
  isClosing?: boolean
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
  onCopyPath,
  isClosing = false,
  children
}: TabContextMenuProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const closeDisabled = isClosing
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {kind === 'terminal' && (
          <>
            {onRename && (
              <ContextMenuItem onSelect={onRename}>
                <Edit2 className="mr-2 h-4 w-4" /> {t('tabs.rename')}
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={onClose} disabled={closeDisabled}>
              <X className="mr-2 h-4 w-4" /> {t('tabs.close')}
            </ContextMenuItem>
            {onKill && (
              <ContextMenuItem variant="destructive" onSelect={onKill} disabled={closeDisabled}>
                <Skull className="mr-2 h-4 w-4" /> {t('tabs.killProcess')}
              </ContextMenuItem>
            )}
          </>
        )}

        {kind === 'editor' && (
          <>
            <ContextMenuItem onSelect={onClose}>
              <X className="mr-2 h-4 w-4" /> {t('tabs.close')}
            </ContextMenuItem>
            {onCloseOthers && (
              <ContextMenuItem onSelect={onCloseOthers}>
                <CopyX className="mr-2 h-4 w-4" /> {t('tabs.closeOthers')}
              </ContextMenuItem>
            )}
            {onCloseAll && (
              <ContextMenuItem onSelect={onCloseAll}>
                <XCircle className="mr-2 h-4 w-4" /> {t('tabs.closeAll')}
              </ContextMenuItem>
            )}
            {onCopyPath && (
              <ContextMenuItem onSelect={onCopyPath}>
                <Copy className="mr-2 h-4 w-4" /> {t('tabs.copyPath')}
              </ContextMenuItem>
            )}
          </>
        )}

        {(kind === 'browser' ||
          kind === 'git' ||
          kind === 'git-history' ||
          kind === 'agent-chat') && (
          <ContextMenuItem onSelect={onClose}>
            <X className="mr-2 h-4 w-4" /> {t('tabs.close')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
