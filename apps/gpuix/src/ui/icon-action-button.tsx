import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { Box } from './internal/host'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

interface IconActionButtonProps {
  label: string
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  className?: string
  size?: 'default' | 'sm'
}

/** Quiet icon button with a tooltip. `after:` hit-slop has no GPUIX pseudo-element; the visual box is the target. */
export function IconActionButton({
  label,
  onClick,
  children,
  disabled = false,
  className,
  size = 'default'
}: IconActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={null}
          size={null}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            size === 'sm'
              ? "relative inline-flex size-6 shrink-0 items-center justify-center p-0 after:absolute after:-inset-2.5 after:content-['']"
              : 'relative inline-flex size-11 shrink-0 items-center justify-center',
            'cursor-pointer text-muted-foreground transition-colors duration-150',
            'hover:text-foreground disabled:cursor-not-allowed disabled:text-disabled-foreground',
            '[&_svg]:block [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg.text-success]:text-success',
            className
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

interface IconActionGroupProps {
  children: ReactNode
  className?: string
  dense?: boolean
}

/** Group chrome. `backdrop-blur` has no GPUIX equivalent; the 80% sidebar fill paints alone. */
export function IconActionGroup({ children, className, dense = false }: IconActionGroupProps) {
  return (
    <Box
      className={cn(
        'pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar',
        'bg-sidebar/80 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur',
        dense ? 'px-1 py-0.5' : 'px-1.5 py-1',
        className
      )}
    >
      {children}
    </Box>
  )
}
