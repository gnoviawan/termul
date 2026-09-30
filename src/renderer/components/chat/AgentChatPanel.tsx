import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import {
  emptyPendingLauncherOptions,
  overlayPendingLauncherOptions
} from '@/components/agents/pending-launcher-options'
import { MODEL_CATEGORY } from '@/components/chat/chat-input-bar-config'
import { Loader2 } from '@/components/icons'
import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
import { buildPromptWithLoadedSkills, useAgentSkills } from '@/hooks/use-agent-skills'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useOskViewport } from '@/hooks/use-osk-viewport'
import { useVisibleSnapshot } from '@/hooks/use-visible-snapshot'
import type { AvailableCommand, ContentBlock, PlanEntry, SessionId, ToolCall } from '@/lib/acp-api'
import type { AgentSwitchRecord } from '@/lib/acp-history-persistence'
import {
  extractCommandNames,
  extractSkillNames,
  replaceFileTokensInline,
  stripAllCommandTokens
} from '@/lib/skill-tokens'
import { isTauriContext } from '@/lib/tauri-runtime'
import { getDefaultCwdForProject, getProjectRootPath } from '@/lib/worktree-context'
import {
  prepareChatKey,
  useAcpMessages,
  useAcpSession,
  useAcpStore,
  usePromptQueue
} from '@/stores/acp-store'
import { isAgentDeadError } from '@/stores/prompt-queue-orchestration'
import { agentChatTabId, useWorkspaceStore } from '@/stores/workspace-store'
import { AgentConnectionLamp } from './AgentConnectionLamp'
import { AskUserQuestion } from './AskUserQuestion'
import { ChatChangedFilesPanel } from './ChatChangedFilesPanel'
import { ChatErrorNotice } from './ChatErrorNotice'
import { ChatInputBar } from './ChatInputBar'
import { ChatMessageList } from './ChatMessageList'
import { CHAT_GUTTER_X } from './chat-layout'
import { buildTimeline, consolidateThoughtGroups } from './chat-timeline'
import { PendingRestartBanner } from './PendingRestartBanner'
import { PermissionPrompt } from './PermissionPrompt'
import { PlanPanel } from './PlanPanel'

/** Concatenate the text blocks of a message into a single string. */
function messageText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

const EMPTY_COMMANDS: AvailableCommand[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []
const EMPTY_AGENT_SWITCHES: AgentSwitchRecord[] = []
const EMPTY_PLAN: PlanEntry[] = []

function ChatRestorePreload(): React.JSX.Element {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 bg-background text-muted-foreground"
      role="status"
      aria-live="polite"
      aria-label="Restoring chat"
    >
      <div className="flex size-16 items-center justify-center">
        <TermulMark
          size={52}
          className="animate-pulse text-foreground motion-reduce:animate-none"
        />
      </div>
      <div className="space-y-1 text-center">
        <div className="text-sm font-medium text-foreground/90">Restoring chat</div>
        <div className="text-xs text-muted-foreground">Loading your conversation…</div>
      </div>
    </div>
  )
}

interface AgentChatPanelProps {
  sessionId: SessionId
  /**
   * Whether this panel's tab is the pane's active tab. Gates the restored-tab
   * rehydrate so only visible chats trigger `openHistorySession` (a hidden
   * restored tab must not cold-spawn an agent in the background).
   */
  isVisible?: boolean
}

/**
 * Top-level agent-chat pane body. Renders the header, message thread, and input
 * for a single session. Mounted by PaneContent for `agent-chat` tabs.
 */
