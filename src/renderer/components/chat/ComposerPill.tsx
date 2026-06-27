import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { ChevronDown } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Canonical chrome for flat composer controls: mode/model/config selector triggers
 * and the launcher agent picker. One padding, one text treatment, and one hover
 * so the bottom toolbar row stays pixel-consistent across the chat input bar and
 * the agent launcher.
 *
 * `interactive` (default) adds hover feedback and disabled styling for `<button>`
 * triggers; non-interactive containers opt out via `interactive={false}`.
 */
const composerPillVariants = cva(
  'inline-flex min-w-0 items-center gap-1 px-1 py-1 text-xs text-muted-foreground',
  {
    variants: {
      interactive: {
        true: 'transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
        false: ''
      }
    },
    defaultVariants: { interactive: true }
  }
)

export interface ComposerPillProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof composerPillVariants> {
  /** Merge control chrome onto a child element instead of rendering our own (Radix Slot). */
  asChild?: boolean
  /** Underlying element when not using `asChild` (default `button`). Use `span` for non-interactive labels. */
  as?: 'button' | 'span'
  /** Native button type — only applied when rendering a `<button>`. */
  type?: 'button' | 'submit' | 'reset'
  /** Disabled state — only applied when rendering a `<button>`. */
  disabled?: boolean
  /** Append the standardized trailing chevron used by popover-trigger controls. */
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
