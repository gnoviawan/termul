import type { SSHConnectionStatus } from '@shared/types/ssh.types'
import { cn } from '@/lib/utils'

interface SSHStatusBadgeProps {
  status: SSHConnectionStatus
  className?: string
}

const statusConfig: Record<SSHConnectionStatus, { label: string; color: string }> = {
  disconnected: { label: 'Offline', color: 'bg-muted-foreground/30 text-muted-foreground' },
  connecting: { label: 'Connecting', color: 'bg-warning/20 text-warning' },
  connected: { label: 'Connected', color: 'bg-success/20 text-success' },
  reconnecting: { label: 'Reconnecting', color: 'bg-warning/20 text-warning' },
  failed: { label: 'Failed', color: 'bg-destructive/20 text-destructive' }
}

export function SSHStatusBadge({ status, className }: SSHStatusBadgeProps): React.JSX.Element {
  const config = statusConfig[status]

  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-3xs font-medium',
        config.color,
        className
      )}
    >
      {(status === 'connecting' || status === 'reconnecting') && (
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
      )}
      {status === 'connected' && <span className="mr-1 h-1.5 w-1.5 rounded-full bg-success" />}
      {config.label}
    </span>
  )
}
