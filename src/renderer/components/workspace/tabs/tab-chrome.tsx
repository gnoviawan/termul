import { motion, useReducedMotion } from 'framer-motion'
import { createContext, forwardRef, useContext } from 'react'
import { Check, X as XIcon } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import { EASE_OUT } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { handleTabAuxClick } from '../tab-context-menu'
import type { TabInlineProps } from './types'

/**
 * Keycap track chrome — the single tab shell every workspace tab kind
 * renders through (Varian B): a quiet track, a raised active keycap that
 * slides between tabs, a reserved close slot that never shifts the row,
 * and one status slot after the label.
 *
 * The shell owns: selection keycap, hover/active surfaces, drag + drop
 * indicator, middle-click close, the dirty↔close cross-fade, the live-turn
 * bottom edge, and tab roles. Kinds only decide the icon slot, the label,
 * one optional trailing slot (count pill / status / chip), and close state.
 */

/** Layout id scope: the keycap slides within one pane, never across panes. */
const TabPaneContext = createContext<string | null>(null)

export function TabPaneProvider({
  paneId,
  children
}: {
  paneId: string
  children: React.ReactNode
}): React.JSX.Element {
  return <TabPaneContext.Provider value={paneId}>{children}</TabPaneContext.Provider>
}

function useTabPaneId(): string {
  return useContext(TabPaneContext) ?? 'pane'
}

/** Raised active-tab surface; slides between tabs via shared layout. */
function TabKeycap({ active }: { active: boolean }): React.JSX.Element | null {
  const paneId = useTabPaneId()
  const reducedMotion = useReducedMotion() ?? false
  if (!active) return null
  return (
    <motion.div
      layoutId={`tab-keycap-${paneId}`}
      // Content switches instantly; the keycap only chases it — motion here
      // is spatial continuity, never a gate on the action itself.
      transition={reducedMotion ? { duration: 0 } : { layout: { duration: 0.18, ease: EASE_OUT } }}
      aria-hidden
      className="keycap pointer-events-none absolute inset-0 rounded-lg"
    />
  )
}

export interface TabChromeOwnProps extends Omit<TabInlineProps, 'bulkMenu'> {
  /** 12px identity slot: kind icon, Material file icon, or agent badge. */
  icon: React.ReactNode
  label: string
  /** Inline rename (terminal) replaces the label node entirely. */
  labelOverride?: React.ReactNode
  /** Single trailing slot: count pill, live status, or agent chip. */
  after?: React.ReactNode
  onClose: () => void
  closeAriaLabel?: string
  /** Close in flight or editor busy — button disabled, spinner shown. */
  closeDisabled?: boolean
  /** 'check' renders the transient saved flash in the close slot. */
  closeContent?: 'default' | 'spinner' | 'check'
  /** Unsaved marker: dot in the close slot until hover swaps to X. */
  dirty?: boolean
  /** Live agent turn: paints the 2px bottom edge. */
  alive?: boolean
  /** Keep the close control visible without hover (active / busy tabs). */
  pinClose?: boolean
  /** No HTML5 drag while the inline rename input is open. */
  dragDisabled?: boolean
  /** Accessible name override (agent tabs append status text). */
  ariaLabel?: string
  /** Tooltip for a truncating label; defaults to the label itself. */
  title?: string
  /** Double-click on the label (terminal inline rename). */
  onLabelDoubleClick?: () => void
}

/**
 * The chrome renders inside `<TabContextMenu>`'s `asChild` trigger, so
 * Radix composes its trigger props (onContextMenu, data-state) straight
 * onto this component. Everything it passes that the shell does not own
 * explicitly is forwarded to the root div; the shell takes the ref too.
 */
type TabChromeHTMLProps = Omit<React.ComponentPropsWithoutRef<'div'>, keyof TabChromeOwnProps>

export interface TabChromeProps extends TabChromeOwnProps, TabChromeHTMLProps {}

