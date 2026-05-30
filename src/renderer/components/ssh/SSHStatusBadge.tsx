import { cn } from '@/lib/utils'
import type { SSHConnectionStatus } from '@shared/types/ssh.types'

interface SSHStatusBadgeProps {
  status: SSHConnectionStatus
  className?: string
}

const statusConfig: Record<SSHConnectionStatus, { label: string; color: string }> = {
  disconnected: { label: 'Offline', color: 'bg-muted-foreground/30 text-muted-foreground' },
  connecting: { label: 'Connecting', color: 'bg-yellow-500/20 text-yellow-600' },
  connected: { label: 'Connected', color: 'bg-green-500/20 text-green-600' },
  reconnecting: { label: 'Reconnecting', color: 'bg-orange-500/20 text-orange-600' },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-600' },
}

export function SSHStatusBadge({ status, className }: SSHStatusBadgeProps): React.JSX.Element {
  const config = statusConfig[status]

  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium',
        config.color,
        className
      )}
    >
      {(status === 'connecting' || status === 'reconnecting') && (
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
      )}
      {status === 'connected' && (
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-green-500" />
      )}
      {config.label}
    </span>
  )
}
