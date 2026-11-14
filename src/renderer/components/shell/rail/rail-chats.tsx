import { createContext, forwardRef, useContext, useMemo, useState } from 'react'
import type { ProjectChatLiveState } from '@/components/sidebar/project-chat-row'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { RAIL_CHAT_STATUS_DOT_CLASS } from './rail-chat-status'
import { useRailCollapsed } from './rail-density'

/** Chats a Rail project shows before "Show N more". */
export const RAIL_CHAT_LIMIT = 5

interface RailChatGroupContextValue {
  /** Every chat of the group, shown or not. */
  total: number
  limit: number
  /** A row that stays visible past the limit (the open chat). */
  pinnedIndex: number | undefined
  expanded: boolean
  setExpanded: (expanded: boolean) => void
}

const RailChatGroupContext = createContext<RailChatGroupContextValue | null>(null)

function useRailChatGroup(part: string): RailChatGroupContextValue {
  const context = useContext(RailChatGroupContext)
  if (!context) throw new Error(`${part} must be used inside <RailChatGroup>`)
  return context
}

export interface RailChatGroupProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Number of chats in the group. */
  total: number
  /** Chats shown while the group is not expanded. */
  limit?: number
  /** Start expanded (uncontrolled). */
  defaultExpanded?: boolean
  /**
   * Index of a row that stays visible while the group is collapsed, even past
   * the limit: the open chat must never hide behind "Show N more".
   */
  pinnedIndex?: number
}

/**
 * Chats under the active Rail project: 1px between rows, 4px below the
 * group. Owns the "Show N more" state that {@link RailChatItem} and
 * {@link RailShowMore} read. Compose it as
 * `RailChatGroup > RailChatList > RailChatItem > RailChatRow`, then `RailShowMore`.
 */
export const RailChatGroup = forwardRef<HTMLDivElement, RailChatGroupProps>(function RailChatGroup(
  {
    total,
    limit = RAIL_CHAT_LIMIT,
    defaultExpanded = false,
    pinnedIndex,
    className,
    children,
    ...props
  },
  ref
) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const value = useMemo(
    () => ({ total, limit, pinnedIndex, expanded, setExpanded }),
    [total, limit, pinnedIndex, expanded]
  )
  return (
    <RailChatGroupContext.Provider value={value}>
      <div ref={ref} className={cn('flex flex-col gap-px pb-1', className)} {...props}>
        {children}
      </div>
    </RailChatGroupContext.Provider>
  )
})

/** The list element of a chat group. Give it an `aria-label`. */
export const RailChatList = forwardRef<HTMLUListElement, React.ComponentPropsWithoutRef<'ul'>>(
  function RailChatList({ className, ...props }, ref) {
    return <ul ref={ref} className={cn('flex flex-col gap-px', className)} {...props} />
  }
)

export interface RailChatItemProps extends React.ComponentPropsWithoutRef<'li'> {
  /** Position in the group; rows past the limit render only when expanded. */
  index: number
}

/** One list item. Renders nothing past the limit while the group is collapsed. */
export const RailChatItem = forwardRef<HTMLLIElement, RailChatItemProps>(function RailChatItem(
  { index, ...props },
  ref
) {
  const { expanded, limit, pinnedIndex } = useRailChatGroup('RailChatItem')
  if (!expanded && index >= limit && index !== pinnedIndex) return null
  return <li ref={ref} {...props} />
})

export interface RailChatRowProps extends React.ComponentPropsWithoutRef<'button'> {
  /** The chat is open in the active pane: keycap surface and `aria-current`. */
  open?: boolean
}

/**
 * One chat row: 30px, 35px left (the agent icon sits under the project
 * name), 12px right, 9px gaps. Compose {@link RailChatIcon},
 * {@link RailChatTitle} and a trail (for example `ChatRowTrail`) inside.
 *
 * Collapsed Rail: the same 30px row with only the agent icon, centred (radius
 * 6, hover 6% foreground). The open chat keeps its keycap.
 */
