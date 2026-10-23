import { cn } from '@/lib/utils'
import { Box } from './internal/host'

/** Blue count pill (see the web CountBadge). */
export function CountBadge({
  count,
  max,
  className,
  'data-testid': testId
}: {
  count: number
  max?: number
  className?: string
  'data-testid'?: string
}) {
  return (
    <Box
      data-testid={testId}
      className={cn(
        'flex items-center justify-center rounded-full bg-primary-fill px-1 font-semibold leading-none tabular-nums text-primary-foreground',
        className
      )}
    >
      {max !== undefined && count > max ? `${max}+` : count}
    </Box>
  )
}
