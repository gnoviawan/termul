import type React from 'react'
import {
  ChevronDown,
  GitBranch,
  History,
  PanelRight,
  RefreshCw,
  Search,
  User
} from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import {
  FOCUS_RING_CLASS,
  PANEL_FIELD_CLASS,
  PANEL_FIELD_ICON_CLASS,
  PANEL_ICON_BUTTON_CLASS,
  pressedToggleClass
} from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { GitHistoryScope } from '@/stores/git-history-store'

const ANY_AUTHOR = '\u0000any'

const SCOPE_LABEL: Record<GitHistoryScope, string> = {
  all: 'All branches',
  head: 'Current branch'
}

const PILL_CLASS = `inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] ${FOCUS_RING_CLASS}`

interface HistoryToolbarProps {
  scope: GitHistoryScope
  onScopeChange: (scope: GitHistoryScope) => void
  query: string
  onQueryChange: (query: string) => void
  filterRef: React.RefObject<HTMLInputElement>
  onFilterKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  authors: string[]
  author: string | null
  onAuthorChange: (author: string | null) => void
  countLabel: string
  isLoading: boolean
  onRefresh: () => void
  detailOpen: boolean
  onToggleDetail: () => void
}

/** Git History toolbar: scope, filter, author, count, refresh, details. */
export function HistoryToolbar({
  scope,
  onScopeChange,
  query,
  onQueryChange,
  filterRef,
  onFilterKeyDown,
  authors,
  author,
  onAuthorChange,
  countLabel,
  isLoading,
  onRefresh,
  detailOpen,
  onToggleDetail
}: HistoryToolbarProps): React.JSX.Element {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
      <div className="flex shrink-0 items-center gap-2 text-sm font-medium text-foreground">
        <History size={16} className="text-muted-foreground" />
        History
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger className={PILL_CLASS} aria-label={`Scope: ${SCOPE_LABEL[scope]}`}>
          <GitBranch size={13} className="text-muted-foreground" />
          {SCOPE_LABEL[scope]}
          <ChevronDown size={12} className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuRadioGroup
            value={scope}
            onValueChange={(value) => onScopeChange(value as GitHistoryScope)}
          >
            <DropdownMenuRadioItem value="all">All branches</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="head">Current branch</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="relative min-w-32 max-w-[340px] flex-1">
        <Search size={13} aria-hidden className={PANEL_FIELD_ICON_CLASS} />
        <input
          ref={filterRef}
          type="text"
          placeholder="Filter by message, author or hash"
          aria-label="Filter commits"
          className={cn(PANEL_FIELD_CLASS, 'h-7 w-full pl-8 pr-8')}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onFilterKeyDown}
        />
        {!query && (
          <Kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-px">
            /
          </Kbd>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(PILL_CLASS, 'max-w-44', author && pressedToggleClass(true))}
          aria-label={author ? `Author: ${author}` : 'Filter by author'}
        >
          <User size={13} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{author ?? 'Any author'}</span>
          <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-44 overflow-y-auto">
          <DropdownMenuRadioGroup
            value={author ?? ANY_AUTHOR}
            onValueChange={(value) => onAuthorChange(value === ANY_AUTHOR ? null : value)}
          >
            <DropdownMenuRadioItem value={ANY_AUTHOR}>Any author</DropdownMenuRadioItem>
            {authors.length > 0 && <DropdownMenuSeparator />}
            {authors.map((name) => (
              <DropdownMenuRadioItem key={name} value={name}>
                <span className="truncate">{name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="flex-1" />
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground" aria-live="polite">
        {countLabel}
      </span>
      <button
        type="button"
        className={PANEL_ICON_BUTTON_CLASS}
        onClick={onRefresh}
        disabled={isLoading}
        title="Refresh history"
        aria-label="Refresh history"
      >
        {isLoading ? <Spinner size={14} decorative /> : <RefreshCw size={14} />}
      </button>
      <button
        type="button"
        className={cn(PANEL_ICON_BUTTON_CLASS, detailOpen && 'text-foreground')}
        onClick={onToggleDetail}
        aria-pressed={detailOpen}
        title={detailOpen ? 'Hide details (Esc)' : 'Show details'}
        aria-label={detailOpen ? 'Hide details' : 'Show details'}
      >
        <PanelRight size={14} />
      </button>
    </div>
  )
}
