import { cn } from '@/lib/utils'

/** Transparent pixels show as a checkerboard drawn from theme tokens. */
export const CHECKERBOARD_CLASS =
  'bg-[conic-gradient(oklch(var(--muted))_25%,oklch(var(--background))_0_50%,oklch(var(--muted))_0_75%,oklch(var(--background))_0)] bg-[length:16px_16px]'

export function ViewerLoading(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full w-full items-center justify-center bg-background"
    >
      <span className="text-xs text-muted-foreground animate-pulse motion-reduce:animate-none">
        Loading...
      </span>
    </div>
  )
}

/** The info strip under a viewer: facts on the left, controls on the right. */
export function ViewerFooter({
  facts,
  children,
  className
}: {
  facts: Array<string | null>
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-xs text-muted-foreground',
        className
      )}
    >
      <span data-testid="viewer-facts" className="truncate tabular-nums">
        {facts.filter((fact) => fact !== null).join(' · ')}
      </span>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  )
}
