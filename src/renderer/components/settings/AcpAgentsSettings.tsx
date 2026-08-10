import { Clipboard, Plus, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CustomAcpAgentDialog, exportAgentConfig } from '@/components/agents/CustomAcpAgentDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAcpRegistryCatalog } from '@/hooks/use-acp-registry-catalog'
import { useResolvedSupportedAcpAgents } from '@/hooks/use-resolved-supported-acp-agents'
import { findBundledIconByKey, normalizeIconSvg } from '@/lib/agents/agent-icon-catalog'
import {
  filterSupportedAcpAgents,
  isCustomAgentEntry,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { dialogApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
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

function AgentPathEditor({ entry }: { entry: SupportedAcpAgentEntry }): React.JSX.Element | null {
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const deleteAgentConfig = useAcpStore((s) => s.deleteAgentConfig)
  const [path, setPath] = useState(entry.config?.command ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setPath(entry.config?.command ?? '')
  }, [entry.config?.command])

  if (!entry.config) return null

  const savePath = async (): Promise<void> => {
    const base = entry.config
    if (!base) return
    const command = path.trim()
    if (!command) {
      toast.error('Enter the path to the ACP binary.')
      return
    }
    setSaving(true)
    try {
      // If the generated config was launcher-backed (npx/uvx), its args are the
      // package-manager invocation (e.g. `-y @scope/agent`). Browsing to a real
      // binary must clear those args or the saved command/args pair will not
      // launch correctly.
      const wasLauncherBacked = base.command === 'npx' || base.command === 'uvx'
      await saveAgentConfig({
        ...base,
        command,
        args: wasLauncherBacked ? [] : base.args
      })
      toast.success(`${entry.agent.name} path updated`)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSaving(false)
    }
  }

  const clearPath = async (): Promise<void> => {
    setSaving(true)
    try {
      // Delete by the persisted record's `id` (not `configId`): a custom agent
      // pasted with an exported `configId` keeps that configId but gets a fresh
      // stored `id`, so deleting by configId would miss it. Catalog overrides
      // have id == configId (`acp-registry:<id>`), so this is equivalent there.
      // `entry.config` is guaranteed non-null here (AgentPathEditor returns
      // null when it is absent).
      await deleteAgentConfig(entry.config!.id)
      toast.success(`${entry.agent.name} custom path cleared`)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="Path to ACP binary"
          aria-label={`${entry.agent.name} executable path`}
          className="h-7 font-mono text-xs"
          disabled={saving}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() =>
            void dialogApi.selectFile({ title: 'Select ACP agent executable' }).then((result) => {
              if (result.success && result.data) setPath(result.data)
            })
          }
        >
          Browse
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving || path.trim().length === 0}
          onClick={() => void savePath()}
        >
          Save path
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => void clearPath()}
        >
          Clear saved path
        </Button>
      </div>
    </div>
  )
}

interface AgentRowProps {
  entry: SupportedAcpAgentEntry
}

