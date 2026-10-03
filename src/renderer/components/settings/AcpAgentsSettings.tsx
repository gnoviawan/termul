import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CustomAcpAgentDialog, exportAgentConfig } from '@/components/agents/CustomAcpAgentDialog'
import { Clipboard, Plus, RefreshCw, Search } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useAcpRegistryCatalog } from '@/hooks/use-acp-registry-catalog'
import { useResolvedSupportedAcpAgents } from '@/hooks/use-resolved-supported-acp-agents'
import { agentPolicy } from '@/lib/agents/acp-registry'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import {
  type AgentUpdate,
  deriveAgentUpdates,
  deriveSpawnBasis
} from '@/lib/agents/agent-update-utils'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import {
  filterSupportedAcpAgents,
  isCustomAgentEntry,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { dialogApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useAcpStore, useConfigWarmState } from '@/stores/acp-store'

/** Render a sanitized SVG icon string inline (theme-aware via currentColor). */
function InlineIcon({ svg }: { svg: string }): React.JSX.Element {
  const sanitized = useMemo(() => sanitizeInlineAgentSvg(svg), [svg])
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: icon SVG is sanitized via sanitizeInlineAgentSvg (DOMPurify)
      dangerouslySetInnerHTML={{ __html: sanitized ?? '' }}
    />
  )
}

/** True when the SVG sanitizes to a non-null value (safe to render). */
function iconSanitizesOk(svg: string): boolean {
  return sanitizeInlineAgentSvg(svg) !== null
}

/**
 * Manual-install copy from the registry policy (S2-TS): managed-npm agents
 * carry their canonical reason string in the policy; every other manual-install
 * agent gets the generic "point Termul at the binary" guidance.
 */
function manualInstallCopy(entry: SupportedAcpAgentEntry): string {
  const install = agentPolicy(entry.id).install
  if (install.kind === 'managed-npm') return install.manualInstallReason
  return 'Open Agent Chat and save the path to your installed binary.'
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
  /** Per-agent Update Check drift (advisory), when one exists. */
  update?: AgentUpdate
  /** No drift for this agent after a completed check (spawn version matches). */
  latest?: boolean
  onUpdate: (entry: SupportedAcpAgentEntry, update: AgentUpdate) => void
}

