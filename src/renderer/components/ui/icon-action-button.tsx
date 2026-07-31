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
 * tooltip, press scale from global button feedback. Hit area matches
 * Streamdown (`p-1` + 14px icon), not the older size-10 chip.
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
            // Fixed flex box so Copy (IconSwap) and bare SVGs share one centerline.
            'inline-flex size-6 shrink-0 items-center justify-center',
            'cursor-pointer text-muted-foreground transition-colors duration-150',
            'hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
            '[&_svg]:block [&_svg]:size-3.5 [&_svg]:shrink-0',
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
