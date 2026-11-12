import type { Port } from '@shared/types/automation.types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PORT_PRESENTATION } from '../ports'

/**
 * Where an edge is being drawn from. A tap-started connection waits for a tap
 * on a card (phone) or a port; a dragged one ends where it is dropped.
 */
export function ConnectBanner({
  from,
  port,
  tap,
  phone,
  onCancel
}: {
  from: string
  port: Port
  tap: boolean
  phone: boolean
  onCancel: () => void
}): React.JSX.Element {
  const source = (
    <>
      <span className="font-medium text-foreground">{from}</span>
      {port !== 'out' && (
        <>
          {' · '}
          <span className={PORT_PRESENTATION[port].tone}>{port}</span>
        </>
      )}
    </>
  )
  return (
    <div
      role="status"
      className={cn(
        'absolute top-3 z-10 flex items-center gap-3 rounded-xl border border-border bg-popover px-4 py-2 text-sm shadow-lg',
        phone ? 'inset-x-3' : 'left-1/2 -translate-x-1/2'
      )}
    >
      {phone ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-foreground">Tap a node to connect</span>
          <span className="truncate text-muted-foreground">from {source}</span>
        </span>
      ) : (
        <>
          <span className="whitespace-nowrap text-foreground">Connecting from {source}</span>
          <span className="whitespace-nowrap border-l border-border pl-3 text-xs text-muted-foreground">
            Dimmed steps cannot take this edge.
          </span>
        </>
      )}
      {tap &&
        (phone ? (
          <Button variant="outline" size="touch" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Esc to cancel
          </Button>
        ))}
    </div>
  )
}
