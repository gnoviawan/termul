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
}

/**
 * Compact chat/streamdown-style icon control: color-only hover, shared
 * tooltip, press scale from global button feedback. Layout slot is 44×44
 * (WCAG touch) with a centered Streamdown-sized glyph so adjacent actions
 * never share overlapping hit regions.
 */
export function IconActionButton({
  label,
  onClick,
  children,
  disabled = false,
  className
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
            // 44×44 layout slot; glyph stays Streamdown-sized via [&_svg].
            'relative inline-flex size-11 shrink-0 items-center justify-center',
            'cursor-pointer text-muted-foreground transition-colors duration-150',
            'hover:text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/50',
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
}

/**
 * Streamdown code-action pill chrome — border, sidebar wash, backdrop blur.
 * Use around MessageActions so footer/user controls match code-block actions.
 */
export function IconActionGroup({ children, className }: IconActionGroupProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar',
        'bg-sidebar/80 px-1.5 py-1',
        'supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur',
        className
      )}
    >
      {children}
    </div>
  )
}
