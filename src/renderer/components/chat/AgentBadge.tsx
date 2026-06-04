import { Bot } from 'lucide-react'
import type { AgentId } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { useAgentIdentity } from '@/stores/acp-store'
import { templateIcon } from './agent-templates'

interface AgentBadgeProps {
  agentId: AgentId
  /** Fallback name when the agent config can't be resolved. */
  fallbackName?: string
  /** Show the agent name next to the icon (default true). */
  showName?: boolean
  /** Icon size in px (default 14). */
  iconSize?: number
  className?: string
}

/**
 * Resolves an ACP agent's real name (e.g. "Cursor") and template icon from the
 * configured-agent registry, rendering them together. Falls back to a generic
 * bot icon + provided fallback when the session has no matching live config
 * (e.g. opened from history).
 */
export function AgentBadge({
  agentId,
  fallbackName,
  showName = true,
  iconSize = 14,
  className
}: AgentBadgeProps): React.JSX.Element {
  const { name, templateId } = useAgentIdentity(agentId)
  const Icon = templateIcon(templateId ?? undefined)
  const label = name ?? fallbackName ?? `Agent ${agentId.slice(0, 8)}`

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {Icon ? (
        <Icon width={iconSize} height={iconSize} className="shrink-0 text-foreground/80" />
      ) : (
        <Bot size={iconSize} className="shrink-0 text-foreground/80" />
      )}
      {showName && <span className="truncate">{label}</span>}
    </span>
  )
}
