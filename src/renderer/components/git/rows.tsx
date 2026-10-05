import type { GitFileStatus } from '@shared/types/ipc.types'
import type React from 'react'
import { GitStatusBadge } from '@/components/git/git-status-badge'
import { ChevronDown } from '@/components/icons'
import { cn } from '@/lib/utils'

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
    <div className="group/section flex items-center justify-between px-2 py-1">
      <div className="label-group text-muted-foreground flex items-center gap-2 tabular-nums">
        <ChevronDown size={12} />
        {label} ({count})
        {selectionCount > 1 && (
          <span className="text-primary normal-case font-medium">· {selectionCount} selected</span>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-60 group-hover/section:opacity-100 focus-within:opacity-100 transition-opacity">
        {children}
      </div>
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
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        variant === 'danger'
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      )}
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
        'flex items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        touch ? 'relative size-8' : 'h-6 w-6',
        touch && "after:absolute after:-inset-1.5 after:content-['']",
        variant === 'danger'
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      )}
    >
      {icon}
    </button>
  )
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
  isActive: boolean
  isSelected: boolean
  onClick: (e: React.MouseEvent | React.KeyboardEvent) => void
  /** Story 10: `mobile` lifts the filename/dir text to the 12px floor;
      desktop keeps its denser text-2xs/text-4xs scale. */
  variant?: 'mobile'
  children?: React.ReactNode
}) {
  const fileName = file.path.split('/').pop() || file.path
  const dirName = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : ''
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
      aria-selected={isSelected || isActive}
      className={cn(
        'group/row flex w-full items-center gap-3 px-3 py-2 rounded-md text-left cursor-pointer transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        isSelected
          ? 'bg-primary/15 text-foreground'
          : isActive
            ? 'bg-primary/10 text-primary'
            : 'hover:bg-secondary/80 text-muted-foreground hover:text-foreground'
      )}
    >
      <GitStatusBadge status={file.status} />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <span
          className={cn('font-medium truncate leading-tight', isMobile ? 'text-xs' : 'text-2xs')}
        >
          {fileName}
        </span>
        {dirName && (
          <span
            className={cn('truncate opacity-50 leading-tight', isMobile ? 'text-xs' : 'text-4xs')}
          >
            {dirName}
          </span>
        )}
      </div>
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100',
          isSelected || isActive ? 'opacity-100' : 'opacity-60 group-hover/row:opacity-100',
          isMobile && 'opacity-100'
        )}
      >
        {children}
      </div>
    </div>
  )
}
