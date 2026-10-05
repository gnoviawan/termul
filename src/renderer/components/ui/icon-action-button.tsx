import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface IconActionButtonProps {
  /** Accessible name and tooltip label. */
  label: string
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  className?: string
  /**
   * Layout size. `default` keeps the 44×44 WCAG touch slot (footer/user
   * controls). `sm` keeps the 24px visual slot for dense streamdown chrome
   * (code-block actions, table toolbar, tool-call rows) but pads the hit
   * area out to ~44px with an invisible pseudo-element (issue #859 —
   * sub-44px touch targets on mobile); the glyph size is unchanged.
   */
  size?: 'default' | 'sm'
}

/**
 * Compact chat/streamdown-style icon control: color-only hover, shared
 * tooltip, press scale from global button feedback. Layout slot is 44×44
 * (WCAG touch) with a centered Streamdown-sized glyph so adjacent actions
 * never share overlapping hit regions. Pass `size="sm"` for dense chrome
 * (code-block actions, table toolbar) where 44px is visually too heavy — the
 * visual slot stays 24px but an invisible pseudo-element pads the tap target
 * out to ~44px (issue #859).
 */
export function IconActionButton({
  label,
  onClick,
  children,
  disabled = false,
  className,
  size = 'default'
}: IconActionButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            size === 'sm'
              ? // 24px visual slot + invisible ~44px hit area (issue #859):
                // the ::after pseudo-element extends the tap target without
                // growing the dense chrome layout.
                "relative inline-flex size-6 shrink-0 items-center justify-center p-0 after:absolute after:-inset-2.5 after:content-['']"
              : 'relative inline-flex size-11 shrink-0 items-center justify-center',
            'cursor-pointer text-muted-foreground transition-colors duration-150',
            'hover:text-foreground disabled:cursor-not-allowed disabled:text-disabled-foreground',
            // Let explicit success/destructive tokens on the glyph win over muted.
            '[&_svg]:block [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg.text-success]:text-success',
            className
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

interface IconActionGroupProps {
  children: ReactNode
  className?: string
  /**
   * Tighten padding for dense chrome hosting `size="sm"` buttons (code-block
   * actions, table toolbar). Defaults to `false` for footer MessageActions.
   */
  dense?: boolean
}

/**
 * Streamdown code-action pill chrome — border, sidebar wash, backdrop blur.
 * Use around MessageActions so footer/user controls match code-block actions.
 * Pass `dense` for the compact variant that pairs with `size="sm"` buttons.
 */
export function IconActionGroup({
  children,
  className,
  dense = false
}: IconActionGroupProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar',
        'bg-sidebar/80 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur',
        dense ? 'px-1 py-0.5' : 'px-1.5 py-1',
        className
      )}
    >
      {children}
    </div>
  )
}