export const RailChatRow = forwardRef<HTMLButtonElement, RailChatRowProps>(function RailChatRow(
  { open = false, className, ...props },
  ref
) {
  const collapsed = useRailCollapsed()
  return (
    <button
      ref={ref}
      type="button"
      aria-current={open ? 'true' : undefined}
      data-open={open || undefined}
      className={cn(
        'flex h-7.5 w-full min-w-0 items-center text-left text-xs',
        collapsed ? 'justify-center rounded-md px-0' : 'gap-2.25 rounded-lg pr-3 pl-8.75',
        'transition-colors duration-150 ease-out focus-visible:ring-inset',
        FOCUS_RING_CLASS,
        open ? 'keycap' : collapsed ? 'hover:bg-foreground/[0.06]' : 'hover:bg-row-hover',
        className
      )}
      {...props}
    />
  )
})

/** 12px agent icon box at the start of a chat row. Holds a {@link RailChatStatusDot}. */
export function RailChatIcon({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'span'>): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('relative inline-flex size-3 shrink-0 items-center justify-center', className)}
      {...props}
    />
  )
}

/**
 * 6px status dot on the agent icon's bottom-right corner (collapsed Rail,
 * where the trail is hidden): needs-you warning, running primary, new
 * activity foreground, nothing when idle. Decorative: put the status in the
 * row's accessible name.
 */
export function RailChatStatusDot({
  state,
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'span'>, 'children'> & {
  state: ProjectChatLiveState
}): React.JSX.Element | null {
  const fill = RAIL_CHAT_STATUS_DOT_CLASS[state]
  if (!fill) return null
  return (
    <span
      aria-hidden="true"
      data-rail-chat-status={state}
      className={cn('absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full', fill, className)}
      {...props}
    />
  )
}

/**
 * Chat title: fills the row and fades at its end instead of an ellipsis.
 * Not drawn on the collapsed Rail (the row's accessible name carries it).
 */
export function RailChatTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'span'>): React.JSX.Element | null {
  const collapsed = useRailCollapsed()
  if (collapsed) return null
  return (
    <span
      className={cn('fade-end min-w-0 flex-1 text-xs text-secondary-foreground', className)}
      {...props}
    />
  )
}

/**
 * "Show N more" / "Show less" under a chat group: 28px, 56px left (the
 * title column), `muted-foreground` 12px. Nothing when every chat fits.
 * Collapsed Rail: the same 28px row reads "···" (centred); its accessible
 * name keeps the words.
 */
export const RailShowMore = forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentPropsWithoutRef<'button'>, 'children'>
>(function RailShowMore({ className, onClick, ...props }, ref) {
  const { total, limit, pinnedIndex, expanded, setExpanded } = useRailChatGroup('RailShowMore')
  const collapsed = useRailCollapsed()
  const pinnedPastLimit = pinnedIndex !== undefined && pinnedIndex >= limit ? 1 : 0
  const hidden = total - limit - pinnedPastLimit
  if (hidden <= 0 && !expanded) return null
  const words = expanded ? 'Show less' : `Show ${hidden} more`
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={expanded}
      onClick={(event) => {
        setExpanded(!expanded)
        onClick?.(event)
      }}
      aria-label={
        collapsed ? (expanded ? 'Show fewer chats' : `Show ${hidden} more chats`) : undefined
      }
      className={cn(
        'flex h-7 w-full items-center text-xs text-muted-foreground',
        collapsed
          ? 'justify-center rounded-md hover:bg-foreground/[0.06]'
          : 'rounded-lg pl-14 text-left hover:bg-row-hover',
        'transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-inset',
        FOCUS_RING_CLASS,
        className
      )}
      {...props}
    >
      {collapsed ? <span aria-hidden="true">···</span> : words}
    </button>
  )
})