export const TabChrome = forwardRef<HTMLDivElement, TabChromeProps>(function TabChrome(
  {
    isActive,
    isDragging,
    isDropTarget,
    dropPosition,
    onSelect,
    onClose,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    icon,
    label,
    labelOverride,
    after,
    closeAriaLabel,
    closeDisabled = false,
    closeContent = 'default',
    dirty = false,
    alive = false,
    pinClose = false,
    dragDisabled = false,
    ariaLabel,
    title: titleProp,
    onLabelDoubleClick,
    ...rest
  },
  ref
) {
  // Busy and saved-flash states pin the close control: the spinner and check
  // must be readable without hover, same as the active tab's X.
  const pinned = pinClose || closeDisabled || closeContent === 'check'

  return (
    <div
      ref={ref}
      {...rest}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      aria-label={ariaLabel}
      draggable={!dragDisabled}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onSelect}
      onKeyDown={(e) => {
        // Keyboard activation for the tab role: Enter/Space select the tab.
        // Roving arrow-key order across tabs is a follow-up.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onAuxClick={(e) => handleTabAuxClick(e, onClose, closeDisabled || dragDisabled)}
      className={cn(
        'group/tab relative flex h-8 min-w-[100px] max-w-[200px] shrink-0 cursor-pointer select-none items-center rounded-lg px-2.5',
        'transition-colors duration-150 ease-out',
        isActive
          ? 'text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        isDragging && 'opacity-50 scale-[0.98]'
      )}
    >
      <TabKeycap active={isActive} />

      {/* Drop indicator: absolute line, never a border — no reflow mid-drag. */}
      {isDropTarget && dropPosition === 'before' && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 z-10 w-0.5 rounded-full bg-primary-fill"
        />
      )}
      {isDropTarget && dropPosition === 'after' && (
        <span
          aria-hidden
          className="absolute inset-y-1 right-0 z-10 w-0.5 rounded-full bg-primary-fill"
        />
      )}

      {/* Live turn edge: 2px primary fade that dies with the turn. */}
      {alive && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 animate-alive-in rounded-full bg-[linear-gradient(90deg,oklch(var(--primary)),oklch(var(--primary)/0))] motion-reduce:animate-none"
        />
      )}

      <div className="relative z-[1] flex min-w-0 flex-1 items-center gap-2">
        <span aria-hidden className="flex shrink-0 items-center">
          {icon}
        </span>
        {labelOverride ?? (
          // biome-ignore lint/a11y/noStaticElementInteractions: double-click is the terminal's inline-rename affordance; the enclosing tab carries role="tab"
          <span
            title={titleProp ?? label}
            onDoubleClick={onLabelDoubleClick}
            className="min-w-0 truncate text-xs font-medium leading-none"
          >
            {label}
          </span>
        )}
        {after}
      </div>

      {/* Reserved close slot — always in flow, so hover never reflows the
          row. Invisible until pinned or hovered (pointer-fine only); on
          touch, inactive tabs close through the context menu. */}
      <div className="group/zone relative z-[1] -mr-1 flex h-8 w-6 shrink-0 items-center justify-center">
        {dirty && (
          <span
            aria-hidden
            className="pointer-events-none absolute size-2 rounded-full bg-foreground/70 opacity-100 transition-opacity duration-150 ease-out group-hover/zone:opacity-0 motion-reduce:transition-none"
          />
        )}
        <button
          type="button"
          tabIndex={pinned ? undefined : -1}
          aria-label={closeAriaLabel ?? 'Close tab'}
          title={closeAriaLabel ?? 'Close tab'}
          onClick={(e) => {
            e.stopPropagation()
            if (!closeDisabled) onClose()
          }}
          disabled={closeDisabled}
          className={cn(
            'relative flex size-4 items-center justify-center rounded-md',
            'transition-opacity duration-150 ease-out motion-reduce:transition-none',
            'after:absolute after:-inset-1.5 after:rounded-md after:content-[""]',
            pinned ? 'opacity-100' : 'opacity-0 pointer-events-none',
            !pinned &&
              'pointer-fine:group-hover/tab:pointer-events-auto pointer-fine:group-hover/tab:opacity-100',
            closeDisabled && 'disabled:cursor-wait'
          )}
        >
          {closeDisabled || closeContent === 'spinner' ? (
            <Spinner size={12} decorative />
          ) : closeContent === 'check' ? (
            <Check size={12} className="text-success" />
          ) : (
            <XIcon
              size={11}
              className={cn(
                'text-muted-foreground transition-opacity duration-150 ease-out group-hover/zone:text-foreground motion-reduce:transition-none',
                // Dirty tabs show the dot until the slot is hovered; the X
                // cross-fades in over it.
                dirty && 'opacity-0 group-hover/zone:opacity-100'
              )}
            />
          )}
        </button>
      </div>
    </div>
  )
})
