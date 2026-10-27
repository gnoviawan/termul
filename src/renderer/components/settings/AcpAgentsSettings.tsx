import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CustomAcpAgentDialog, exportAgentConfig } from '@/components/agents/CustomAcpAgentDialog'
import { Clipboard, Plus, RefreshCw, Search } from '@/components/icons'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { type StatusTone, StatusWord } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PANEL_FIELD_CLASS, PANEL_FIELD_ICON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { useAcpRegistryCatalog } from '@/hooks/use-acp-registry-catalog'
import {
  type AcpAgentCatalogStatus,
  useResolvedSupportedAcpAgentsState
} from '@/hooks/use-resolved-supported-acp-agents'
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

function agentUpdatesLabel(count: number): string {
  return `${count} agent update${count === 1 ? '' : 's'}`
}

function formatCheckedAt(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso)
  )
}

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

  const status: { label: string; tone: StatusTone; pending?: boolean } = warmState.sessionReady
    ? { label: 'Session ready', tone: 'success' }
    : warmState.warming || warmState.warmingSession
      ? { label: 'Warming…', tone: 'muted', pending: true }
      : warmState.connected
        ? { label: 'Warm', tone: 'success' }
        : entry.status === 'ready'
          ? { label: 'Available', tone: 'success' }
          : entry.status === 'install-required'
            ? { label: 'Needs install', tone: 'warning' }
            : entry.status === 'needs-runtime'
              ? {
                  label: entry.runtimeLauncher === 'uvx' ? 'Needs uv' : 'Needs Node.js',
                  tone: 'warning'
                }
              : entry.status === 'manual-install'
                ? { label: 'Manual install', tone: 'warning' }
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
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
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
        <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">{entry.agent.name}</span>
          {entry.agent.version && (
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              v{entry.agent.version}
            </span>
          )}
          {update && (
            <span
              className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-3xs text-connection"
              data-testid={`agent-update-${entry.id}`}
            >
              {update.fromVersion} → {update.toVersion}
            </span>
          )}
          {latest && !update && (
            // Positive drift-free signal (user trust): a check has run, this
            // agent has a spawn version, and it matches the target registry.
            <span
              className="shrink-0 rounded bg-muted px-1.5 py-px text-3xs text-success"
              data-testid={`agent-latest-${entry.id}`}
            >
              Latest
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <StatusWord tone={status.tone} pending={status.pending}>
              {status.label}
            </StatusWord>
            {update && entry.config && (
              // Agent language only: one action. The click absorbs the registry
              // opt-in on the user's behalf (explicit consent preserved) and
              // rewrites the pin.
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => onUpdate(entry, update)}
                aria-label={`Update to ${update.toVersion} (${entry.agent.name})`}
              >
                Update to {update.toVersion}
              </Button>
            )}
          </span>
        </div>
        {entry.agent.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {entry.agent.description}
          </p>
        )}
        {entry.status !== 'ready' && (
          <p className="mt-1 text-xs text-warning">
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

/** What the agent list shows in place of rows: loading, a filter miss, or a catalog failure. */
function AgentListPlaceholder({
  status,
  filter,
  onClearFilter,
  onRetry
}: {
  status: AcpAgentCatalogStatus
  filter: string
  onClearFilter: () => void
  onRetry: () => void
}): React.JSX.Element {
  const frame =
    'flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-5 text-center'
  if (status === 'loading') {
    return (
      <div className={frame} role="status">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size={13} decorative />
          Loading agents…
        </p>
      </div>
    )
  }
  if (filter.length > 0) {
    return (
      <div className={frame}>
        <p className="text-xs text-muted-foreground">No agents match "{filter}".</p>
        <Button type="button" size="xs" variant="outline" onClick={onClearFilter}>
          Clear filter
        </Button>
      </div>
    )
  }
  if (status === 'unavailable') {
    return (
      <div className={frame}>
        <p className="text-xs text-muted-foreground">Couldn't load agents.</p>
        <Button type="button" size="xs" variant="outline" onClick={onRetry}>
          <RefreshCw size={13} />
          Retry
        </Button>
      </div>
    )
  }
  return (
    <div className={frame}>
      <p className="text-xs text-muted-foreground">No agents available.</p>
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
  const {
    status: catalogStatus,
    entries: supportedAgents,
    retry: retryCatalog
  } = useResolvedSupportedAcpAgentsState(agentConfigs)

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
        const summary = await checkForUpdates('manual')
        if (!summary) {
          toast.error('Could not check for agent updates.')
          return
        }
        if (summary.registryUnreachable) {
          const cachedAt = summary.fetchedAt ? ` from ${formatCheckedAt(summary.fetchedAt)}` : ''
          const found =
            summary.updatedCount === 0 ? 'no updates' : agentUpdatesLabel(summary.updatedCount)
          toast.warning("Couldn't reach the agent registry.", {
            description: `Cached results${cachedAt} show ${found}.`
          })
          return
        }
        if (summary.updatedCount === 0) {
          toast.success('All agents are up to date.')
          return
        }
        toast.success(`${agentUpdatesLabel(summary.updatedCount)} available.`)
      } catch (err) {
        toast.error(String(err))
      }
    })()
  }

  return (
    <SettingsGroup
      id="settings-available-agents"
      className="scroll-mt-4"
      title="Available agents"
      actions={
        <>
          {lastCheckedAt && (
            <span className="text-xs text-muted-foreground">
              {remoteAvailable && (advisorySummary?.updatedCount ?? 0) > 0
                ? `${advisorySummary?.updatedCount} agent update${(advisorySummary?.updatedCount ?? 0) === 1 ? '' : 's'} available`
                : 'All agents up to date'}{' '}
              · Checked {lastCheckedAt}
            </span>
          )}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={checking}
            onClick={handleCheckUpdates}
          >
            {checking ? <Spinner size={13} decorative /> : <RefreshCw size={13} />}
            Check for updates
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setCustomDialogOpen(true)}
          >
            <Plus size={13} />
            Add custom agent
          </Button>
        </>
      }
    >
      <div className="relative">
        <Search size={13} aria-hidden className={PANEL_FIELD_ICON_CLASS} />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter agents"
          aria-label="Filter agents"
          className={cn(PANEL_FIELD_CLASS, 'h-8 w-full bg-background pl-7 pr-3')}
        />
      </div>

      {visible.length === 0 ? (
        <AgentListPlaceholder
          status={catalogStatus}
          filter={filter.trim()}
          onClearFilter={() => setFilter('')}
          onRetry={retryCatalog}
        />
      ) : (
        <SettingsCard>
          {visible.map((entry) => (
            <AgentRow
              key={entry.id}
              entry={entry}
              update={updateByConfigId.get(entry.configId)}
              latest={latestConfigIds.has(entry.configId)}
              onUpdate={handleAgentUpdate}
            />
          ))}
        </SettingsCard>
      )}

      <CustomAcpAgentDialog open={customDialogOpen} onOpenChange={setCustomDialogOpen} />
    </SettingsGroup>
  )
}