export function AgentChatPanel({
  sessionId,
  isVisible = true
}: AgentChatPanelProps): React.JSX.Element {
  const session = useAcpSession(sessionId)
  // Multi-project perf (render gate): keep live store subscriptions but
  // freeze the derived arrays while this tab is hidden — hidden panels skip
  // the per-flush timeline rebuild + Streamdown re-parse (the dominant
  // render cost). `useVisibleSnapshot` re-syncs on the first visible render,
  // so everything streamed while hidden renders then. Mount is keyed on the
  // chat tab id (embeds sessionId), so session changes remount and can never
  // read a stale snapshot.
  const messages = useVisibleSnapshot(isVisible, useAcpMessages(sessionId))
  const toolCalls = useVisibleSnapshot(
    isVisible,
    useAcpStore((s) => s.toolCalls[sessionId] ?? EMPTY_TOOL_CALLS)
  )
  // Durable agent-switch markers (CAP-2): feed the timeline so the borderless
  // separator renders at its seq position.
  const agentSwitches = useVisibleSnapshot(
    isVisible,
    useAcpStore((s) => s.agentSwitches[sessionId] ?? EMPTY_AGENT_SWITCHES)
  )
  // Available skills (with paths) so retry can re-frame the wire from the
  // token names in the last user message (skill paths are not persisted with
  // the message — see the spec's Never: no new ContentBlock type).
  // Skills live at {project.path}/.agents/skills/ which is gitignored and
  // excluded from worktree symlinks, so resolve against the main project root
  // — not session.cwd which may be a worktree path with no .agents/skills/.
  const skillsProjectRoot = session ? getProjectRootPath(session.projectId) : undefined
  const { skills: availableSkills } = useAgentSkills(skillsProjectRoot)
  const imageCapable = useAcpStore((s) =>
    session ? Boolean(s.agents[session.agentId]?.capabilities?.promptCapabilities?.image) : false
  )
  const embedCapable = useAcpStore((s) =>
    session
      ? Boolean(s.agents[session.agentId]?.capabilities?.promptCapabilities?.embeddedContext)
      : false
  )
  const commands = useAcpStore((s) => s.commands[sessionId] ?? EMPTY_COMMANDS)
  const hasFileChanges = useMemo(
    () => toolCalls.some((t) => t.kind === 'edit' || t.kind === 'delete' || t.kind === 'move'),
    [toolCalls]
  )
  const plan = useAcpStore((s) => s.plans[sessionId] ?? EMPTY_PLAN)
  // The oldest pending permission for THIS session (resolve one to reveal the next).
  const pendingPermission = useAcpStore(
    useShallow(
      (s) => Object.values(s.pendingPermissions).find((p) => p.sessionId === sessionId) ?? null
    )
  )
  // The oldest pending structured question for THIS session (issue #411).
  const pendingQuestion = useAcpStore(
    useShallow(
      (s) => Object.values(s.pendingQuestions).find((q) => q.sessionId === sessionId) ?? null
    )
  )
  const sendPrompt = useAcpStore((s) => s.sendPrompt)
  const sendPromptBlocks = useAcpStore((s) => s.sendPromptBlocks)
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)
  const removeQueuedPrompt = useAcpStore((s) => s.removeQueuedPrompt)
  const sendQueuedPromptNow = useAcpStore((s) => s.sendQueuedPromptNow)
  const retryCrashedSession = useAcpStore((s) => s.retryCrashedSession)
  const retryFailedLaunch = useAcpStore((s) => s.retryFailedLaunch)
  const promptQueue = usePromptQueue(sessionId)
  const setConfigOption = useAcpStore((s) => s.setConfigOption)
  const setMode = useAcpStore((s) => s.setMode)
  const setModel = useAcpStore((s) => s.setModel)
  const setSwitchPendingOption = useAcpStore((s) => s.setSwitchPendingOption)
  // Story 5.3 (AC3): WS transport-level reconnect flag (separate from the
  // session-level `isClosed && isOpeningHistory` banner). Desktop Tauri never
  // uses the WS transport, so this stays `false` there.
  const transportReconnecting = useAcpStore((s) => s.transportReconnecting)

  // Story 5.3 (AC1): OSK awareness on mobile web. On Tauri desktop, the hook
  // returns a no-OSK default and `useMobileWebShell()` is always false — the
  // spacer and scroll-into-view are inert (desktop non-regression).
  const osk = useOskViewport()
  const isMobileShell = useMobileWebShell()
  const showOskSpacer = isMobileShell && osk.isOskOpen && osk.keyboardHeight > 0
  // Track closed→open OSK transitions so we can scroll the latest message
  // into view exactly once per OSK-open window (T2.2).
  const prevOskOpenRef = useRef(false)
  useEffect(() => {
    const wasOpen = prevOskOpenRef.current
    prevOskOpenRef.current = osk.isOskOpen
    if (!wasOpen && osk.isOskOpen && isMobileShell) {
      // OSK just opened — scroll the latest message into view so the
      // conversation timeline keeps the latest message visible above the OSK.
      // We locate the inner MessageScrollerViewport (it has
      // `data-slot="message-scroller-viewport"`) and scroll it to the bottom.
      // The MessageScrollerProvider's auto-scroll already handles streaming;
      // this handles the OSK-open transition case.
      const root = rootRef.current
      if (root) {
        const scroller = root.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
        if (scroller) {
          requestAnimationFrame(() => {
            scroller.scrollTop = scroller.scrollHeight
          })
        }
      }
    }
  }, [osk.isOskOpen, isMobileShell])

  // Restored-tab rehydration: a persisted `agent-chat` tab can outlive its
  // in-memory session (app restart). When this panel is visible, its session
  // record is missing, and history exists for the id, reopen it from history
  // (deduped store-side against a concurrent sidebar open).
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const openDiscoveredSession = useAcpStore((s) => s.openDiscoveredSession)
  const discoveredReopenContext = useAcpStore((s) => s.discoveredReopenContexts[sessionId] ?? null)
  const hasHistoryEntry = useAcpStore((s) => s.sessionIndex.some((e) => e.id === sessionId))
  const isOpeningHistory = useAcpStore((s) => Boolean(s.openingHistoryIds[sessionId]))
  const isRestoringChat = useAcpStore((s) => Boolean(s.restoringChatIds[sessionId]))
  const isLaunchingSession = useAcpStore((s) => Boolean(s.launchingSessionIds[sessionId]))
  const [rehydrateError, setRehydrateError] = useState<string | null>(null)
  useEffect(() => {
    if (!isVisible || session || !hasHistoryEntry || rehydrateError) return
    let cancelled = false
    void openHistorySession(sessionId).catch((err) => {
      if (!cancelled) setRehydrateError(String(err))
    })
    return () => {
      cancelled = true
    }
  }, [isVisible, session, hasHistoryEntry, rehydrateError, openHistorySession, sessionId])

  // Composer seed (edit a message / pick a starter prompt) + dismissed-error tracking.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const seedComposer = useCallback((text: string) => setSeed({ text, nonce: Date.now() }), [])

  const handleRemoveQueued = useCallback(
    (queueId: string) => {
      removeQueuedPrompt(sessionId, queueId)
    },
    [removeQueuedPrompt, sessionId]
  )

  const handleSendQueuedNow = useCallback(
    (queueId: string) => {
      void sendQueuedPromptNow(sessionId, queueId).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error('Could not send the queued message. Try again.')
      })
    },
    [sendQueuedPromptNow, sessionId]
  )

  const handleSend = useCallback(
    (text: string) => {
      void sendPrompt(sessionId, text).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error('Could not send your message. Try again.')
      })
    },
    [sendPrompt, sessionId]
  )

  const handleSendBlocks = useCallback(
    (blocks: ContentBlock[], displayBlocks?: ContentBlock[]) => {
      void sendPromptBlocks(sessionId, blocks, { displayBlocks }).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error('Could not send your message. Try again.')
      })
    },
    [sendPromptBlocks, sessionId]
  )

  const handleCancel = useCallback(() => {
    void cancelPrompt(sessionId).catch(() => {
      toast.error('Could not cancel the turn. Try again.')
    })
  }, [cancelPrompt, sessionId])

  // Armed-switch option scoping (spec-acp-composer-option-fidelity): while a
  // switch is armed the composer is a launcher for the TARGET config — its
  // chips render the target's advertised options (prepared session →
  // `agentOptionsCache` → empty) with `switching.pendingOptions` overlaid, and
  // picks route into `setSwitchPendingOption` instead of the live session's
  // setters (the old session's wire + persisted cache stay untouched).
  const switching = session?.switching ?? null
  const switchToConfigId = switching?.toConfigId ?? null
  const switchPreparedSessionId = useAcpStore((s) =>
    switchToConfigId && session
      ? (s.preparedSessions[prepareChatKey(switchToConfigId, session.cwd, undefined)] ?? null)
      : null
  )
  const switchPreparedSession = useAcpSession(switchPreparedSessionId)
  const switchOptionsCache = useAcpStore((s) =>
    switchToConfigId ? (s.agentOptionsCache[switchToConfigId] ?? null) : null
  )
  const armedOptions = useMemo(
    () =>
      switching == null
        ? null
        : overlayPendingLauncherOptions({
            models: switchPreparedSession?.models ?? switchOptionsCache?.models ?? null,
            modes: switchPreparedSession?.modes ?? switchOptionsCache?.modes ?? null,
            configOptions:
              switchPreparedSession?.configOptions ?? switchOptionsCache?.configOptions ?? [],
            pending: switching.pendingOptions ?? emptyPendingLauncherOptions()
          }),
    [switching, switchPreparedSession, switchOptionsCache]
  )
  // ChatInputBar reads `session.models` / `session.modes` internally for the
  // model and Agent chips — pass a memoized session carrying the TARGET's
  // option state while armed.
  const composerSession = useMemo(() => {
    if (!session || !armedOptions) return session
    return {
      ...session,
      models: armedOptions.models,
      modes: armedOptions.modes,
      configOptions: armedOptions.configOptions
    }
  }, [session, armedOptions])

  const handleSetConfig = useCallback(
    async (configId: string, valueId: string) => {
      if (switchToConfigId) {
        await setSwitchPendingOption(sessionId, { configValues: { [configId]: valueId } })
        return
      }
      try {
        await setConfigOption(sessionId, configId, valueId)
      } catch (err) {
        toast.error('Could not update that setting. Try again.')
        throw err
      }
    },
    [setConfigOption, setSwitchPendingOption, sessionId, switchToConfigId]
  )

  const handleSetMode = useCallback(
    async (modeId: string) => {
      if (switchToConfigId) {
        await setSwitchPendingOption(sessionId, { modeId })
        return
      }
      try {
        await setMode(sessionId, modeId)
      } catch (err) {
        toast.error('Could not switch mode. Try again.')
        throw err
      }
    },
    [setMode, setSwitchPendingOption, sessionId, switchToConfigId]
  )

  const handleSetModel = useCallback(
    async (modelId: string) => {
      if (switchToConfigId) {
        // Mirror the launcher's dual-write: when the target's model resolves
        // via a config option (not the native models state), record it in
        // configValues too so the pick applies through whichever surface the
        // new session advertises.
        const modelConfigOption = armedOptions?.configOptions.find(
          (o) => o.category === MODEL_CATEGORY
        )
        await setSwitchPendingOption(
          sessionId,
          modelConfigOption
            ? { modelId, configValues: { [modelConfigOption.id]: modelId } }
            : { modelId }
        )
        return
      }
      try {
        await setModel(sessionId, modelId)
      } catch (err) {
        toast.error('Could not switch model. Try again.')
        throw err
      }
    },
    [armedOptions, setModel, setSwitchPendingOption, sessionId, switchToConfigId]
  )

  // Most recent user turn — drives the regenerate/retry affordances. We keep
  // the original blocks so retrying re-sends structured attachments (images,
  // resource/file-ref), not just the concatenated text; an attachment-only
  // prompt (no text) is still retryable via the blocks.
  const lastUserBlocks = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].blocks
    }
    return null
  }, [messages])
  const lastUserText = lastUserBlocks ? messageText(lastUserBlocks) : ''
  const canRetryLastUserTurn = Boolean(
    lastUserBlocks?.some((b) => b.type !== 'text' || (b.text ?? '').trim().length > 0)
  )

  const handleRetry = useCallback(() => {
    // Failed launch (prepare/spawn never produced a session): re-run prepare
    // against the recorded launch config. Clear the dismissal FIRST so a
    // repeated failure re-surfaces the banner — no circular "Could not retry"
    // toast (the banner is the error surface for this path).
    if (session?.status === 'error' && session.launchConfigId) {
      setDismissedError(null)
      void retryFailedLaunch(sessionId).catch(() => {
        // The failure already lands in session.lastError via finalizeChatLaunch.
      })
      return
    }
    if (!lastUserBlocks || !canRetryLastUserTurn) return
    setDismissedError(session?.lastError ?? null)
    // A crashed/disconnected chat can't re-send into the dead agent — restart
    // the agent + replay history first (user-initiated Retry; honors ADR-003's
    // no-silent-respawn: the crash is still surfaced, respawn is on click).
    if (session?.status === 'error' || session?.status === 'closed') {
      void retryCrashedSession(sessionId).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error('Could not retry. Try again.')
      })
      return
    }
    // Re-frame the wire from the token text in the last user message's text
    // blocks + the currently-available skills' paths (skill paths are not
    // persisted with the message — the spec's Never forbids a new ContentBlock
    // type, so the wire is reconstructed at retry time like the composer does).
    // The display (token) blocks are passed through unchanged so the timeline
    // keeps rendering inline chips. If a skill name no longer resolves to a
    // path (e.g. the skill was uninstalled), surface a clear error and abort.
    // Mirrors `buildPromptParts` exactly: strip the command tokens before the
    // skill/file framer, then prefix `/<name> ` back so a retried command turn
    // stays byte-identical to a fresh send (no sentinel leaks to the agent).
    const tokenText = lastUserText
    const commandNames = extractCommandNames(tokenText)
    const commandName = commandNames[0] ?? null
    const valueDecommanded = commandNames.length > 0 ? stripAllCommandTokens(tokenText) : tokenText
    const skillNames = extractSkillNames(valueDecommanded)
    const skills = skillNames.map((name) => ({
      name,
      path: availableSkills.find((s) => s.name === name)?.path ?? ''
    }))
    const missingPath = skills.find((s) => !s.path)
    if (missingPath) {
      toast.error(`Skill '${missingPath.name}' is missing a path`)
      return
    }
    // File tokens → `(display)` before the skill framer (buildPromptParts'
    // `valueDefiled`) so file-mention sentinels never leak to the wire either.
    const valueDefiled = replaceFileTokensInline(valueDecommanded)
    const wireText =
      skills.length > 0 ? buildPromptWithLoadedSkills(skills, valueDefiled) : valueDefiled
    const wireWithCommand = commandName ? `/${commandName} ${wireText}` : wireText
    // Build wire blocks: replace the text payload with the re-framed wire text,
    // preserving non-text (image/resource) blocks from the original message.
    const wireBlocks: ContentBlock[] = []
    const wireTrimmed = wireWithCommand.trim()
    if (wireTrimmed) wireBlocks.push({ type: 'text', text: wireWithCommand })
    for (const b of lastUserBlocks) {
      if (b.type !== 'text') wireBlocks.push(b)
    }
    // Display = the original (token) blocks so the timeline keeps chips.
    void sendPromptBlocks(sessionId, wireBlocks, { displayBlocks: lastUserBlocks }).catch((err) => {
      if (isAgentDeadError(err)) return
      toast.error('Could not send your message. Try again.')
    })
  }, [
    lastUserBlocks,
    canRetryLastUserTurn,
    lastUserText,
    availableSkills,
    sendPromptBlocks,
    retryCrashedSession,
    retryFailedLaunch,
    sessionId,
    session?.status,
    session?.launchConfigId,
    session?.lastError
  ])

  const filePathContext = useMemo(
    () =>
      isTauriContext()
        ? {
            cwd: session?.cwd,
            projectRoot: session
              ? getDefaultCwdForProject(session.projectId) || session.cwd
              : undefined
          }
        : undefined,
    [session]
  )
  const timeline = useMemo(() => {
    const items = consolidateThoughtGroups(buildTimeline(messages, toolCalls, agentSwitches))
    // The worktree-creation progress row is a first-class timeline item
    // injected right after the FIRST user message (index 0 when no user
    // message exists — restart-without-prompt launches). `groupTurnActivity`
    // emits it top-level like a switch marker. The row lives for the
    // session's lifetime: `worktreeProgressId` and the op record are
    // deliberately retained (never persisted) so the done row keeps rendering.
    const progressId = session?.worktreeProgressId
    if (progressId) {
      const firstUser = items.findIndex(
        (item) => item.kind === 'message' && item.message.role === 'user'
      )
      items.splice(firstUser >= 0 ? firstUser + 1 : 0, 0, {
        kind: 'worktree',
        key: `worktree:${progressId}`,
        progressId
      })
    }
    return items
  }, [messages, toolCalls, agentSwitches, session?.worktreeProgressId])
  // Keep the bottom cue visible for the complete turn, including while thought,
  // tool, and agent-message surfaces stream their own local progress.
  const showRunningIndicator = Boolean(session?.activeTurn)

  // Story 5.3 (T2.1): the AgentChatPanel root doubles as the OSK-aware
  // container. We attach a ref so the OSK-open transition effect can locate
  // the inner message-scroller viewport and scroll the latest message into
  // view (T2.2).
  const rootRef = useRef<HTMLDivElement>(null)

  if (isRestoringChat) return <ChatRestorePreload />

  if (!session) {
    if (rehydrateError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <div className="max-w-md space-y-1 px-6 text-center">
            <div className="text-foreground">Failed to restore chat.</div>
            <div className="break-words text-xs text-muted-foreground">{rehydrateError}</div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setRehydrateError(null)}>
            Retry
          </Button>
        </div>
      )
    }
    if (isOpeningHistory || hasHistoryEntry) return <ChatRestorePreload />
    // Corpse tab: the tab outlived its session (failed launch, pruned history).
    // Offer an explicit way out instead of a dead-end label.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <div className="max-w-md space-y-1 px-6 text-center">
          <div className="text-foreground">This chat is unavailable.</div>
          <div className="text-xs text-muted-foreground">
            The session no longer exists. Close this tab, or open another chat from history.
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => useWorkspaceStore.getState().removeTab(agentChatTabId(sessionId))}
        >
          Close tab
        </Button>
      </div>
    )
  }

  const isClosed = session.status === 'closed'
  // Failed launches keep the Retry affordance even without a user prompt in
  // the transcript (the retry relaunches without re-sending).
  const isFailedLaunch = session.status === 'error' && Boolean(session.launchConfigId)
  const canOfferRetry = (canRetryLastUserTurn || isFailedLaunch) && !session.activeTurn
  const retryDiscoveredReopen = discoveredReopenContext
    ? () => {
        void openDiscoveredSession(
          discoveredReopenContext.agentId,
          sessionId,
          discoveredReopenContext.cwd,
          discoveredReopenContext.projectId
        ).catch(() => {
          toast.error('Could not open that chat. Try again.')
        })
      }
    : undefined
  const activeError =
    session.lastError && session.lastError !== dismissedError ? session.lastError : null

  return (
    <div
      ref={rootRef}
      className="@container flex h-full flex-col bg-terminal-bg"
      // Story 5.3 (T2.1): apply OSK spacer as bottom padding so the sticky
      // composer card stays visible above the on-screen keyboard. iOS Safari
      // ignores `interactive-widget=resizes-content` (T3.1) — the layout
      // viewport doesn't shrink, so we push the composer up manually. On
      // Android Chrome 108+ with the meta, the layout viewport already
      // shrinks; this spacer is a no-op (keyboardHeight mirrors visualViewport
      // shrink, which is already accounted for by the shrunk h-full). The
      // `showOskSpacer` gate ensures this only fires in the mobile web shell.
      style={
        showOskSpacer
          ? { paddingBottom: `var(--termul-keyboard-height, ${osk.keyboardHeight}px)` }
          : undefined
      }
    >
      <PendingRestartBanner sessionId={sessionId} />
      {isClosed && isOpeningHistory && !isLaunchingSession && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          Resuming chat…
        </div>
      )}
      {isClosed &&
        !isOpeningHistory &&
        !isLaunchingSession &&
        discoveredReopenContext &&
        session.lastError && (
          <div className="flex items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            <span>Failed to restore agent chat.</span>
            <button
              type="button"
              onClick={retryDiscoveredReopen}
              className="inline-flex min-h-11 items-center rounded-md border border-destructive/40 px-3 text-xs font-medium transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 @[400px]:min-h-10"
            >
              Retry restore
            </button>
          </div>
        )}
      {isClosed &&
        !isOpeningHistory &&
        !isLaunchingSession &&
        hasHistoryEntry &&
        !discoveredReopenContext && (
          <div className="flex items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning">
            <span>This chat stopped.</span>
            <button
              type="button"
              onClick={() => {
                void openHistorySession(sessionId).catch(() => {
                  toast.error('Could not resume this chat. Try again.')
                })
              }}
              className="inline-flex min-h-11 items-center rounded-md border border-warning/40 px-3 text-xs font-medium transition-colors hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 @[400px]:min-h-10"
            >
              Resume chat
            </button>
          </div>
        )}
      {transportReconnecting && (
        // Story 5.3 (AC3, T5.3): transport-level reconnect overlay. This is
        // DISTINCT from the session-level "Reconnecting to agent…" banner
        // above (which fires when `openHistorySession` is in flight). Both can
        // show simultaneously. The overlay is non-blocking (`pointer-events-none`
        // on the container) so already-rendered messages remain interactive.
        // Reuses `AgentConnectionLamp` (amber+pulse via the `reconnecting`
        // prop) — no new indicator component (NFR9, AC3).
        <div
          className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded-full border border-border/60 bg-background/80 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <AgentConnectionLamp connected={false} reconnecting decorative size={8} />
          <span>Reconnecting…</span>
        </div>
      )}
      <ChatErrorNotice
        message={activeError}
        onRetry={canOfferRetry ? handleRetry : undefined}
        retryLabel={
          !session.launchConfigId && (session.status === 'error' || session.status === 'closed')
            ? 'Resume chat'
            : 'Retry'
        }
        onDismiss={() => setDismissedError(session.lastError)}
      />
      <PlanPanel key={`plan-${session.id}`} entries={plan} />
      <ChatMessageList
        items={timeline}
        sessionId={session.id}
        agentId={session.agentId}
        showRunningIndicator={showRunningIndicator}
        filePathContext={filePathContext}
        onEditMessage={seedComposer}
        onRetry={canOfferRetry ? handleRetry : undefined}
      />
      {pendingQuestion && !isClosed ? (
        <>
          {pendingPermission && (
            <div className={`${CHAT_GUTTER_X} pb-2 pt-3`}>
              <div className="mx-auto w-full max-w-3xl">
                <PermissionPrompt permission={pendingPermission} embedded={false} />
              </div>
            </div>
          )}
          <AskUserQuestion key={pendingQuestion.questionId} question={pendingQuestion} />
        </>
      ) : (
        <>
          <ChatChangedFilesPanel cwd={session.cwd} toolCalls={toolCalls} />
          <ChatInputBar
            session={composerSession ?? session}
            projectRoot={skillsProjectRoot}
            busy={session.activeTurn}
            disabled={isClosed}
            imageCapable={imageCapable}
            embedCapable={embedCapable}
            onSend={handleSend}
            onSendBlocks={handleSendBlocks}
            onCancel={handleCancel}
            queue={promptQueue}
            permission={pendingPermission && !isClosed ? pendingPermission : null}
            onRemoveQueued={handleRemoveQueued}
            onSendQueuedNow={handleSendQueuedNow}
            commands={commands}
            configOptions={armedOptions ? armedOptions.configOptions : session.configOptions}
            modes={armedOptions ? armedOptions.modes : session.modes}
            onSetConfig={handleSetConfig}
            onSetMode={handleSetMode}
            onSetModel={handleSetModel}
            seedText={seed?.text}
            seedNonce={seed?.nonce}
            compactTop={hasFileChanges}
            isVisible={isVisible}
          />
        </>
      )}
    </div>
  )
}
