import type { ReactNode } from 'react'
import { Circle } from '@/components/icons'

import { cn } from '@/lib/utils'

function connectionLabel(connected: boolean, reconnecting: boolean, hostOffline: boolean): string {
  if (hostOffline) return 'Host offline'
  if (reconnecting) return 'Reconnecting'
  return connected ? 'Connected' : 'Disconnected'
}

const STATUS_TONE_CLASS = {
  hostOffline: 'text-muted-foreground',
  reconnecting: 'text-warning animate-pulse motion-reduce:animate-none',
  connected: 'text-connection',
  disconnected: 'text-destructive'
} as const

function statusToneClass(connected: boolean, reconnecting: boolean, hostOffline: boolean): string {
  if (hostOffline) return STATUS_TONE_CLASS.hostOffline
  if (reconnecting) return STATUS_TONE_CLASS.reconnecting
  return connected ? STATUS_TONE_CLASS.connected : STATUS_TONE_CLASS.disconnected
}

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
   * The host stopped on purpose (`Close(1001)`): a steady muted lamp, no pulse —
   * nothing is retrying fast, the client waits for the host to come back.
   * Wins over `reconnecting` and `connected`.
   */
  hostOffline?: boolean
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
  hostOffline = false,
  decorative = false
}: AgentConnectionLampProps): ReactNode {
  const label = connectionLabel(connected, reconnecting, hostOffline)
  return (
    <span className={cn('inline-flex shrink-0', className)} title={decorative ? undefined : label}>
      <Circle
        size={size}
        aria-hidden={decorative || undefined}
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : label}
        className={cn(statusToneClass(connected, reconnecting, hostOffline), 'fill-current')}
      />
    </span>
  )
}
