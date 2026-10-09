import { motion, useReducedMotion } from 'framer-motion'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface TrackItem {
  key: string
  label: ReactNode
  /** Accessible name when `label` is not plain text (glyph-only tabs). */
  ariaLabel?: string
  title?: string
  /** Grid columns this item spans. Default 1. */
  span?: number
  selected?: boolean
  disabled?: boolean
  /** `label`: a static caption cell (not a control). */
  kind?: 'option' | 'label'
  tone?: 'default' | 'primary'
  onSelect?: () => void
  testId?: string
}

/**
 * One track of equal grid columns: the selector's agent tabs, Effort,
 * a config option (Context 256K | 500K), or an action row. The selected item
 * gets a foreground/10 thumb that slides between items in 150ms. Font weight
 * never changes with state; only color does. Left and Right move the focus.
 */
export function SegmentedTrack({
  id,
  label,
  items,
  semantics = 'buttons',
  touch = false,
  columns: columnsProp,
  template,
  className
}: {
  /** Unique per mounted track; keys the sliding thumb. */
  id: string
  /** Accessible name of the whole track. */
  label: string
  items: TrackItem[]
  semantics?: 'tabs' | 'buttons'
  /** Mobile: 44px items and 13px text. */
  touch?: boolean
  /** Grid columns. Default: the sum of the item spans (one row). */
  columns?: number
  /** Full `grid-template-columns`, for a caption column sized to its text. */
  template?: string
  className?: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const columns = columnsProp ?? items.reduce((sum, item) => sum + (item.span ?? 1), 0)

  // Selection reflows — the selected pill grows (span 1 → 2), neighbors shift,
  // and the launcher's agent tabs reorder (current pinned first) — FLIP-animate
  // instead of jumping. The content span is a layout element too, so framer
  // counterscales it and the text never stretches mid-animation. Timing matches
  // the sliding thumb (150ms ease-out) so pill and thumb move as one piece.
  const animateLayout = !reduced

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    )
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0 || buttons.length === 0) return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : -1
    buttons[(index + step + buttons.length) % buttons.length]?.focus()
  }

  const trackClass = cn('grid gap-0.5 rounded-lg bg-muted p-0.5', className)
  const trackStyle = { gridTemplateColumns: template ?? `repeat(${columns}, minmax(0, 1fr))` }
  const cells = items.map((item) => {
    const span = { gridColumn: `span ${item.span ?? 1} / span ${item.span ?? 1}` }
    const size = touch ? 'h-11 text-sm' : 'h-7 text-xs'
    if (item.kind === 'label') {
      return (
        <span
          key={item.key}
          style={span}
          title={item.title}
          className={cn(
            'flex min-w-0 items-center justify-center truncate px-2.5 text-muted-foreground',
            size
          )}
        >
          {item.label}
        </span>
      )
    }
    const primary = item.tone === 'primary'
    return (
      <motion.button
        key={item.key}
        type="button"
        style={span}
        layout={animateLayout}
        transition={reduced ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
        {...(semantics === 'tabs'
          ? { role: 'tab', 'aria-selected': Boolean(item.selected) }
          : { 'aria-pressed': primary ? undefined : Boolean(item.selected) })}
        aria-label={item.ariaLabel}
        title={item.title}
        disabled={item.disabled}
        data-testid={item.testId}
        data-press-feedback="off"
        onClick={item.onSelect}
        // Press feedback lives here, not in a CSS :active scale: framer's
        // layout animations leave an inline `transform` on the element, which
        // would permanently override a class-based active scale.
        whileTap={reduced ? undefined : { scale: 0.96 }}
        className={cn(
          'relative flex min-w-0 items-center justify-center gap-1.5 rounded-md px-1',
          'transition-[color,background-color] duration-150 ease-out',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
          size,
          primary
            ? 'bg-primary-fill text-primary-foreground'
            : item.selected
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
        )}
      >
        {item.selected && !primary ? (
          <motion.span
            layoutId={`${id}-thumb`}
            aria-hidden="true"
            className="absolute inset-0 rounded-md bg-foreground/10"
            transition={reduced ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
          />
        ) : null}
        <motion.span
          layout={animateLayout}
          transition={reduced ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
          className="relative flex min-w-0 items-center gap-1.5 truncate tabular-nums"
        >
          {item.label}
        </motion.span>
      </motion.button>
    )
  })

  // Two static containers so the roles stay visible to the a11y lint.
  return semantics === 'tabs' ? (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={trackClass}
      style={trackStyle}
    >
      {cells}
    </div>
  ) : (
    <fieldset
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('min-w-0', trackClass)}
      style={trackStyle}
    >
      {cells}
    </fieldset>
  )
}
