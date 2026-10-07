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
import { X } from '@/components/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
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
 * The id `armAgentSwitch` accepts: the STORE's `agentConfigs` id. A resolved
 * entry's `configId` can diverge for imported custom agents (the resolver
 * prefers `config.configId ?? config.id` when merging), so ready rows arm by
 * the stored id whenever the entry carries a config; catalog-only ids keep
 * their registry configId (an install/save lands them in `agentConfigs`).
 * Null when the entry cannot be armed at all (unknown config).
 */
function armableConfigId(
  entry: SupportedAcpAgentEntry,
  agentConfigs: readonly { id: string }[]
): string | null {
  const candidate = entry.config?.id ?? entry.configId
  return agentConfigs.some((c) => c.id === candidate) ? candidate : null
}

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
 * (install-required with an `install` block) route through the existing
 * host-owned install facade — acpApi.installAcpAgent →
 * installedBinaryConfig → saveAgentConfig (the launcher's handleInstallAgent
 * recipe) — and arm once the re-resolved entry flips ready.
 * manual-install/unavailable rows render disabled with their reason.
 *
 * While the store's switch-blocked state is live (active turn / open turn id
 * / queued prompts / pending permission or question — the store's
 * `switchBlockedReason` fields, read raw because that helper is
 * module-private), the picker presents an explicit Wait vs
 * Cancel-then-switch choice (CAP-6): Wait = close the popover with no state
 * change; Cancel-then-switch runs the `sendQueuedPromptNow` recipe
 * (cancelPrompt → waitForTurnClear → arm) so the busy gate is never bypassed
 * silently. Only READY entries participate in cancel-then-switch — an
 * install-in-progress target would burn the cancel for an arm the store
 * rejects. The armed state is visible on the trigger (target name + cancel
 * affordance); sending stays the execution trigger.
 */
