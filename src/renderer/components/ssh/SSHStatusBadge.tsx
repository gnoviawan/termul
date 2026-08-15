import type { SSHConnectionStatus } from '@shared/types/ssh.types'
import { useSshTranslation } from '@/hooks/use-ssh-translation'
import { cn } from '@/lib/utils'

interface SSHStatusBadgeProps {
  status: SSHConnectionStatus
  className?: string
}

const statusConfig = {
  disconnected: {
    labelKey: 'status.offline',
    color: 'bg-muted-foreground/30 text-muted-foreground'
  },
  connecting: { labelKey: 'status.connecting', color: 'bg-yellow-500/20 text-yellow-600' },
  connected: { labelKey: 'status.connected', color: 'bg-green-500/20 text-green-600' },
  reconnecting: { labelKey: 'status.reconnecting', color: 'bg-orange-500/20 text-orange-600' },
  failed: { labelKey: 'status.failed', color: 'bg-red-500/20 text-red-600' }
} as const satisfies Record<SSHConnectionStatus, { labelKey: string; color: string }>

export function SSHStatusBadge({ status, className }: SSHStatusBadgeProps): React.JSX.Element {
  const t = useSshTranslation()
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
      {status === 'connected' && <span className="mr-1 h-1.5 w-1.5 rounded-full bg-green-500" />}
      {t(config.labelKey)}
    </span>
  )
}
