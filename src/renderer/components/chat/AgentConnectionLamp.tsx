import { Circle } from 'lucide-react'
import type { ReactNode } from 'react'

import { useRuntimeTranslation } from '@/i18n/use-runtime-translation'
import { cn } from '@/lib/utils'

interface AgentConnectionLampProps {
  connected: boolean
  className?: string
  size?: number
  /**
   * Story 5.3 (AC3): when true, render amber + `animate-pulse` to indicate a
   * transport-level reconnect is in progress (WS drop). Distinct from
   * `connected` (green) and `!connected` (red) — this is the in-between
   * "trying to reconnect" state.
   */
  reconnecting?: boolean
  /**
   * When true, hide from the accessibility tree (parent already announces the
   * state in adjacent text, e.g. the reconnect overlay). Default false so
   * standalone lamps (tab chrome) expose a text label, not color alone.
   */
  decorative?: boolean
}

/**
 * Real-time connection indicator: green when connected, red otherwise.
 * Story 5.3: `reconnecting` shows amber + pulse for WS reconnect-in-progress.
 * Always pairs color with a text name (`aria-label` / `title`) unless decorative.
 */
export function AgentConnectionLamp({
  connected,
  className,
  size = 8,
  reconnecting = false,
  decorative = false
}: AgentConnectionLampProps): ReactNode {
  const t = useRuntimeTranslation('chat')
  const label = reconnecting
    ? t('connection.reconnecting', 'Reconnecting')
    : connected
      ? t('connection.connected', 'Connected')
      : t('connection.disconnected', 'Disconnected')
  const colorClass = reconnecting
    ? 'text-warning animate-pulse'
    : connected
      ? 'text-connection'
      : 'text-destructive'
  return (
    <span className={cn('inline-flex shrink-0', className)} title={decorative ? undefined : label}>
      <Circle
        size={size}
        aria-hidden={decorative || undefined}
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : label}
        className={cn('fill-current', colorClass)}
      />
    </span>
  )
}
