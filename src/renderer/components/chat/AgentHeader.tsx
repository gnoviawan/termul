import { Bot, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AcpSession, AgentStatus } from '@/stores/acp-store'

interface AgentHeaderProps {
  session: AcpSession
  agentStatus: AgentStatus | undefined
}

const STATUS_COLOR: Record<string, string> = {
  connected: 'text-green-500',
  spawning: 'text-amber-500',
  idle: 'text-muted-foreground',
  error: 'text-red-500'
}

/**
 * Agent chat header: agent identity, connection status, and a read-only view of
 * the current mode/model. Interactive mode/model switching is P2.
 */
export function AgentHeader({ session, agentStatus }: AgentHeaderProps): React.JSX.Element {
  const isClosed = session.status === 'closed'
  const currentModeId = session.modes?.currentModeId
  const currentMode = session.modes?.availableModes.find((m) => m.id === currentModeId)
  const modelOption = session.configOptions.find((o) => o.category === 'model')
  const modelValue = modelOption?.options.find((o) => o.value === modelOption.currentValue)

  const effectiveStatus: AgentStatus | undefined = isClosed ? 'error' : agentStatus

  return (
    <div className="flex items-center gap-2 border-b border-border/60 bg-card/60 px-3 py-1.5">
      <Bot size={14} className="text-primary" />
      <span className="truncate text-xs font-medium text-foreground">
        {session.title ?? `Agent ${session.agentId.slice(0, 8)}`}
      </span>
      <Circle
        size={8}
        className={cn(
          'fill-current',
          STATUS_COLOR[effectiveStatus ?? 'idle'] ?? 'text-muted-foreground'
        )}
      />
      <span className="text-[11px] text-muted-foreground">
        {isClosed ? 'closed' : (effectiveStatus ?? 'idle')}
      </span>

      <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
        {currentMode && (
          <span className="rounded bg-secondary px-1.5 py-0.5">{currentMode.name}</span>
        )}
        {modelValue && (
          <span className="rounded bg-secondary px-1.5 py-0.5">{modelValue.name}</span>
        )}
      </div>
    </div>
  )
}
