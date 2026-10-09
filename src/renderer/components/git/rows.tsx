import type { GitFileStatus } from '@shared/types/ipc.types'
import type React from 'react'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { GIT_STATUS_LABELS } from '@/components/git/git-status-badge'
import { ChevronDown, Search } from '@/components/icons'
import {
  FOCUS_RING_CLASS,
  PANEL_FIELD_CLASS,
  PANEL_FIELD_ICON_CLASS,
  QUIET_ICON_BUTTON_CLASS
} from '@/components/ui/panel-styles'
import { GIT_STATUS_LETTER, GIT_STATUS_TEXT_CLASS } from '@/lib/git-status-display'
import { cn } from '@/lib/utils'

/** Icon-button chrome for section and row actions. `danger` swaps the hover tone. */
function actionButtonClass(variant?: 'danger') {
  return cn(
    QUIET_ICON_BUTTON_CLASS,
    'disabled:opacity-40 disabled:cursor-not-allowed',
    variant === 'danger' && 'hover:bg-destructive/10 hover:text-destructive'
  )
}

/** Split a repo-relative path into its file name and parent dir ('' at the root). */
export function splitGitPath(path: string): { fileName: string; dirName: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { fileName: path, dirName: '' }
    : { fileName: path.slice(slash + 1) || path, dirName: path.slice(0, slash) }
}

/** 14px file-type icon for a file name in the Git panel. */
export function GitFileIcon({ fileName }: { fileName: string }) {
  const dot = fileName.lastIndexOf('.')
  return (
    <MaterialFileIcon
      name={fileName}
      extension={dot > 0 ? fileName.slice(dot) : null}
      isDirectory={false}
      isExpanded={false}
      depth={0}
      size={14}
    />
  )
}

/** Shared "Filter changes" field at the top of the changes list. */
export function ChangesFilter({
  value,
  onChange,
  variant
}: {
  value: string
  onChange: (value: string) => void
  /** Story 10: `mobile` grows the field to the touch floor. */
  variant?: 'mobile'
}) {
  return (
    <div className="relative">
      <Search size={13} aria-hidden className={PANEL_FIELD_ICON_CLASS} />
      <input
        type="text"
        aria-label="Filter changes"
        placeholder="Filter changes"
        className={cn(
          PANEL_FIELD_CLASS,
          'w-full pl-7 pr-2.5',
          variant === 'mobile' ? 'h-11' : 'h-8'
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

export function SectionHeader({
  label,
  count,
  selectionCount,
  children
}: {
  label: string
  count: number
  selectionCount: number
  children?: React.ReactNode
}) {
  return (
    <div className="group/section flex h-8 items-center gap-1.5 pl-2 pr-1">
      <ChevronDown size={11} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="label-panel truncate">{label}</span>
      <span className="text-2xs tabular-nums text-muted-foreground">{count}</span>
      {selectionCount > 1 && (
        <span className="truncate text-2xs tabular-nums text-muted-foreground">
          · {selectionCount} selected
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">{children}</div>
    </div>
  )
}

export function SectionAction({
  icon,
  label,
  onClick,
  disabled,
  variant
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'danger'
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(actionButtonClass(variant), 'size-6')}
    >
      {icon}
    </button>
  )
}

export function RowAction({
  icon,
  label,
  onClick,
  disabled,
  touch,
  variant
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  /** Story 10: mobile rows pass `touch` — grows the hit area to the 44px
      floor via hit-slop (32px visual + −inset-1.5 ≈ 48×48 tappable);
      desktop rows stay 24×24. */
  touch?: boolean
  variant?: 'danger'
}) {
  // Stop the click from bubbling to the row, which would otherwise change the
  // selection / diff target instead of running the action.
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onClick()
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={handleClick}
      className={cn(
        actionButtonClass(variant),
        touch ? "relative size-8 after:absolute after:-inset-1.5 after:content-['']" : 'h-6 w-6'
      )}
    >
      {icon}
    </button>
  )
}

/**
 * Git status letter (M / A / U / D / R), from the file explorer's tables so
 * both surfaces stay in sync. `staged` is a legacy value the backend no longer
 * sends; it reads as modified, as in the explorer.
 */
export function GitStatusLetter({
  status,
  className
}: {
  status: GitFileStatus
  className?: string
}) {
  const letterStatus = status === 'staged' ? 'modified' : status
  const label = GIT_STATUS_LABELS[status]
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={cn(
        'w-3 shrink-0 text-center font-mono text-2xs font-semibold',
        GIT_STATUS_TEXT_CLASS[letterStatus],
        className
      )}
    >
      {GIT_STATUS_LETTER[letterStatus]}
    </span>
  )
}

/** File row look per state; the name inherits the row's text colour. */
const ROW_STATE_CLASS: Record<'active' | 'selected' | 'idle', string> = {
  /** The row whose diff is open: the "you are here" keycap. */
  active: 'keycap text-foreground',
  selected: 'bg-foreground/[0.06] text-foreground',
  idle: 'text-secondary-foreground hover:bg-foreground/[0.03]'
}

export function FileItem({
  file,
  isActive,
  isSelected,
  onClick,
  variant,
  children
}: {
  file: { path: string; status: GitFileStatus }
  /** The row whose diff is open — the "you are here" keycap. */
  isActive: boolean
  /** Part of the multi-selection. */
  isSelected: boolean
  onClick: (e: React.MouseEvent | React.KeyboardEvent) => void
  /** Story 10: `mobile` lifts the dir text to the 12px floor and grows the
      row to the touch floor; desktop keeps the dense 28px row. */
  variant?: 'mobile'
  children?: React.ReactNode
}) {
  const { fileName, dirName } = splitGitPath(file.path)
  const isMobile = variant === 'mobile'

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.currentTarget !== e.target) {
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick(e)
    }
  }

  return (
    <div
      role="option"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-selected={isActive || isSelected}
      className={cn(
        'group/row flex w-full min-w-0 items-center gap-2 rounded-md pl-2 pr-1 text-left text-xs cursor-pointer select-none transition-colors duration-150 ease-out',
        FOCUS_RING_CLASS,
        isMobile ? 'min-h-11 py-1' : 'h-7',
        ROW_STATE_CLASS[isActive ? 'active' : isSelected ? 'selected' : 'idle']
      )}
    >
      <GitFileIcon fileName={fileName} />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        <span className="shrink-0 truncate max-w-full text-xs">{fileName}</span>
        {dirName && (
          <span
            className={cn(
              'min-w-0 truncate text-muted-foreground',
              isMobile ? 'text-xs' : 'text-2xs'
            )}
          >
            {dirName}
          </span>
        )}
      </div>
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 transition-opacity duration-150 ease-out focus-within:opacity-100',
          isMobile ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
        )}
      >
        {children}
      </div>
      <GitStatusLetter status={file.status} />
    </div>
  )
}