function AgentRow({ entry }: AgentRowProps): React.JSX.Element {
  const warmState = useConfigWarmState(entry.configId)
  const iconEntry = useMemo(() => findBundledIconByKey(`acp:${entry.agent.id}`), [entry.agent.id])

  const statusBadge: { label: string; tone: 'ready' | 'muted' | 'warn' } = warmState.sessionReady
    ? { label: 'Session ready', tone: 'ready' }
    : warmState.warming || warmState.warmingSession
      ? { label: 'Warming…', tone: 'muted' }
      : warmState.connected
        ? { label: 'Warm', tone: 'ready' }
        : entry.status === 'ready'
          ? { label: 'Available', tone: 'ready' }
          : entry.status === 'install-required'
            ? { label: 'Install from Agent Chat', tone: 'warn' }
            : entry.status === 'needs-runtime'
              ? {
                  label: entry.runtimeLauncher === 'uvx' ? 'Needs uv' : 'Needs Node.js',
                  tone: 'warn'
                }
              : entry.status === 'manual-install'
                ? { label: 'Manual install', tone: 'warn' }
                : { label: 'Unavailable', tone: 'muted' }

  const handleCopyJson = async (): Promise<void> => {
    if (!entry.config) {
      toast.error('No saved config to copy.')
      return
    }
    const json = exportAgentConfig(entry.config)
    try {
      await navigator.clipboard.writeText(json)
      toast.success(`Copied ${entry.agent.name} config JSON`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void logFrontendError({
        level: 'error',
        source: 'AcpAgentsSettings:copyJson',
        message: `Failed to copy custom agent config "${entry.agent.name}": ${message}`
      })
      toast.error('Failed to copy JSON to clipboard.')
    }
  }

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
              : entry.status === 'manual-install'
                ? 'Open Agent Chat and save the path to your installed binary.'
                : entry.unavailableReason}
          </p>
        )}
        {entry.status === 'ready' &&
          entry.config &&
          entry.config.command !== 'npx' &&
          entry.config.command !== 'uvx' && <AgentPathEditor entry={entry} />}
        {entry.status === 'manual-install' && entry.manualInstall && (
          <p className="mt-1 font-mono text-2xs text-muted-foreground">
            Expected: {entry.manualInstall.cmd}
            {entry.manualInstall.args.length > 0 ? ` ${entry.manualInstall.args.join(' ')}` : ''}
          </p>
        )}
        {isCustomAgentEntry(entry) && entry.config && (
          <div className="mt-1.5 flex items-center">
            <Button type="button" size="sm" variant="ghost" onClick={() => void handleCopyJson()}>
              <Clipboard size={13} className="mr-1.5" />
              Copy JSON
            </Button>
          </div>
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
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const {
    usingRemoteRegistry,
    remoteAvailable,
    advisorySummary,
    checking,
    lastCheckedAt,
    checkForUpdates,
    applyRemoteRegistry,
    useBundledRegistry: switchToBundledRegistry
  } = useAcpRegistryCatalog()
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const supportedAgents = useResolvedSupportedAcpAgents(agentConfigs)

  const visible = useMemo(
    () => filterSupportedAcpAgents(supportedAgents, filter),
    [filter, supportedAgents]
  )

  const handleCheckUpdates = (): void => {
    void (async () => {
      try {
        const summary = await checkForUpdates(true)
        if (!summary) {
          toast.error('Could not fetch the ACP registry.')
          return
        }
        if (summary.updatedCount === 0) {
          toast.success('ACP registry is up to date.')
          return
        }
        toast.success(
          `${summary.updatedCount} agent${summary.updatedCount === 1 ? '' : 's'} available from the registry. Review and apply to use them.`
        )
      } catch (err) {
        toast.error(String(err))
      }
    })()
  }

  const handleApplyRemote = async (): Promise<void> => {
    try {
      await applyRemoteRegistry()
      const count = advisorySummary?.updatedCount ?? 0
      toast.success(
        count > 0
          ? `Using remote registry (${count} update${count === 1 ? '' : 's'}).`
          : 'Using remote registry.'
      )
    } catch (err) {
      toast.error(String(err))
    }
  }

  const handleUseBundled = async (): Promise<void> => {
    try {
      await switchToBundledRegistry()
    } catch (err) {
      toast.error(String(err))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={checking}
          onClick={handleCheckUpdates}
        >
          {checking ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} className="mr-1.5" />
          )}
          Check for registry updates
        </Button>
        {remoteAvailable && (
          <Button type="button" size="sm" variant="secondary" onClick={handleApplyRemote}>
            Apply remote registry
          </Button>
        )}
        {usingRemoteRegistry && (
          <Button type="button" size="sm" variant="ghost" onClick={handleUseBundled}>
            Use bundled registry
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setCustomDialogOpen(true)}
        >
          <Plus size={14} className="mr-1.5" />
          Add Custom Agent
        </Button>
        {lastCheckedAt && (
          <span className="text-2xs text-muted-foreground">
            {usingRemoteRegistry
              ? 'Using remote registry'
              : remoteAvailable
                ? `${advisorySummary?.updatedCount ?? 0} update${(advisorySummary?.updatedCount ?? 0) === 1 ? '' : 's'} available`
                : 'Last checked'}{' '}
            · {lastCheckedAt}
          </span>
        )}
      </div>

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

      <CustomAcpAgentDialog open={customDialogOpen} onOpenChange={setCustomDialogOpen} />
    </div>
  )
}
