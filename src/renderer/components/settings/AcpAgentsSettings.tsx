import { Clipboard, Plus, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('agents')
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
      toast.error(t('settings.enterBinaryPath'))
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
      toast.success(t('settings.pathUpdated', { name: entry.agent.name }))
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
      toast.success(t('settings.pathCleared', { name: entry.agent.name }))
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
          placeholder={t('settings.pathPlaceholder')}
          aria-label={t('settings.pathAria', { name: entry.agent.name })}
          className="h-7 font-mono text-xs"
          disabled={saving}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() =>
            void dialogApi.selectFile({ title: t('settings.selectExecutable') }).then((result) => {
              if (result.success && result.data) setPath(result.data)
            })
          }
        >
          {t('settings.browse')}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving || path.trim().length === 0}
          onClick={() => void savePath()}
        >
          {t('settings.savePath')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => void clearPath()}
        >
          {t('settings.clearPath')}
        </Button>
      </div>
    </div>
  )
}

interface AgentRowProps {
  entry: SupportedAcpAgentEntry
}

function AgentRow({ entry }: AgentRowProps): React.JSX.Element {
  const { t } = useTranslation('agents')
  const warmState = useConfigWarmState(entry.configId)
  const iconEntry = useMemo(() => findBundledIconByKey(`acp:${entry.agent.id}`), [entry.agent.id])

  const statusBadge: { label: string; tone: 'ready' | 'muted' | 'warn' } = warmState.sessionReady
    ? { label: t('settings.status.sessionReady'), tone: 'ready' }
    : warmState.warming || warmState.warmingSession
      ? { label: t('settings.status.warming'), tone: 'muted' }
      : warmState.connected
        ? { label: t('settings.status.warm'), tone: 'ready' }
        : entry.status === 'ready'
          ? { label: t('settings.status.available'), tone: 'ready' }
          : entry.status === 'install-required'
            ? { label: t('settings.status.installFromChat'), tone: 'warn' }
            : entry.status === 'needs-runtime'
              ? {
                  label:
                    entry.runtimeLauncher === 'uvx'
                      ? t('settings.status.needsUv')
                      : t('settings.status.needsNode'),
                  tone: 'warn'
                }
              : entry.status === 'manual-install'
                ? { label: t('settings.status.manualInstall'), tone: 'warn' }
                : { label: t('settings.status.unavailable'), tone: 'muted' }

  const handleCopyJson = async (): Promise<void> => {
    if (!entry.config) {
      toast.error(t('settings.noSavedConfig'))
      return
    }
    try {
      // `exportAgentConfig` can throw (e.g. a missing `configId` guard) — keep
      // it inside the try so serialization failures hit the same error path as
      // clipboard failures (log + toast), not an uncaught rejection.
      const json = exportAgentConfig(entry.config)
      await navigator.clipboard.writeText(json)
      toast.success(t('settings.copiedConfig', { name: entry.agent.name }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void logFrontendError({
        level: 'error',
        source: 'AcpAgentsSettings:copyJson',
        message: `Failed to copy custom agent config "${entry.agent.name}": ${message}`
      })
      toast.error(t('settings.copyFailed'))
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
              ? t('settings.installHint')
              : entry.status === 'manual-install'
                ? t('settings.manualHint')
                : entry.unavailableReason}
          </p>
        )}
        {entry.status === 'ready' &&
          entry.config &&
          entry.config.command !== 'npx' &&
          entry.config.command !== 'uvx' && <AgentPathEditor entry={entry} />}
        {entry.status === 'manual-install' && entry.manualInstall && (
          <p className="mt-1 font-mono text-2xs text-muted-foreground">
            {t('settings.expected', {
              command: [entry.manualInstall.cmd, ...entry.manualInstall.args].join(' ')
            })}
          </p>
        )}
        {isCustomAgentEntry(entry) && entry.config && (
          <div className="mt-1.5 flex items-center">
            <Button type="button" size="sm" variant="ghost" onClick={() => void handleCopyJson()}>
              <Clipboard size={13} className="mr-1.5" />
              {t('settings.copyJson')}
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
  const { t } = useTranslation('agents')
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
          toast.error(t('settings.fetchRegistryFailed'))
          return
        }
        if (summary.updatedCount === 0) {
          toast.success(t('settings.registryUpToDate'))
          return
        }
        toast.success(t('settings.registryUpdates', { count: summary.updatedCount }))
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
        count > 0 ? t('settings.usingRemoteWithUpdates', { count }) : t('settings.usingRemote')
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
          {t('settings.checkUpdates')}
        </Button>
        {remoteAvailable && (
          <Button type="button" size="sm" variant="secondary" onClick={handleApplyRemote}>
            {t('settings.applyRemote')}
          </Button>
        )}
        {usingRemoteRegistry && (
          <Button type="button" size="sm" variant="ghost" onClick={handleUseBundled}>
            {t('settings.useBundled')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setCustomDialogOpen(true)}
        >
          <Plus size={14} className="mr-1.5" />
          {t('settings.addCustom')}
        </Button>
        {lastCheckedAt && (
          <span className="text-2xs text-muted-foreground">
            {usingRemoteRegistry
              ? t('settings.usingRemote')
              : remoteAvailable
                ? t('settings.updatesAvailable', { count: advisorySummary?.updatedCount ?? 0 })
                : t('settings.lastChecked')}{' '}
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
          placeholder={t('settings.filter')}
          className="h-8 pl-8 text-sm"
        />
      </div>

      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t('settings.noMatches')}
          </p>
        ) : (
          visible.map((entry) => <AgentRow key={entry.id} entry={entry} />)
        )}
      </div>

      <CustomAcpAgentDialog open={customDialogOpen} onOpenChange={setCustomDialogOpen} />
    </div>
  )
}