function AgentRow({ entry, update, latest, onUpdate }: AgentRowProps): React.JSX.Element {
  const warmState = useConfigWarmState(entry.configId)
  const iconEntry = useMemo(() => findBundledIconByKey(`acp:${entry.agent.id}`), [entry.agent.id])
  // Prefer a persisted custom icon (bundled or uploaded) over the catalog.
  const customIcon = entry.config?.icon

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
    try {
      // `exportAgentConfig` can throw (e.g. a missing `configId` guard) — keep
      // it inside the try so serialization failures hit the same error path as
      // clipboard failures (log + toast), not an uncaught rejection.
      const json = exportAgentConfig(entry.config)
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
        {customIcon && iconSanitizesOk(customIcon) ? (
          <InlineIcon svg={customIcon} />
        ) : iconEntry ? (
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
              statusBadge.tone === 'ready' && 'text-success',
              statusBadge.tone === 'warn' && 'text-warning'
            )}
          >
            {statusBadge.label}
          </Badge>
          {update && (
            <Badge
              variant="secondary"
              className="h-4 px-1.5 font-mono text-3xs text-connection"
              data-testid={`agent-update-${entry.id}`}
            >
              {update.fromVersion} → {update.toVersion}
            </Badge>
          )}
          {latest && !update && (
            // Positive drift-free signal (user trust): a check has run, this
            // agent has a spawn version, and it matches the target registry.
            <Badge
              variant="secondary"
              className="h-4 px-1.5 text-3xs text-success"
              data-testid={`agent-latest-${entry.id}`}
            >
              Latest
            </Badge>
          )}
        </div>
        {update && entry.config && (
          // Agent language only: one action. The click absorbs the registry
          // opt-in on the user's behalf (explicit consent preserved) and
          // rewrites the pin.
          <div className="mt-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onUpdate(entry, update)}
            >
              Update to {update.toVersion}
            </Button>
          </div>
        )}
        {entry.agent.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {entry.agent.description}
          </p>
        )}
        {entry.status !== 'ready' && (
          <p className="mt-1 text-2xs text-warning">
            {entry.status === 'install-required'
              ? entry.install?.kind === 'managed-npm'
                ? `Open Agent Chat to install the pinned ${entry.install.package} package.`
                : 'Open Agent Chat and choose Install before first use.'
              : entry.status === 'manual-install'
                ? manualInstallCopy(entry)
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
    activeRegistry,
    remoteRegistry
  } = useAcpRegistryCatalog()
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const applyAgentUpdate = useAcpStore((s) => s.applyAgentUpdate)
  const supportedAgents = useResolvedSupportedAcpAgents(agentConfigs)

  // Per-agent Update Check: drift between each agent's spawn version and the
  // target registry — the applied registry when opted in, otherwise the
  // advisory Remote Snapshot (button hidden until the registry is applied).
  const updates = useMemo(() => {
    const target = usingRemoteRegistry ? activeRegistry : remoteRegistry
    if (target.length === 0) return []
    return deriveAgentUpdates({
      registry: target,
      spawnBasis: deriveSpawnBasis(supportedAgents)
    })
  }, [usingRemoteRegistry, activeRegistry, remoteRegistry, supportedAgents])
  const updateByConfigId = useMemo(() => new Map(updates.map((u) => [u.configId, u])), [updates])
  // "Latest" set: a target registry is present and this agent's spawn version
  // matches it (no drift). Drives the positive per-row signal.
  const latestConfigIds = useMemo(() => {
    const target = usingRemoteRegistry ? activeRegistry : remoteRegistry
    if (target.length === 0) return new Set<string>()
    const updateIds = new Set(updates.map((u) => u.configId))
    return new Set(
      deriveSpawnBasis(supportedAgents)
        .map((basis) => `acp-registry:${basis.agentId}`)
        .filter((configId) => !updateIds.has(configId))
    )
  }, [usingRemoteRegistry, activeRegistry, remoteRegistry, supportedAgents, updates])

  const handleAgentUpdate = (entry: SupportedAcpAgentEntry, update: AgentUpdate): void => {
    void (async () => {
      try {
        // One click absorbs the registry opt-in — the click IS the explicit
        // consent ADR-0001 requires — then rewrites this agent's pin.
        if (!usingRemoteRegistry) await applyRemoteRegistry()
        await applyAgentUpdate(entry.configId, entry.agent)
        toast.success(
          `${entry.agent.name} updated to ${update.toVersion} — your next chat with this agent uses the new version.`
        )
      } catch (err) {
        toast.error(String(err))
      }
    })()
  }

  const visible = useMemo(
    () => filterSupportedAcpAgents(supportedAgents, filter),
    [filter, supportedAgents]
  )

  const handleCheckUpdates = (): void => {
    void (async () => {
      try {
        const summary = await checkForUpdates(true)
        if (!summary) {
          toast.error('Could not check for agent updates.')
          return
        }
        if (summary.updatedCount === 0) {
          toast.success('All agents are up to date.')
          return
        }
        toast.success(
          `${summary.updatedCount} agent update${summary.updatedCount === 1 ? '' : 's'} available.`
        )
      } catch (err) {
        toast.error(String(err))
      }
    })()
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
          {checking ? <Spinner size={14} decorative /> : <RefreshCw size={14} className="mr-1.5" />}
          Check for updates
        </Button>
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
            {remoteAvailable && (advisorySummary?.updatedCount ?? 0) > 0
              ? `${advisorySummary?.updatedCount} agent update${(advisorySummary?.updatedCount ?? 0) === 1 ? '' : 's'} available`
              : 'All agents up to date'}{' '}
            · Checked {lastCheckedAt}
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
          visible.map((entry) => (
            <AgentRow
              key={entry.id}
              entry={entry}
              update={updateByConfigId.get(entry.configId)}
              latest={latestConfigIds.has(entry.configId)}
              onUpdate={handleAgentUpdate}
            />
          ))
        )}
      </div>

      <CustomAcpAgentDialog open={customDialogOpen} onOpenChange={setCustomDialogOpen} />
    </div>
  )
}
