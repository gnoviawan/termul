import { ChevronDown, Circle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { AcpSession, AgentStatus } from '@/stores/acp-store'
import { AgentBadge } from './AgentBadge'

interface AgentHeaderProps {
  session: AcpSession
  agentStatus: AgentStatus | undefined
}

const STATUS_COLOR: Record<string, string> = {
  connected: 'text-green-500',
  spawning: 'text-amber-500',
  idle: 'text-muted-foreground',
  error: 'text-red-500',
  'needs-auth': 'text-amber-400'
}

/** A popover selector for one config option. */
export function ConfigChip({
  option,
  disabled,
  onSelect
}: {
  option: SessionConfigOption
  disabled: boolean
  onSelect: (valueId: string) => void
}): React.JSX.Element {
  const current = option.options.find((o) => o.value === option.currentValue)
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className="flex h-[30px] items-center gap-1 rounded-lg bg-foreground/[0.06] px-2.5 text-xs text-foreground/80 hover:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {current?.name ?? option.name}
          <ChevronDown size={11} className="text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {option.name}
        </div>
        {option.options.map((v) => (
          <button
            key={v.value}
            type="button"
            onClick={() => onSelect(v.value)}
            className={cn(
              'flex w-full flex-col items-start rounded px-2 py-1 text-left text-sm hover:bg-accent',
              v.value === option.currentValue && 'bg-accent/50'
            )}
          >
            <span className="font-medium">{v.name}</span>
            {v.description && (
              <span className="text-xs text-muted-foreground">{v.description}</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** A popover selector for the legacy modes API. */
export function ModeChip({
  session,
  disabled,
  onSelect
}: {
  session: AcpSession
  disabled: boolean
  onSelect: (modeId: string) => void
}): React.JSX.Element | null {
  const modes = session.modes
  if (!modes || modes.availableModes.length === 0) return null
  const current = modes.availableModes.find((m) => m.id === modes.currentModeId)
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className="flex h-[30px] items-center gap-1 rounded-lg bg-foreground/[0.06] px-2.5 text-xs text-foreground/80 hover:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {current?.name ?? 'Mode'}
          <ChevronDown size={11} className="text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Mode
        </div>
        {modes.availableModes.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onSelect(m.id)}
            className={cn(
              'flex w-full flex-col items-start rounded px-2 py-1 text-left text-sm hover:bg-accent',
              m.id === modes.currentModeId && 'bg-accent/50'
            )}
          >
            <span className="font-medium">{m.name}</span>
            {m.description && (
              <span className="text-xs text-muted-foreground">{m.description}</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Agent chat header: agent identity, connection status, and interactive
 * mode/model selectors. Config options supersede the legacy modes API
 * (ADR-003.4): when configOptions exist, the legacy mode chip is not shown.
 */
export function AgentHeader({ session, agentStatus }: AgentHeaderProps): React.JSX.Element {
  const isClosed = session.status === 'closed'
  const effectiveStatus: AgentStatus | undefined = isClosed ? 'error' : agentStatus

  return (
    <div className="flex items-center gap-2 bg-transparent px-3 py-1.5">
      <AgentBadge
        agentId={session.agentId}
        fallbackName={session.title ?? undefined}
        iconSize={14}
        className="truncate text-xs font-medium text-foreground"
      />
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
    </div>
  )
}
