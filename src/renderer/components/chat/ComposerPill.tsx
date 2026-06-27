import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { ChevronDown } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Canonical chrome for every composer "pill"/"chip": the agent badge, the
 * mode/model/config selector triggers, and the launcher agent picker. One
 * height (34px — matches the round attach/send buttons), one radius, one
 * padding, one background/hover, and one text treatment so the bottom toolbar
 * row stays pixel-consistent across the chat input bar and the agent launcher.
 *
 * `interactive` (default) adds hover/press feedback and disabled styling for
 * `<button>` pills; non-interactive container pills (e.g. the agent badge) opt
 * out via `interactive={false}` so they don't fake affordances.
 */
const composerPillVariants = cva(
  'flex h-[34px] min-w-0 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3 text-xs text-foreground/80',
  {
    variants: {
      interactive: {
        true: 'transition-[background-color,transform] hover:bg-foreground/[0.09] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50',
        false: ''
      }
    },
    defaultVariants: { interactive: true }
  }
)

export interface ComposerPillProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof composerPillVariants> {
  /** Merge pill chrome onto a child element instead of rendering our own (Radix Slot). */
  asChild?: boolean
  /** Underlying element when not using `asChild` (default `button`). Use `span` for non-interactive pills. */
  as?: 'button' | 'span'
  /** Native button type — only applied when rendering a `<button>`. */
  type?: 'button' | 'submit' | 'reset'
  /** Disabled state — only applied when rendering a `<button>`. */
  disabled?: boolean
  /** Append the standardized trailing chevron used by popover-trigger pills. */
  chevron?: boolean
}

export const ComposerPill = React.forwardRef<HTMLButtonElement, ComposerPillProps>(
  (
    {
      className,
      interactive,
      asChild = false,
      as = 'button',
      type,
      disabled,
      chevron,
      children,
      ...props
    },
    ref
  ) => {
    const classes = cn(composerPillVariants({ interactive }), className)

    if (asChild) {
      return (
        <Slot ref={ref} className={classes} {...props}>
          {children}
        </Slot>
      )
    }

    const content = (
      <>
        {children}
        {chevron && <ChevronDown size={12} className="shrink-0 text-muted-foreground" />}
      </>
    )

    if (as === 'span') {
      return (
        <span ref={ref as React.Ref<HTMLSpanElement>} className={classes} {...props}>
          {content}
        </span>
      )
    }

    return (
      <button ref={ref} type={type ?? 'button'} disabled={disabled} className={classes} {...props}>
        {content}
      </button>
    )
  }
)
ComposerPill.displayName = 'ComposerPill'

export { composerPillVariants }
