import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { EntryGlyph } from '@/components/agents/launcher/pickers'
import {
  SELECTOR_OPTION_ROW,
  SELECTOR_OPTION_ROW_DESKTOP,
  SELECTOR_OPTION_ROW_MOBILE,
  SELECTOR_SECTION_LABEL,
  SelectorModal
} from '@/components/chat/AgentHeader'
import { ComposerPill } from '@/components/chat/ComposerPill'
import { Loader2, X } from '@/components/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useResolvedSupportedAcpAgents } from '@/hooks/use-resolved-supported-acp-agents'
import { acpApi } from '@/lib/acp-api'
import {
  filterSupportedAcpAgents,
  installedBinaryConfig,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { waitForTurnClear } from '@/stores/prompt-queue-orchestration'

/**
 * Row-disable reason for a switch-target entry (the picker's own badges do
 * not carry the reason text). Null when the row is actionable.
 */
function entryDisableReason(entry: SupportedAcpAgentEntry): string | null {
  if (entry.status === 'manual-install') {
    return entry.unavailableReason ?? 'Manual install required'
  }
  if (entry.status === 'unavailable') {
    return entry.unavailableReason ?? 'Not available on this platform'
  }
  if (entry.status === 'needs-runtime') {
    return entry.unavailableReason ?? 'Runtime missing'
  }
  return null
}

/**
 * Story 4 (spec-in-chat-agent-switch): the composer's agent control (CAP-1).
 *
 * A chip in ChatInputBar's right cluster that opens the in-chat agent picker.
 * Row rendering is the launcher's `AcpAgentPicker` pattern reused as-is via
 * the exported `EntryGlyph` + the shared SelectorOption chrome: icon, name,
 * status badge, search, and the desktop Popover / mobile SelectorModal shells
 * — no second picker system.
 *
 * The picker lists resolved supported agents MINUS the current config (the
 * current agent is never a switch target; the store rejects same-config arms
 * with the banner) and preselects the current identity on the trigger. Picking
 * a READY entry arms the switch (`armAgentSwitch`); the NEXT send executes it
 * (story 3's sendPrompt/sendPromptBlocks interception). Installable entries
 * (install-required/needs-runtime with an `install` block) route through the
 * existing host-owned install facade — acpApi.installAcpAgent →
 * installedBinaryConfig → saveAgentConfig (the launcher's handleInstallAgent
 * recipe) — and arm once the re-resolved entry flips ready.
 * manual-install/unavailable rows render disabled with their reason.
 *
 * While the session is turn-busy the picker presents an explicit Wait vs
 * Cancel-then-switch choice (CAP-6): Wait = close the popover with no state
 * change; Cancel-then-switch runs the `sendQueuedPromptNow` recipe
 * (acpApi.cancelPrompt → waitForTurnClear → arm) so the busy gate is never
 * bypassed silently. The armed state is visible on the trigger (target name +
 * cancel affordance); sending stays the execution trigger.
 */
export function AgentSwitchPicker({
  sessionId,
  busy,
  disabled
}: {
  sessionId: string
  /** Turn-busy flag from the composer (drives the Wait vs Cancel presentation). */
  busy: boolean
  /** Fully-disabled flag (closed session / read-only composer). */
  disabled: boolean
}): React.JSX.Element | null {
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const armAgentSwitch = useAcpStore((s) => s.armAgentSwitch)
  const cancelAgentSwitch = useAcpStore((s) => s.cancelAgentSwitch)
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)
  // Armed-state reader (CAP-1/CAP-4): `session.switching` is store-owned; the
  // picker only surfaces it — never re-derives the busy gate.
  const switching = useAcpStore((s) => s.sessions[sessionId]?.switching ?? null)
  // Current-agent resolution mirrors `selectAgentIdentity`/`configIdForAgentId`:
  // live reuse-key map first, sessionIndex `agentConfigId` fallback.
  const currentConfigId = useAcpStore((s) => {
    const session = s.sessions[sessionId]
    if (session?.agentId) {
      for (const [key, id] of Object.entries(s.configToLiveAgent)) {
        if (id === session.agentId) return key.split('\0')[0]
      }
    }
    return s.sessionIndex.find((e) => e.id === sessionId)?.agentConfigId ?? null
  })
  const currentConfig = agentConfigs.find((c) => c.id === currentConfigId) ?? null
  const resolvedEntries = useResolvedSupportedAcpAgents(agentConfigs)
  const currentEntry = resolvedEntries.find((entry) => entry.configId === currentConfigId) ?? null
  // Switch targets exclude the current config (the store rejects same-config
  // arms; the row is never offered).
  const switchTargets = useMemo(
    () => resolvedEntries.filter((entry) => entry.configId !== currentConfigId),
    [resolvedEntries, currentConfigId]
  )
  const armedTargetName = useAcpStore((s) => {
    const to = s.sessions[sessionId]?.switching?.toConfigId
    return to ? (s.agentConfigs.find((c) => c.id === to)?.name ?? to) : null
  })
  const sessionAgentId = useAcpStore((s) => s.sessions[sessionId]?.agentId ?? '')

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [installingConfigId, setInstallingConfigId] = useState<string | null>(null)
  // Install intent (install-then-arm): after saveAgentConfig the entries
  // re-resolve (persisted wins → ready); the effect below arms this target
  // once it flips ready.
  const [installIntent, setInstallIntent] = useState<string | null>(null)
  const isMobile = useMobileWebShell()
  const controlDisabled = disabled || Boolean(installingConfigId)
  const visibleAgents = useMemo(
    () => filterSupportedAcpAgents(switchTargets, query),
    [switchTargets, query]
  )

  const handleArm = useCallback(
    async (configId: string): Promise<void> => {
      await armAgentSwitch(sessionId, configId)
    },
    [armAgentSwitch, sessionId]
  )

  // Install-then-arm (Design Notes): once the intended target re-resolves
  // ready, arm and clear the intent. Arming failures are store-owned (busy
  // gate / unknown-config rejection stamp the session banner).
  useEffect(() => {
    if (!installIntent) return
    const target = resolvedEntries.find((entry) => entry.configId === installIntent)
    if (target?.status !== 'ready') return
    setInstallIntent(null)
    void armAgentSwitch(sessionId, installIntent)
  }, [installIntent, resolvedEntries, armAgentSwitch, sessionId])

  // Install driver (the launcher's handleInstallAgent recipe, minus the
  // launcher-only selection persistence): host install → installedBinaryConfig
  // → saveAgentConfig; the entries re-resolve reactively and the effect above
  // arms the remembered intent once ready.
  const handleInstall = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      const install = entry.install
      if (!install || installingConfigId) return
      setInstallingConfigId(entry.configId)
      setInstallIntent(entry.configId)
      void (async () => {
        try {
          const installed = await acpApi.installAcpAgent(entry.agent.id)
          const config = installedBinaryConfig(
            entry.agent,
            installed,
            install.kind === 'archive' ? { env: install.env } : {}
          )
          await saveAgentConfig(config)
          toast.success(`${entry.agent.name} installed`)
        } catch (err) {
          toast.error(`Failed to install ${entry.agent.name}: ${String(err)}`)
          setInstallIntent(null)
        } finally {
          setInstallingConfigId(null)
        }
      })()
    },
    [installingConfigId, saveAgentConfig]
  )

  // Row pick. Ready → arm. Installable → install driver. manual-install /
  // unavailable rows are disabled (title carries the reason); the status guard
  // covers a catalog re-resolution between render and click.
  const handlePick = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      if (entry.status === 'ready') {
        void handleArm(entry.configId)
        return
      }
      handleInstall(entry)
    },
    [handleArm, handleInstall]
  )

  // Cancel-then-switch (CAP-6): the `sendQueuedPromptNow` recipe —
  // cancelPrompt → waitForTurnClear → arm. Wait = close the popover with no
  // state change (the popover's own onOpenChange(false) path).
  const handleCancelThenSwitch = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      setOpen(false)
      void (async () => {
        try {
          await cancelPrompt(sessionId)
          await waitForTurnClear(sessionId, useAcpStore.getState, useAcpStore.subscribe)
          await handleArm(entry.configId)
        } catch (err) {
          toast.error(
            `Could not switch to ${entry.config?.name ?? entry.agent.name}: ${String(err)}`
          )
        }
      })()
    },
    [cancelPrompt, sessionId, handleArm]
  )

  // A session whose agent cannot be resolved (cold history reopen) has nothing
  // to switch from yet — render nothing rather than a placeholder chip. This
  // guard sits after all hooks (Rules of Hooks).
  if (!sessionAgentId && !currentConfigId) return null

  const armLabel = armedTargetName ? `→ ${armedTargetName}` : (currentConfig?.name ?? 'Agent')
  const triggerAria = armedTargetName
    ? `Switch to ${armedTargetName} on next send. Cancel to keep ${currentConfig?.name ?? 'the current agent'}`
    : `Switch agent. Currently ${currentConfig?.name ?? 'the current agent'}`

  // The trigger: the ComposerPill (label/glyph/chevron) plus — when armed —
  // an adjacent real cancel button. A nested button inside the pill's own
  // <button> would be invalid HTML, so the pill+cancel pair sits in an
  // inline flex wrapper (the pair reads as one chip visually).
  const trigger = (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <ComposerPill
        disabled={controlDisabled}
        aria-label={triggerAria}
        title={armedTargetName ? `Next send switches to ${armedTargetName}` : undefined}
        data-testid="agent-switch-trigger"
        className={cn('max-w-[220px]', isMobile && 'min-h-11 py-2')}
        chevron={!armedTargetName}
      >
        {!armedTargetName && (
          <EntryGlyph config={currentConfig} templateId={currentEntry?.agent.id} />
        )}
        <span className="truncate">{armLabel}</span>
      </ComposerPill>
      {armedTargetName && (
        <button
          type="button"
          aria-label="Cancel agent switch"
          title="Cancel the armed switch — the next send stays with the current agent"
          data-testid="agent-switch-cancel"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
          onClick={() => cancelAgentSwitch(sessionId)}
        >
          <X size={10} aria-hidden="true" />
        </button>
      )}
    </span>
  )

  const contentBody = (
    <>
      {busy && (
        <div
          data-testid="agent-switch-busy"
          role="status"
          className="mb-1 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground"
        >
          The agent is still working on a turn. Wait for it to finish (close this), or cancel it and
          switch now.
        </div>
      )}
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search agents…"
        aria-label="Search agents to switch to"
        className={cn(
          'mb-1 w-full rounded-md bg-background px-2 py-1.5 text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-foreground/20',
          isMobile ? 'text-base' : 'text-sm'
        )}
      />
      <div className="max-h-64 overflow-y-auto pr-1">
        {visibleAgents.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {switchTargets.length === 0
              ? 'No other agents are available to switch to.'
              : 'No other agents match.'}
          </div>
        ) : (
          visibleAgents.map((entry) => {
            const reason = entryDisableReason(entry)
            const installing = installingConfigId === entry.configId
            // Rows disable for manual-install/unavailable (never actionable)
            // and while another install is in flight (launcher pattern).
            const rowDisabled = reason !== null || Boolean(installingConfigId)
            return (
              <button
                key={entry.configId}
                type="button"
                disabled={rowDisabled}
                title={reason ?? undefined}
                aria-label={
                  reason
                    ? `${entry.config?.name ?? entry.agent.name} — ${reason}`
                    : busy
                      ? `Cancel the turn and switch to ${entry.config?.name ?? entry.agent.name}`
                      : `Switch to ${entry.config?.name ?? entry.agent.name}`
                }
                data-press-feedback="off"
                data-testid={`agent-switch-row-${entry.configId}`}
                onClick={() => {
                  if (busy) {
                    handleCancelThenSwitch(entry)
                    return
                  }
                  setOpen(false)
                  handlePick(entry)
                }}
                className={cn(
                  SELECTOR_OPTION_ROW,
                  isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                  'disabled:cursor-not-allowed disabled:opacity-60'
                )}
              >
                <span className="mt-0.5 inline-flex shrink-0">
                  <EntryGlyph config={entry.config} templateId={entry.agent.id} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {entry.config?.name ?? entry.agent.name}
                </span>
                {installing && <Loader2 size={11} className="shrink-0 animate-spin" />}
                {entry.status === 'install-required' && (
                  <span className="rounded bg-foreground/[0.08] px-1.5 py-0.5 text-3xs text-muted-foreground">
                    {installing ? 'Installing…' : 'Install'}
                  </span>
                )}
                {entry.status === 'needs-runtime' && (
                  <span className="text-3xs text-muted-foreground">
                    {entry.runtimeLauncher === 'uvx' ? 'Needs uv' : 'Needs Node'}
                  </span>
                )}
                {entry.status === 'manual-install' && (
                  <span className="text-3xs text-muted-foreground">Manual install</span>
                )}
                {entry.status === 'unavailable' && (
                  <span className="text-3xs text-muted-foreground">Unavailable</span>
                )}
                {reason && <span className="sr-only">{reason}</span>}
              </button>
            )
          })
        )}
      </div>
      {switching && (
        <div
          data-testid="agent-switch-armed-banner"
          className="mt-1 border-t border-border/60 px-2 pt-1.5 text-xs text-muted-foreground"
        >
          Next send switches to <span className="font-medium">{armedTargetName}</span>
        </div>
      )}
    </>
  )

  if (isMobile) {
    return (
      <SelectorModal
        open={open}
        onOpenChange={setOpen}
        title="Switch agent"
        trigger={trigger}
        disabled={controlDisabled}
      >
        {contentBody}
      </SelectorModal>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={controlDisabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-1">
        <div className={SELECTOR_SECTION_LABEL}>Switch agent</div>
        {contentBody}
      </PopoverContent>
    </Popover>
  )
}
