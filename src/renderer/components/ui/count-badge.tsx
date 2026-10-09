import { cn } from '@/lib/utils'

/**
 * Blue count pill (the one primary-fill count look): git change counts on
 * the activity rail and the Git Changes tab. Height, min width, type size and
 * position stay at the call site.
 */
export function CountBadge({
  count,
  max,
  className,
  'data-testid': testId
}: {
  count: number
  /** Show `${max}+` above this value. No cap when unset. */
  max?: number
  className?: string
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      className={cn(
        'flex items-center justify-center rounded-full bg-primary-fill px-1 font-semibold leading-none tabular-nums text-primary-foreground',
        className
      )}
    >
      {max !== undefined && count > max ? `${max}+` : count}
    </span>
  )
}
