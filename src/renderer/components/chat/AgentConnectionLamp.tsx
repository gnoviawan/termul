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
}

/** Real-time connection indicator: green when connected, red otherwise. */
export function AgentConnectionLamp({
  connected,
  className,
  size = 8
}: AgentConnectionLampProps): ReactNode {
  return (
    <Circle
      size={size}
      aria-hidden
      className={cn(
        'shrink-0 fill-current',
        connected ? 'text-green-500' : 'text-red-500',
        className
      )}
    />
  )
}
