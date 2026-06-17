import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { currentPlatformArch } from '@/lib/agents/acp-registry'
import { findBundledIconByKey, normalizeIconSvg } from '@/lib/agents/agent-icon-catalog'
import {
  buildSupportedAcpAgents,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { cn } from '@/lib/utils'
import { useAcpStore, useConfigWarmState } from '@/stores/acp-store'

/** Render a bundled SVG icon string inline (theme-aware via currentColor). */
function InlineIcon({ svg }: { svg: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: icon SVG is sanitized via normalizeIconSvg (DOMPurify)
      dangerouslySetInnerHTML={{ __html: normalizeIconSvg(svg) }}
    />
  )
}

interface AgentRowProps {
  entry: SupportedAcpAgentEntry
}

function AgentRow({ entry }: AgentRowProps): React.JSX.Element {
  // Warm state is rolled up across every per-project process for this config
  // (the reuse/warming maps are keyed by config+cwd, so one config may own
  // several live processes).
  const warmState = useConfigWarmState(entry.configId)
  const iconEntry = useMemo(() => findBundledIconByKey(`acp:${entry.agent.id}`), [entry.agent.id])

  // Warm state for the badge: an enabled agent is warming while a background
  // spawn is in flight (any project), ready once any process is connected,
  // needs auth, or idle.
  const statusBadge: { label: string; tone: 'ready' | 'auth' | 'muted' | 'warn' } =
    warmState.connected
      ? { label: 'Ready', tone: 'ready' }
      : warmState.needsAuth
        ? { label: 'Auth required', tone: 'auth' }
        : warmState.warming
          ? { label: 'Warming…', tone: 'muted' }
          : entry.status === 'ready'
            ? { label: 'Available', tone: 'ready' }
            : entry.status === 'install-required'
              ? { label: 'Install from Agent Chat', tone: 'warn' }
              : { label: 'Unavailable', tone: 'muted' }

  return (
    <div className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
        {iconEntry ? (
          <InlineIcon svg={iconEntry.svg} />
        ) : (
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            {entry.agent.name.charAt(0)}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{entry.agent.name}</span>
          {entry.agent.version && (
            <span className="shrink-0 font-mono text-3xs text-muted-foreground">
              v{entry.agent.version}
            </span>
          )}
          <Badge
            variant="secondary"
            className={cn(
              'h-4 px-1.5 text-3xs',
              statusBadge.tone === 'ready' && 'text-green-500',
              statusBadge.tone === 'auth' && 'text-amber-500',
              statusBadge.tone === 'warn' && 'text-amber-500'
            )}
          >
            {statusBadge.label}
          </Badge>
        </div>
        {entry.agent.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {entry.agent.description}
          </p>
        )}
        {entry.status !== 'ready' && (
          <p className="mt-1 text-2xs text-amber-500">
            {entry.status === 'install-required'
              ? 'Open Agent Chat and choose Install before first use.'
              : entry.unavailableReason}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Status-only ACP agent list. Agent Chat derives these supported agents without
 * requiring a Preferences toggle; this view only shows availability/debug state.
 */
export function AcpAgentsSettings(): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const platformArch = useMemo(() => currentPlatformArch(), [])
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const supportedAgents = useMemo(
    () => buildSupportedAcpAgents(agentConfigs, platformArch),
    [agentConfigs, platformArch]
  )

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return supportedAgents
    return supportedAgents.filter(
      (entry) =>
        entry.agent.name.toLowerCase().includes(q) ||
        entry.agent.id.toLowerCase().includes(q) ||
        entry.agent.description.toLowerCase().includes(q)
    )
  }, [filter, supportedAgents])

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter agents…"
          className="h-8 pl-8 text-sm"
        />
      </div>

      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No agents match.</p>
        ) : (
          visible.map((entry) => <AgentRow key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}
