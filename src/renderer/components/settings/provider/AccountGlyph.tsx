import { cn } from '@/lib/utils'

/** The square icon beside a Claude account dialog title. */
export function AccountGlyph({
  tone,
  children
}: {
  tone: 'muted' | 'success' | 'warning'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg',
        tone === 'muted' && 'bg-muted text-secondary-foreground',
        tone === 'success' && 'bg-success/15 text-success',
        tone === 'warning' && 'bg-warning/15 text-warning'
      )}
    >
      {children}
    </span>
  )
}
