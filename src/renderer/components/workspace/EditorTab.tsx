import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { Check, Loader2, X } from '@/components/icons'
import { cn } from '@/lib/utils'
import { handleTabAuxClick, type TabBulkMenuProps, TabContextMenu } from './tab-context-menu'

function getBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function getExtname(filePath: string): string {
  const name = getBasename(filePath)
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex)
}

/** Close control chrome. The reveal wrapper owns spacing and motion. */
export const TAB_CLOSE_BUTTON_CLASS =
  'inline-flex size-4 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ease-out hover:bg-secondary motion-reduce:transition-none'

/**
 * Hover grows the tab by sliding the close control in.
 * The slot uses a grid track (0fr → 1fr) so the width eases without a width
 * transition. The active tab skips the motion: tab switches stay instant.
 */
export function TabCloseReveal({
  pinned,
  children
}: {
  pinned: boolean
  children: React.ReactNode
}): React.JSX.Element {
  if (pinned) {
    return <div className="ml-3 flex shrink-0">{children}</div>
  }

  return (
    <div
      className={cn(
        'grid shrink-0 grid-cols-[0fr] motion-reduce:transition-none',
        'transition-[grid-template-columns] duration-[120ms] ease-[cubic-bezier(0.4,0,1,1)]',
        'pointer-fine:group-hover:grid-cols-[1fr] pointer-fine:group-hover:duration-150 pointer-fine:group-hover:ease-[var(--ease-out)]'
      )}
    >
      <div className="min-w-0 overflow-hidden">
        <div
          className={cn(
            'ml-3 translate-x-2 opacity-0',
            'transition-[transform,opacity] duration-[120ms] ease-[cubic-bezier(0.4,0,1,1)]',
            'pointer-fine:group-hover:translate-x-0 pointer-fine:group-hover:opacity-100',
            'pointer-fine:group-hover:duration-150 pointer-fine:group-hover:ease-[var(--ease-out)]',
            'motion-reduce:translate-x-0 motion-reduce:opacity-100 motion-reduce:transition-none'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

interface EditorTabProps extends TabBulkMenuProps {
  filePath: string
  isActive: boolean
  isDirty: boolean
  operationStatus?: 'idle' | 'saving' | 'reloading' | 'saved'
  onSelect: () => void
  onClose: () => void
  onCopyPath?: () => void
}

export function EditorTab({
  filePath,
  isActive,
  isDirty,
  operationStatus = 'idle',
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseOtherTabs,
  onCloseAllTabs,
  hasOtherTabsOfKind,
  hasOtherTabsInPane,
  onCopyPath
}: EditorTabProps): React.JSX.Element {
  const fileName = getBasename(filePath)
  const ext = getExtname(filePath).slice(1) || null

  const isBusy = operationStatus === 'saving' || operationStatus === 'reloading'
  const showSuccess = operationStatus === 'saved'
  const showStatusIndicator = isBusy || showSuccess
  // The accessible name must describe the action: 'saved' is only a visual
  // flash (Check icon), the button still closes the tab.
  const closeLabel =
    operationStatus === 'saving'
      ? 'Saving file'
      : operationStatus === 'reloading'
        ? 'Reloading file'
        : operationStatus === 'saved'
          ? `Close ${fileName}`
          : 'Close tab'

  return (
    <TabContextMenu
      kind="editor"
      onClose={onClose}
      onCloseOthers={onCloseOthers}
      onCloseAll={onCloseAll}
      onCloseOtherTabs={onCloseOtherTabs}
      onCloseAllTabs={onCloseAllTabs}
      hasOtherTabsOfKind={hasOtherTabsOfKind}
      hasOtherTabsInPane={hasOtherTabsInPane}
      isBusy={isBusy}
      onCopyPath={onCopyPath}
    >
      <div
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose, isBusy)}
        className={cn(
          'h-full px-3 flex items-center border-r border-border min-w-[100px] cursor-pointer group transition-colors',
          isActive ? 'bg-background' : 'hover:bg-secondary/50 text-muted-foreground'
        )}
      >
        <div className="flex min-w-0 items-center">
          {isDirty && <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full bg-primary-fill" />}
          <MaterialFileIcon
            name={fileName}
            extension={ext}
            isDirectory={false}
            isExpanded={false}
            depth={0}
            size={12}
            className="shrink-0"
          />
          <span
            className={cn(
              'ml-2 min-w-0 truncate text-2xs font-medium',
              isActive && 'text-foreground'
            )}
          >
            {fileName}
          </span>
        </div>
        <TabCloseReveal pinned={isActive || showStatusIndicator}>
          <button
            type="button"
            tabIndex={isActive || showStatusIndicator ? undefined : -1}
            onClick={(e) => {
              e.stopPropagation()
              // 'saved' is a transient success flash, not a close guard: only a
              // real save/reload in flight blocks closing.
              if (!isBusy) {
                onClose()
              }
            }}
            disabled={isBusy}
            aria-label={closeLabel}
            title={closeLabel}
            className={cn(
              TAB_CLOSE_BUTTON_CLASS,
              isBusy && 'disabled:cursor-wait',
              showSuccess && 'text-success'
            )}
          >
            {isBusy ? (
              <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
            ) : showSuccess ? (
              <Check size={12} className="text-success" />
            ) : (
              <X size={12} />
            )}
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}
