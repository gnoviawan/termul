import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { type AgentConfig, acpApi } from '@/lib/acp-api'
import {
  currentPlatformArch,
  deriveAgentConfig,
  REGISTRY_AGENTS,
  type RegistryAgent
} from '@/lib/agents/acp-registry'
import { findBundledIconByKey, normalizeIconSvg } from '@/lib/agents/agent-icon-catalog'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'

/** Persisted-config id for a registry agent. */
function registryConfigId(regId: string): string {
  return `acp-registry:${regId}`
}

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
  agent: RegistryAgent
  platformArch: string
}

function AgentRow({ agent, platformArch }: AgentRowProps): React.JSX.Element {
  const configId = registryConfigId(agent.id)
  const enabled = useAcpStore((s) => s.agentConfigs.some((c) => c.id === configId))
  const warming = useAcpStore((s) => Boolean(s.warmingConfigs[configId]))
  const liveAgentId = useAcpStore((s) => s.configToLiveAgent[configId])
  const warmStatus = useAcpStore((s) => (liveAgentId ? s.agentStatus[liveAgentId] : undefined))
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const deleteAgentConfig = useAcpStore((s) => s.deleteAgentConfig)
  const prewarmAgent = useAcpStore((s) => s.prewarmAgent)

  const derived = useMemo(() => deriveAgentConfig(agent, platformArch), [agent, platformArch])
  const iconEntry = useMemo(() => findBundledIconByKey(`acp:${agent.id}`), [agent.id])
  const [installing, setInstalling] = useState(false)
  const canEnable =
    derived.kind === 'runnable' || (derived.kind === 'needs-install' && Boolean(derived.archiveUrl))
  const runnable = derived.kind === 'runnable'

  const enableWithConfig = async (config: AgentConfig): Promise<void> => {
    await saveAgentConfig({
      id: configId,
      templateId: agent.id,
      ...config
    })
    void prewarmAgent(configId)
  }

  const handleToggle = async (next: boolean): Promise<void> => {
    try {
      if (next) {
        if (!canEnable) return
        if (derived.kind === 'runnable') {
          await enableWithConfig(derived.config)
          return
        }
        if (derived.kind === 'needs-install' && derived.archiveUrl) {
          setInstalling(true)
          try {
            const installed = await acpApi.installRegistryBinary({
              agentId: agent.id,
              archiveUrl: derived.archiveUrl,
              cmd: derived.cmd,
              args: derived.args
            })
            await enableWithConfig({
              name: agent.name,
              command: installed.command,
              args: installed.args,
              env: derived.env,
              allowTerminal: false
            })
          } finally {
            setInstalling(false)
          }
          return
        }
      } else {
        await deleteAgentConfig(configId)
      }
    } catch (err) {
      toast.error(`Failed to ${next ? 'enable' : 'disable'} ${agent.name}: ${String(err)}`)
    }
  }

  // Warm state for the badge: an enabled agent is warming while its background
  // spawn is in flight, ready once connected, needs auth, or failed.
  const warmBadge: { label: string; tone: 'ready' | 'auth' | 'muted' } | null = !enabled
    ? null
    : warmStatus === 'connected'
      ? { label: 'Ready', tone: 'ready' }
      : warmStatus === 'needs-auth'
        ? { label: 'Auth required', tone: 'auth' }
        : warming
          ? { label: 'Warming…', tone: 'muted' }
          : null

  return (
    <div className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
        {iconEntry ? (
          <InlineIcon svg={iconEntry.svg} />
        ) : (
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            {agent.name.charAt(0)}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
          {agent.version && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              v{agent.version}
            </span>
          )}
          {warmBadge && (
            <Badge
              variant="secondary"
              className={cn(
                'h-4 px-1.5 text-[10px]',
                warmBadge.tone === 'ready' && 'text-green-500',
                warmBadge.tone === 'auth' && 'text-amber-500'
              )}
            >
              {warmBadge.label}
            </Badge>
          )}
        </div>
        {agent.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>
        )}
        {!runnable && (
          <p className="mt-1 text-[11px] text-amber-500">
            {derived.kind === 'needs-install'
              ? derived.archiveUrl
                ? installing
                  ? 'Downloading and installing…'
                  : 'Turn on to download the release binary for your platform.'
                : 'Install the binary manually, then add a custom agent.'
              : 'Not available for your platform.'}
          </p>
        )}
      </div>

      <div className="shrink-0 pt-0.5">
        <Switch
          checked={enabled}
          disabled={(!canEnable && !enabled) || installing}
          onCheckedChange={handleToggle}
          aria-label={`Enable ${agent.name}`}
        />
      </div>
    </div>
  )
}

/**
 * Registry-driven ACP agent list. Lists every agent from the offline snapshot
 * with an enable toggle; enabling derives an `AgentConfig` for the current
 * OS/arch, persists it, and warms the process in the background.
 */
export function AcpAgentsSettings(): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const platformArch = useMemo(() => currentPlatformArch(), [])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return REGISTRY_AGENTS
    return REGISTRY_AGENTS.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
    )
  }, [filter])

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

      <div className="space-y-2">
        {visible.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No agents match.</p>
        ) : (
          visible.map((agent) => (
            <AgentRow key={agent.id} agent={agent} platformArch={platformArch} />
          ))
        )}
      </div>
    </div>
  )
}
