import { Circle } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import type { AgentStatus } from '@/stores/acp-store'

export function isAgentConnected(
  session: { status: string } | null | undefined,
  agentStatus: AgentStatus | undefined
): boolean {
  return session != null && session.status !== 'closed' && agentStatus === 'connected'
}

interface AgentConnectionLampProps {
  connected: boolean
  className?: string
  size?: number
  /**
   * Story 5.3 (AC3): when true, render amber + `animate-pulse` to indicate a
   * transport-level reconnect is in progress (WS drop). Distinct from
   * `connected` (green) and `!connected` (red) — this is the in-between
   * "trying to reconnect" state. The visible state is also communicated via
   * the surrounding banner text in `AgentChatPanel` (the lamp itself stays
   * `aria-hidden`); the banner container carries `role="status"` +
   * `aria-live="polite"`.
   */
  reconnecting?: boolean
}

/**
 * Real-time connection indicator: green when connected, red otherwise.
 * Story 5.3: `reconnecting` shows amber + pulse for WS reconnect-in-progress.
 */
export function AgentConnectionLamp({
  connected,
  className,
  size = 8,
  reconnecting = false
}: AgentConnectionLampProps): ReactNode {
  const colorClass = reconnecting
    ? 'text-amber-500 animate-pulse'
    : connected
      ? 'text-green-500'
      : 'text-red-500'
  return (
    <Circle
      size={size}
      aria-hidden
      className={cn('shrink-0 fill-current', colorClass, className)}
    />
  )
}