export function AgentSwitchPicker({
  sessionId,
  busy: busyProp,
  disabled,
  onPresenceChange,
  embedded = false,
  onClose
}: {
  sessionId: string
  /** Composer busy flag (kept for compatibility; the picker reads the full store gate). */
  busy: boolean
  /** Fully-disabled flag (closed session / read-only composer). */
  disabled: boolean
  /**
   * Notifies the host whenever the control's live presence flips (the
   * composer's narrow-mode row computation needs a real boolean — JSX-element
   * truthiness would always be true, the exact pitfall its row guard warns
   * about). Stable callback; called with `false` on unmount.
   */
  onPresenceChange?: (present: boolean) => void
  /**
   * Render the switch menu only. The host owns the popover. Default mode keeps
   * the trigger chip so the standalone picker tests stay on that path.
   */
  embedded?: boolean
  /** Called when an embedded pick closes the host popover. */
  onClose?: () => void
}): React.JSX.Element | null {
  // All store reads are defensive: a partial/mock state (tests, cold boot)
  // renders the control's null fallback instead of throwing mid-render.
  const agentConfigs = useAcpStore((s) => s.agentConfigs ?? [])
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const armAgentSwitch = useAcpStore((s) => s.armAgentSwitch)
  const cancelAgentSwitch = useAcpStore((s) => s.cancelAgentSwitch)
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)
  // Armed-state reader (CAP-1/CAP-4): `session.switching` is store-owned; the
  // picker only surfaces it — never re-derives the busy gate.
  const switching = useAcpStore((s) => s.sessions?.[sessionId]?.switching ?? null)
  // Current-agent resolution mirrors `selectAgentIdentity`/`configIdForAgentId`:
  // live reuse-key map first, sessionIndex `agentConfigId` fallback.
  const currentConfigId = useAcpStore((s) => {
    const session = s.sessions?.[sessionId]
    if (session?.agentId) {
      for (const [key, id] of Object.entries(s.configToLiveAgent ?? {})) {
        if (id === session.agentId) return key.split('\0')[0]
      }
    }
    return s.sessionIndex?.find((e) => e.id === sessionId)?.agentConfigId ?? null
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
    const to = s.sessions?.[sessionId]?.switching?.toConfigId
    return to ? (s.agentConfigs?.find((c) => c.id === to)?.name ?? to) : null
  })
  const sessionAgentId = useAcpStore((s) => s.sessions?.[sessionId]?.agentId ?? '')
  // Busy presentation reads the FULL store gate (the composer's `busy` prop
  // covers activeTurn only) — the same raw fields `switchBlockedReason`
  // reads: active/open turn, queued prompts, pending permission or
  // question, a launching chat (`launchingSessionIds`), a mid-replay
  // restore, and pending browser sign-in for the session's agent
  // (`pendingBrowserOpen`). The picker never re-derives WHY (the store owns
  // the gate + banner) — it only mirrors the fields.
  // `turnBusy` narrows to the ONE state cancel-then-switch can actually
  // clear: a live turn with an empty queue and no independent blocker.
  // Cancelling the turn while prompts remain queued would let the store
  // immediately flush the next queued prompt — the turn-clear wouldn't mean
  // the switch gate is clear and the arm would reject after the user already
  // cancelled. Launching / replaying / browser-auth states are also
  // wait-only (no turn exists to cancel).
  const storeBusy = useAcpStore((s) => {
    const session = s.sessions?.[sessionId]
    if (!session) return false
    if (session.activeTurn || session.openTurnId) return true
    if (session.replaying) return true
    if (s.launchingSessionIds?.[sessionId]) return true
    if ((s.promptQueues?.[sessionId] ?? []).length > 0) return true
    const permission = Object.values(s.pendingPermissions ?? {}).find(
      (p) => p.sessionId === sessionId
    )
    if (permission) return true
    if (Object.values(s.pendingQuestions ?? {}).find((q) => q.sessionId === sessionId)) return true
    return Boolean(session.agentId && s.pendingBrowserOpen?.[session.agentId])
  })
  const turnBusy = useAcpStore((s) => {
    const session = s.sessions?.[sessionId]
    if (!session?.activeTurn && !session?.openTurnId) return false
    // Turn-only: no queue, no pending interaction, no launch/replay/auth —
    // anything else survives the cancel and re-blocks the arm.
    if ((s.promptQueues?.[sessionId] ?? []).length > 0) return false
    if (Object.values(s.pendingPermissions ?? {}).some((p) => p.sessionId === sessionId)) {
      return false
    }
    if (Object.values(s.pendingQuestions ?? {}).some((q) => q.sessionId === sessionId)) {
      return false
    }
    if (s.launchingSessionIds?.[sessionId] || session.replaying) return false
    return !(session.agentId && s.pendingBrowserOpen?.[session.agentId])
  })
  const busy = storeBusy || busyProp

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
  // gate / unknown-config rejection stamp the session banner). The intent
  // also clears when a COMPLETED re-resolution no longer contains the target
  // (catalog resolution failure/reject → the hook re-resolved to a list
  // without it): the arm can never happen, and a dangling intent would arm a
  // stale target on a later unrelated readiness update. A non-empty entries
  // list that lacks the target is that completed-resolution signal — the
  // hook's initial empty state (pre-first-resolution) never reaches here
  // because the intent is only set after a row was rendered.
  useEffect(() => {
    if (!installIntent) return
    const target = resolvedEntries.find((entry) => entry.configId === installIntent)
    if (!target) {
      if (resolvedEntries.length > 0) setInstallIntent(null)
      return
    }
    if (target.status !== 'ready') return
    const armId = armableConfigId(target, agentConfigs)
    setInstallIntent(null)
    if (armId) void armAgentSwitch(sessionId, armId)
  }, [installIntent, resolvedEntries, armAgentSwitch, sessionId, agentConfigs])

  // Install driver (the launcher's handleInstallAgent recipe, minus the
  // launcher-only selection persistence): host install → installedBinaryConfig
  // → saveAgentConfig (durably resolved before the intent is set); the
  // entries re-resolve reactively and the effect above arms the remembered
  // intent once ready.
  const handleInstall = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      const install = entry.install
      if (!install || installingConfigId) return
      setInstallingConfigId(entry.configId)
      void (async () => {
        try {
          const installed = await acpApi.installAcpAgent(entry.agent.id)
          const config = installedBinaryConfig(
            entry.agent,
            installed,
            install.kind === 'archive' ? { env: install.env } : {}
          )
          // The intent is set only AFTER saveAgentConfig resolves: the store
          // publishes the config to `agentConfigs` first, then awaits the
          // disk write and ROLLS BACK (+ rethrows) on persistence failure —
          // setting it earlier would let the re-resolution flip the target
          // ready and arm it while the save can still fail and roll the
          // config back out from under the armed switch.
          await saveAgentConfig(config)
          setInstallIntent(entry.configId)
          toast.success(`${entry.agent.name} installed`)
        } catch (err) {
          toast.error(`Failed to install ${entry.agent.name}: ${String(err)}`)
        } finally {
          setInstallingConfigId(null)
        }
      })()
    },
    [installingConfigId, saveAgentConfig]
  )

  // Row pick. Ready → arm (by the store-resolvable id). Installable → install
  // driver. manual-install / unavailable rows are disabled (title carries the
  // reason); the status guard covers a catalog re-resolution between render
  // and click.
  const handlePick = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      if (entry.status === 'ready') {
        const armId = armableConfigId(entry, agentConfigs)
        if (armId) void handleArm(armId)
        return
      }
      handleInstall(entry)
    },
    [handleArm, handleInstall, agentConfigs]
  )

  // Embedded hosts own the shell. Closing here also clears a stale search
  // and tells that host to dismiss. Standalone mode only flips `open`.
  const closeMenu = useCallback(() => {
    setOpen(false)
    if (!embedded) return
    setQuery('')
    onClose?.()
  }, [embedded, onClose])

  // Cancel-then-switch (CAP-6): the `sendQueuedPromptNow` recipe —
  // cancelPrompt → waitForTurnClear → arm. Wait = close the popover with no
  // state change (the popover's own onOpenChange(false) path).
  const handleCancelThenSwitch = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      closeMenu()
      const armId = armableConfigId(entry, agentConfigs)
      void (async () => {
        try {
          await cancelPrompt(sessionId)
          await waitForTurnClear(sessionId, useAcpStore.getState, useAcpStore.subscribe)
          if (armId) await handleArm(armId)
        } catch (err) {
          toast.error(
            `Could not switch to ${entry.config?.name ?? entry.agent.name}: ${String(err)}`
          )
        }
      })()
    },
    [cancelPrompt, sessionId, handleArm, agentConfigs, closeMenu]
  )

  // Reset the search filter when the popover closes (a stale filter would
  // hide rows on reopen).
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) setQuery('')
  }, [])
  const present = Boolean(sessionAgentId || currentConfigId)
  useEffect(() => {
    onPresenceChange?.(present)
    return () => {
      onPresenceChange?.(false)
    }
  }, [present, onPresenceChange])
  if (!present) return null

  const armLabel = armedTargetName ? `→ ${armedTargetName}` : (currentConfig?.name ?? 'Agent')
  const triggerAria = armedTargetName
    ? `Switch to ${armedTargetName} on next send. Cancel to keep ${currentConfig?.name ?? 'the current agent'}`
    : `Switch agent. Currently ${currentConfig?.name ?? 'the current agent'}`

  // The trigger is ONLY the ComposerPill (Radix asChild merges
  // aria-expanded/data-state/pointer handlers onto it — a wrapping span would
  // swallow those onto a non-interactive element and stay clickable while
  // disabled). The cancel affordance is a sibling inside a plain span.
  const pill = (
    <ComposerPill
      disabled={controlDisabled}
      pending={Boolean(installingConfigId)}
      aria-label={triggerAria}
      title={armedTargetName ? `Next send switches to ${armedTargetName}` : undefined}
      data-testid="agent-switch-trigger"
      className={cn('max-w-[220px]', isMobile && 'min-h-11 py-2')}
      chevron={!armedTargetName}
    >
      {!armedTargetName && (
        <EntryGlyph
          config={currentConfig}
          templateId={currentEntry?.agent.id}
          name={currentEntry?.agent.name}
        />
      )}
      <span className="truncate">{armLabel}</span>
    </ComposerPill>
  )

  // The cancel affordance — a real sibling button (a nested button inside
  // the pill's own <button> would be invalid HTML). Shared by both shells.
  const cancelAffordance = armedTargetName ? (
    <button
      type="button"
      disabled={controlDisabled}
      aria-label="Cancel agent switch"
      title="Cancel the armed switch — the next send stays with the current agent"
      data-testid="agent-switch-cancel"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-[background-color,color] duration-150 ease-out hover:bg-foreground/10 hover:text-foreground focus-visible:bg-foreground/10 focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      onClick={() => cancelAgentSwitch(sessionId)}
    >
      <X size={10} aria-hidden="true" />
    </button>
  ) : null

  const contentBody = (
    <>
      {busy && (
        <div
          data-testid="agent-switch-busy"
          role="status"
          className="mb-1 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground"
        >
          {turnBusy
            ? 'The agent is still working on a turn. Wait for it to finish (close this), or cancel it and switch now.'
            : 'This chat is busy — wait for the queued prompts or the pending request to finish before switching.'}
        </div>
      )}
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search agents…"
        aria-label="Search agents to switch to"
        className={cn(
          'mb-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-foreground outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-muted-foreground hover:border-foreground/30 focus:border-foreground/40 focus:ring-1 focus:ring-ring',
          isMobile ? 'text-base' : 'text-sm'
        )}
      />
      <div className="max-h-64 overflow-y-auto overscroll-contain pr-1">
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
            // Rows disable for manual-install/unavailable (never actionable),
            // while an install is in flight (sibling rows — the control
            // serializes installs one at a time), when a READY entry's
            // config id resolves to nothing in the store (an arm the store
            // would reject with 'unknown agent config'), and while busy
            // WITHOUT a cancellable turn (queue-only / pending permission or
            // question — wait-only; cancelPrompt cannot clear those, so a
            // cancel-then-switch would end in a rejected arm).
            const busyInstallBlocked = busy && entry.status !== 'ready'
            const waitOnly = busy && !turnBusy
            const unarmable =
              entry.status === 'ready' && armableConfigId(entry, agentConfigs) === null
            const rowDisabled =
              reason !== null ||
              Boolean(installingConfigId) ||
              busyInstallBlocked ||
              unarmable ||
              waitOnly
            const rowTitle =
              reason ??
              (busyInstallBlocked
                ? 'Wait for the turn to finish, or install this agent first — cancelling the turn now would not arm the switch.'
                : waitOnly
                  ? 'This chat is busy — wait for the queued prompts or the pending request to finish before switching.'
                  : unarmable
                    ? 'This agent is not configured — add it in Settings before switching.'
                    : undefined)
            return (
              <button
                key={entry.configId}
                type="button"
                disabled={rowDisabled}
                title={rowTitle}
                aria-label={
                  reason
                    ? `${entry.config?.name ?? entry.agent.name} — ${reason}`
                    : turnBusy
                      ? `Cancel the turn and switch to ${entry.config?.name ?? entry.agent.name}`
                      : `Switch to ${entry.config?.name ?? entry.agent.name}`
                }
                data-press-feedback="off"
                data-testid={`agent-switch-row-${entry.configId}`}
                onClick={() => {
                  // Only a live turn (activeTurn/openTurnId) offers
                  // cancel-then-switch — cancelPrompt clears those; wait-only
                  // states render disabled above.
                  if (turnBusy) {
                    handleCancelThenSwitch(entry)
                    return
                  }
                  // Install picks keep the popover open so the row's
                  // Installing… state and sibling disabling stay visible; the
                  // arm-then-close happens once the entry flips ready.
                  if (entry.status !== 'ready') {
                    handlePick(entry)
                    return
                  }
                  closeMenu()
                  handlePick(entry)
                }}
                className={cn(
                  SELECTOR_OPTION_ROW,
                  isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                  'disabled:cursor-not-allowed disabled:opacity-60'
                )}
              >
                <span className="mt-0.5 inline-flex shrink-0">
                  <EntryGlyph
                    config={entry.config}
                    templateId={entry.agent.id}
                    name={entry.agent.name}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {entry.config?.name ?? entry.agent.name}
                </span>
                {installing && <Spinner size={11} decorative />}
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
                {rowTitle && <span className="sr-only">{rowTitle}</span>}
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

  if (embedded) {
    if (!present) return null
    return <div data-testid="agent-switch-menu">{contentBody}</div>
  }

  if (isMobile) {
    return (
      <span className="inline-flex min-w-0 items-center gap-0.5">
        <SelectorModal
          open={open}
          onOpenChange={handleOpenChange}
          title="Switch agent"
          trigger={pill}
          disabled={controlDisabled}
        >
          {contentBody}
        </SelectorModal>
        {cancelAffordance}
      </span>
    )
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild disabled={controlDisabled}>
          {pill}
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-72 p-1">
          <div className={SELECTOR_SECTION_LABEL}>Switch agent</div>
          {contentBody}
        </PopoverContent>
      </Popover>
      {cancelAffordance}
    </span>
  )
}
