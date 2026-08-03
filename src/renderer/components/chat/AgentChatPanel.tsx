import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import {
  emptyPendingLauncherOptions,
  overlayPendingLauncherOptions
} from '@/components/agents/pending-launcher-options'
import { MODEL_CATEGORY } from '@/components/chat/chat-input-bar-config'
import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAcpStoreVisible } from '@/hooks/use-acp-visible-store'
import { buildPromptWithLoadedSkills, useAgentSkills } from '@/hooks/use-agent-skills'
import { RECONNECT_GRACE_MS, useDelayedFlag } from '@/hooks/use-delayed-flag'
import { useDockClearance } from '@/hooks/use-dock-clearance'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useInterfaceOverlayOpen } from '@/hooks/use-native-webview-occlusion'
import { useOskViewport } from '@/hooks/use-osk-viewport'
import type { AvailableCommand, ContentBlock, PlanEntry, SessionId, ToolCall } from '@/lib/acp-api'
import type { AgentSwitchRecord } from '@/lib/acp-history-persistence'
import { formatAcpAgentError } from '@/lib/agents/acp-spawn-errors'
import { CODEX_CLI_SIGNED_OUT_MESSAGE } from '@/lib/agents/codex-cli-auth'
import { logFrontendError } from '@/lib/log-api'
import {
  extractSkillNames,
  replaceCommandTokensInline,
  replaceFileTokensInline
} from '@/lib/skill-tokens'
import { isTauriContext } from '@/lib/tauri-runtime'
import { getProjectRootPath } from '@/lib/worktree-context'
import {
  type ChatMessage,
  prepareChatKey,
  useAcpSession,
  useAcpStore,
  usePromptQueue
} from '@/stores/acp-store'
import { isResumeFailureError } from '@/stores/acp-store/helpers'
import { isLaunchPlaceholderSessionId } from '@/stores/acp-store/live-turn'
import { useConsentCardHost } from '@/stores/browser-consent-card-store'
import { useIsConsentStripHosting } from '@/stores/browser-consent-strip-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useGitSheetStore } from '@/stores/git-sheet-store'
import { useProjectStore } from '@/stores/project-store'
import { isAgentDeadError } from '@/stores/prompt-queue-orchestration'
import { agentChatTabId, findPaneContainingTab, useWorkspaceStore } from '@/stores/workspace-store'
import { AgentConnectionLamp } from './AgentConnectionLamp'
import { AskUserQuestion } from './AskUserQuestion'
import { BrowserConsentCard } from './BrowserConsentCard'
import { ChatChangedFilesPanel } from './ChatChangedFilesPanel'
import { ChatErrorNotice } from './ChatErrorNotice'
import { ChatInputBar } from './ChatInputBar'
import { ChatMessageList } from './ChatMessageList'
import { CHAT_GUTTER_X } from './chat-layout'
import { ChatStarters } from './chat-start'
import { buildTimeline, consolidateThoughtGroups } from './chat-timeline'
import { ClaudeLimitNotice } from './claude-account/ClaudeLimitNotice'
import { ElicitationPrompt } from './ElicitationPrompt'
import { PendingRestartBanner } from './PendingRestartBanner'
import { PermissionPrompt } from './PermissionPrompt'
import { PlanPanel } from './PlanPanel'
import { PromptReconcileNotice } from './PromptReconcileNotice'
import { useApprovalDock } from './use-approval-dock'
import { AUTO_RESUME_FAILED_REASON, useIdleStopAutoResume } from './use-idle-stop-auto-resume'

/** Concatenate the text blocks of a message into a single string. */
function messageText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

const EMPTY_COMMANDS: AvailableCommand[] = []
const EMPTY_MESSAGES: ChatMessage[] = []
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
  // Multi-project perf (render gate): `useAcpStoreVisible` suppresses the
  // store notify while this tab is hidden — the subscription stays live, but
  // a hidden panel pays ZERO render work per stream flush. Each selector
  // returns the last-visible value while hidden (freeze contract, same as
  // the previous useVisibleSnapshot wrapper) and re-syncs in the single
  // commit that runs when the tab becomes active again.
  const messages = useAcpStoreVisible((s) => s.messages[sessionId] ?? EMPTY_MESSAGES, isVisible)
  const toolCalls = useAcpStoreVisible((s) => s.toolCalls[sessionId] ?? EMPTY_TOOL_CALLS, isVisible)
  // Durable agent-switch markers (CAP-2): feed the timeline so the borderless
  // separator renders at its seq position.
  const agentSwitches = useAcpStoreVisible(
    (s) => s.agentSwitches[sessionId] ?? EMPTY_AGENT_SWITCHES,
    isVisible
  )
  // token names in the last user message (skill paths are not persisted with
  // the message — see the spec's Never: no new ContentBlock type).
  // Skills live at {project.path}/.agents/skills/ which is gitignored and
  // excluded from worktree symlinks, so resolve against the main project root
  // — not session.cwd which may be a worktree path with no .agents/skills/.
  const skillsProjectRoot = session ? getProjectRootPath(session.projectId) : undefined
  const { skills: availableSkills } = useAgentSkills(skillsProjectRoot)
  const switching = session?.switching ?? null
  const switchToConfigId = switching?.toConfigId ?? null
  const switchPreparedSessionId = useAcpStore((s) =>
    switchToConfigId && session
      ? (s.preparedSessions[prepareChatKey(switchToConfigId, session.cwd, undefined)] ?? null)
      : null
  )
  const switchPreparedSession = useAcpStore(
    useShallow((s) => {
      const prepared = switchPreparedSessionId ? s.sessions[switchPreparedSessionId] : undefined
      return {
        agentId: prepared?.agentId ?? null,
        models: prepared?.models,
        modes: prepared?.modes,
        configOptions: prepared?.configOptions,
        mcpServerCount: prepared?.mcpServerCount
      }
    })
  )
  const promptAgentId = switching ? switchPreparedSession.agentId : (session?.agentId ?? null)
  const promptSessionId = switching ? switchPreparedSessionId : sessionId
  const imageCapable = useAcpStore((s) =>
    promptAgentId
      ? Boolean(s.agents[promptAgentId]?.capabilities?.promptCapabilities?.image)
      : false
  )
  const embedCapable = useAcpStore((s) =>
    promptAgentId
      ? Boolean(s.agents[promptAgentId]?.capabilities?.promptCapabilities?.embeddedContext)
      : false
  )
  const commands = useAcpStore((s) =>
    promptSessionId ? (s.commands[promptSessionId] ?? EMPTY_COMMANDS) : EMPTY_COMMANDS
  )
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
  const pendingElicitation = useAcpStore(
    useShallow(
      (s) =>
        Object.values(s.pendingElicitations ?? {}).find((item) => item.sessionId === sessionId) ??
        null
    )
  )
  // Pending browser-automation consent for THIS session (CAP-5): the in-chat
  // card renders adjacent to the input while the in-pane strip is not hosting.
  const pendingBrowserConsent = useAcpStore(
    useShallow(
      (s) =>
        Object.values(s.pendingBrowserConsents ?? {}).find((c) => c.sessionId === sessionId) ?? null
    )
  )
  // CAP-5: the panel owns the fallback card while the strip is not hosting —
  // mirrored by the render gate below (`showBrowserConsentCard`).
  const stripHosting = useIsConsentStripHosting()
  const overlayOpen = useInterfaceOverlayOpen()
  const registerConsentCard = useConsentCardHost((s) => s.register)
  const unregisterConsentCard = useConsentCardHost((s) => s.unregister)
  // A registered session means "a visible consent card is on screen in this
  // panel" — the root-level BrowserConsentCardHost renders fallback cards only
  // for unhosted sessions. Registration requires the chat tab to be its pane's
  // active tab (isVisible): a card hidden behind another tab is registered by
  // nobody, so the root host takes over. Closed sessions never host (the
  // request is stale — the host timed it out).
  const consentCardHosted =
    pendingBrowserConsent != null && isVisible && session?.status !== 'closed'
  useEffect(() => {
    if (!consentCardHosted) return
    registerConsentCard(sessionId)
    return () => unregisterConsentCard(sessionId)
  }, [consentCardHosted, sessionId, registerConsentCard, unregisterConsentCard])
  const sendPrompt = useAcpStore((s) => s.sendPrompt)
  const sendPromptBlocks = useAcpStore((s) => s.sendPromptBlocks)
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)
  const removeQueuedPrompt = useAcpStore((s) => s.removeQueuedPrompt)
  const sendQueuedPromptNow = useAcpStore((s) => s.sendQueuedPromptNow)
  const retryCrashedSession = useAcpStore((s) => s.retryCrashedSession)
  // A turn error (auth required, timeout) can retire the chat's agent while
  // the chat itself stays live with its error banner.
  const agentRetired = useAcpStore((s) =>
    session ? s.agentStatus[session.agentId] === 'error' : false
  )
  const markResumeFailed = useAcpStore((s) => s.markResumeFailed)
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
  const hostOffline = useConnectionStatusStore((s) => s.controlChannel === 'host-offline')
  const promptCommand = useAcpStore((s) => s.promptCommandStates[sessionId])
  const recheckPromptCommand = useAcpStore((s) => s.recheckPromptCommand)
  // Quiet resume: a socket replaced on returning to the tab usually reconnects
  // (and settles any unconfirmed prompt) in well under a second, so the
  // "Reconnecting…" overlay and the "Waiting to confirm" pill only show once the
  // state has lasted the grace period. "Host offline" is not delayed. Above the
  // early returns so the hook order never changes.
  const showReconnecting = useDelayedFlag(transportReconnecting, RECONNECT_GRACE_MS)
  const showTransportOverlay = transportReconnecting && (hostOffline || showReconnecting)
  const showPromptReconcile = useDelayedFlag(
    promptCommand != null && session?.activeTurn === true,
    RECONNECT_GRACE_MS
  )

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
  // in-memory session (app restart) or bind a stale crashed record. When this
  // panel is visible and history exists for the id, reopen it from history
  // (deduped store-side against a concurrent sidebar open) when the session
  // record is missing OR errored — an 'error' record still points at the dead
  // agent, so leaving it bound lets sends dispatch to `unknown agent`.
  // `attemptedReopenRef` guards the loop: an open that resolves back to
  // 'error' (degraded read-only) must not immediately re-fire the effect.
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const openDiscoveredSession = useAcpStore((s) => s.openDiscoveredSession)
  const discoveredReopenContext = useAcpStore((s) => s.discoveredReopenContexts[sessionId] ?? null)
  const hasHistoryEntry = useAcpStore((s) => s.sessionIndex.some((e) => e.id === sessionId))
  const isOpeningHistory = useAcpStore((s) => Boolean(s.openingHistoryIds[sessionId]))
  const isRestoringChat = useAcpStore((s) => Boolean(s.restoringChatIds[sessionId]))
  const isLaunchingSession = useAcpStore((s) => Boolean(s.launchingSessionIds[sessionId]))
  const [rehydrateError, setRehydrateError] = useState<string | null>(null)
  const attemptedReopenRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isVisible || !hasHistoryEntry || rehydrateError) return
    if (session && session.status !== 'error') {
      // Only a landed 'active' record resets the attempt: a mid-open 'closed'
      // must NOT reset (an open resolving back to 'error' would otherwise
      // re-fire forever). A future crash after a healthy open may reopen.
      if (session.status === 'active') attemptedReopenRef.current = null
      return
    }
    // A resolved-but-still-errored reopen must not re-fire (loop); only a
    // rejected open retries via rehydrateError + user action.
    if (attemptedReopenRef.current === sessionId) return
    attemptedReopenRef.current = sessionId
    let cancelled = false
    void openHistorySession(sessionId).catch((err) => {
      if (!cancelled) setRehydrateError(String(err))
    })
    return () => {
      cancelled = true
    }
  }, [isVisible, session, hasHistoryEntry, rehydrateError, openHistorySession, sessionId])

  // A chat the idle reaper stopped resumes on the first keystroke or send
  // (never on view alone; the effect above deliberately skips 'closed').
  const { isResumableStop, autoResumeActive, startAutoResume } = useIdleStopAutoResume({
    sessionId,
    session,
    hasHistoryEntry,
    hasDiscoveredReopenContext: discoveredReopenContext != null,
    isOpeningHistory,
    isRestoringChat,
    isLaunchingSession,
    queuedCount: promptQueue.length,
    openHistorySession,
    markResumeFailed
  })

  // Manual "Resume chat" on a stopped chat (stopped bar or error notice). A
  // reopen can resolve still `closed` (read-only strategy) after clearing
  // `lastError`; record that as a failed resume so the bar, Needs you and a
  // remount keep agreeing (the store skips a Codex sign-out / existing failure).
  const resumeStoppedChat = useCallback(() => {
    void openHistorySession(sessionId).then(
      () => {
        if (useAcpStore.getState().sessions[sessionId]?.status === 'closed') {
          markResumeFailed(sessionId, AUTO_RESUME_FAILED_REASON)
        }
      },
      (err) => {
        if (isAgentDeadError(err)) return
        toast.error('Could not resume this chat. Try again.')
      }
    )
  }, [openHistorySession, markResumeFailed, sessionId])

  // A persisted launch-* tab is a failed-launch corpse. deserialize drops it
  // and reattach must not put it back; if one still mounts with no session
  // and no history, close it instead of "The session no longer exists."
  // Live launches create the session record before the tab, so they keep
  // `session` and are left alone.
  useEffect(() => {
    if (session || hasHistoryEntry || isOpeningHistory || isLaunchingSession) return
    if (!isLaunchPlaceholderSessionId(sessionId)) return
    void logFrontendError({
      level: 'warn',
      source: 'AgentChatPanel.launchPlaceholder',
      message: `Closing dropped launch placeholder tab ${sessionId}; a persisted session is restored from the history index when one exists`
    })
    useWorkspaceStore.getState().removeTab(agentChatTabId(sessionId))
  }, [session, hasHistoryEntry, isOpeningHistory, isLaunchingSession, sessionId])

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

  // A send into a cleanly stopped chat starts the resume FIRST: the open marks
  // `openingHistoryIds` synchronously, so `runPromptTurn` queues the prompt
  // and the open dispatches it once the agent is back.
  const handleSend = useCallback(
    (text: string) => {
      startAutoResume()
      void sendPrompt(sessionId, text).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error('Could not send your message. Try again.')
      })
    },
    [sendPrompt, sessionId, startAutoResume]
  )

  const handleSendBlocks = useCallback(
    (blocks: ContentBlock[], displayBlocks?: ContentBlock[]) => {
      startAutoResume()
      void sendPromptBlocks(sessionId, blocks, { displayBlocks }).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error('Could not send your message. Try again.')
      })
    },
    [sendPromptBlocks, sessionId, startAutoResume]
  )

  const handleCancel = useCallback(() => {
    void cancelPrompt(sessionId).catch(() => {
      toast.error('Could not cancel the turn. Try again.')
    })
  }, [cancelPrompt, sessionId])

  const switchOptionsCache = useAcpStore((s) =>
    switchToConfigId ? (s.agentOptionsCache[switchToConfigId] ?? null) : null
  )
  const armedOptions = useMemo(
    () =>
      switching == null
        ? null
        : overlayPendingLauncherOptions({
            models: switchPreparedSession.models ?? switchOptionsCache?.models ?? null,
            modes: switchPreparedSession.modes ?? switchOptionsCache?.modes ?? null,
            configOptions:
              switchPreparedSession.configOptions ?? switchOptionsCache?.configOptions ?? [],
            pending: switching.pendingOptions ?? emptyPendingLauncherOptions()
          }),
    [switching, switchPreparedSession, switchOptionsCache]
  )
  const switchMcpServerCount = switchPreparedSession.mcpServerCount
  const composerSession = useMemo(() => {
    if (!session || !armedOptions) return session
    return {
      ...session,
      models: armedOptions.models,
      modes: armedOptions.modes,
      configOptions: armedOptions.configOptions,
      mcpServerCount: switchMcpServerCount
    }
  }, [session, armedOptions, switchMcpServerCount])

  const handleSetConfig = useCallback(
    async (configId: string, valueId: string | boolean) => {
      if (switchToConfigId) {
        await setSwitchPendingOption(sessionId, {
          configValues: { [configId]: typeof valueId === 'boolean' ? String(valueId) : valueId }
        })
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
    // A stopped (closed) chat whose resume failed: reopen like the stopped
    // bar's Resume chat (never re-sends the finished last turn; keeps the
    // recorded failure until the open succeeds; flushes a queued prompt).
    // Offered even without a user turn. Clear the dismissal first so an
    // identical repeat failure re-surfaces the notice.
    if (
      session?.status === 'closed' &&
      !discoveredReopenContext &&
      isResumeFailureError(session.lastError)
    ) {
      setDismissedError(null)
      resumeStoppedChat()
      return
    }
    if (!lastUserBlocks || !canRetryLastUserTurn) return
    setDismissedError(session?.lastError ?? null)
    // A crashed/disconnected chat can't re-send into the dead agent — restart
    // the agent + replay history first (user-initiated Retry; honors ADR-003's
    // no-silent-respawn: the crash is still surfaced, respawn is on click).
    // A retired agent cannot take the re-send either: the restart stops it
    // and reopens the chat on a fresh one.
    if (session?.status === 'error' || session?.status === 'closed' || agentRetired) {
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
    // Mirrors `buildPromptParts`: command tokens become `/<name>` where the
    // user typed them. They are not moved to the front of the prompt.
    const tokenText = lastUserText
    const valueWithCommandText = replaceCommandTokensInline(tokenText)
    const skillNames = extractSkillNames(tokenText)
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
    const valueDefiled = replaceFileTokensInline(valueWithCommandText)
    const wireText =
      skills.length > 0 ? buildPromptWithLoadedSkills(skills, valueDefiled) : valueDefiled
    const wireWithCommand = wireText
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
    agentRetired,
    retryFailedLaunch,
    resumeStoppedChat,
    discoveredReopenContext,
    sessionId,
    session?.status,
    session?.launchConfigId,
    session?.lastError
  ])

  // Desktop + web parity: the open-in-editor chain is transport-agnostic —
  // where `/fs/info` is loopback-guarded on remote peers, resolution falls
  // back to the deliberately unguarded `/fs/read` open path (the same one
  // ChatChangedFilesPanel uses). Local-image reads stay Tauri-only inside
  // `TermulMarkdownImage` (alt-chip fallback).
  const projects = useProjectStore((state) => state.projects)
  const filePathContext = useMemo(
    () => ({
      cwd: session?.cwd,
      projectRoot: session
        ? projects.find((p) => p.id === session.projectId)?.path || session.cwd
        : undefined
    }),
    [session, projects]
  )
  const reloadMark = useAcpStore((s) => s.agentReloadMarks?.[sessionId] ?? null)
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
    if (reloadMark) {
      const anchor = reloadMark.afterMessageId
        ? items.findIndex(
            (item) => item.kind === 'message' && item.message.id === reloadMark.afterMessageId
          )
        : -1
      items.splice(anchor >= 0 ? anchor + 1 : items.length, 0, {
        kind: 'reload',
        key: `reload:${sessionId}:${reloadMark.afterMessageId ?? 'start'}`
      })
    }
    return items
  }, [messages, toolCalls, agentSwitches, session?.worktreeProgressId, reloadMark, sessionId])
  // Keep the bottom cue visible for the complete turn, including while thought,
  // tool, and agent-message surfaces stream their own local progress.
  const showRunningIndicator = Boolean(session?.activeTurn)
  // Same rule as ChatMessageList's empty state.
  const isEmptyChat = timeline.length === 0 && !showRunningIndicator

  // Story 5.3 (T2.1): the AgentChatPanel root doubles as the OSK-aware
  // container. We attach a ref so the OSK-open transition effect can locate
  // the inner message-scroller viewport and scroll the latest message into
  // view (T2.2).
  const rootRef = useRef<HTMLDivElement>(null)

  // Mobile dock around approvals: compact the plan / changed-files bars while
  // the keyboard is up with an approval pending, and return focus to the
  // composer card when a prompt that held focus resolves. The ids mirror the
  // render gates below (a closed session renders no prompt). Above the early
  // returns so the hook order never changes.
  const approvalsLive = session != null && session.status !== 'closed'
  const { compactDock, onFocus, onBlur } = useApprovalDock({
    rootRef,
    enabled: isMobileShell && isVisible,
    oskOpen: osk.isOskOpen,
    permissionId: approvalsLive ? (pendingPermission?.requestId ?? null) : null,
    questionId: approvalsLive ? (pendingQuestion?.questionId ?? null) : null,
    elicitationId: approvalsLive ? (pendingElicitation?.requestId ?? null) : null
  })
  const openGitSheet = useGitSheetStore((s) => s.openGitSheet)
  // The mobile dock (prompts, or the changed-files bar plus the composer)
  // reports its top edge so the toast stack clears it. The wrapper is a plain
  // box on the mobile shell and `display: contents` on desktop, so desktop
  // layout (the starters' `flex-1`) is unchanged. The hook is also above the
  // early returns: the wrapper may mount long after the first render.
  const dockRef = useDockClearance(isMobileShell && isVisible)
  const dockClassName = isMobileShell ? 'flex shrink-0 flex-col' : 'contents'

  // An automatic resume keeps the composer (and the draft being typed)
  // mounted; the "Resuming chat…" strip covers the reconnect instead.
  if (isRestoringChat && !(session && autoResumeActive)) return <ChatRestorePreload />

  if (!session) {
    if (rehydrateError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <div className="max-w-md space-y-1 px-6 text-center">
            <div className="text-foreground">Failed to restore chat.</div>
            <div className="break-words text-xs text-muted-foreground">{rehydrateError}</div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              // A manual Retry is the sanctioned re-attempt — clear the
              // attempt marker too, else the loop guard swallows this open.
              attemptedReopenRef.current = null
              setRehydrateError(null)
            }}
          >
            Retry
          </Button>
        </div>
      )
    }
    if (isOpeningHistory || hasHistoryEntry || isLaunchPlaceholderSessionId(sessionId)) {
      return <ChatRestorePreload />
    }
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
  const showBrowserConsentCard =
    pendingBrowserConsent != null && !isClosed && !stripHosting && !overlayOpen && isTauriContext()
  // Failed launches keep the Retry affordance even without a user prompt in
  // the transcript (the retry relaunches without re-sending).
  const isFailedLaunch = session.status === 'error' && Boolean(session.launchConfigId)
  const canOfferRetry = (canRetryLastUserTurn || isFailedLaunch) && !session.activeTurn
  // The error notice's "Resume chat" for a stopped chat whose resume failed
  // reopens without re-sending, so it needs no user turn in the transcript.
  const isClosedResumeFailure =
    isClosed && !discoveredReopenContext && isResumeFailureError(session.lastError)
  const canOfferNoticeRetry = (canOfferRetry || isClosedResumeFailure) && !session.activeTurn
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
  const codexSignedOut = session.lastError === CODEX_CLI_SIGNED_OUT_MESSAGE
  const activeError =
    !codexSignedOut && session.lastError && session.lastError !== dismissedError
      ? formatAcpAgentError(session.lastError)
      : null
  const openCodexSignIn = (): void => {
    const workspace = useWorkspaceStore.getState()
    const pane = findPaneContainingTab(workspace.root, agentChatTabId(session.id))
    if (pane) workspace.showAgentLauncher(pane.id)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: onFocus / onBlur only observe bubbled focus to track approval prompts; the root is not itself interactive
    <div
      ref={rootRef}
      onFocus={onFocus}
      onBlur={onBlur}
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
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <Spinner size={12} decorative />
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
        !isResumableStop &&
        !isOpeningHistory &&
        !isLaunchingSession &&
        !discoveredReopenContext &&
        (hasHistoryEntry || codexSignedOut) && (
          <div className="flex items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning">
            <span>{codexSignedOut ? CODEX_CLI_SIGNED_OUT_MESSAGE : 'This chat stopped.'}</span>
            <button
              type="button"
              onClick={() => {
                if (codexSignedOut) {
                  openCodexSignIn()
                  return
                }
                resumeStoppedChat()
              }}
              className="inline-flex min-h-11 items-center rounded-md border border-warning/40 px-3 text-xs font-medium transition-colors hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 @[400px]:min-h-10"
            >
              {codexSignedOut ? 'Sign in' : 'Resume chat'}
            </button>
          </div>
        )}
      {showTransportOverlay && (
        <div
          className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded-full border border-border/60 bg-background/80 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <AgentConnectionLamp
            connected={false}
            reconnecting={!hostOffline}
            hostOffline={hostOffline}
            decorative
            size={8}
          />
          <span>{hostOffline ? 'Host offline' : 'Reconnecting…'}</span>
        </div>
      )}
      <ChatErrorNotice
        message={activeError}
        code={session.lastErrorCode}
        data={session.lastErrorData}
        onRetry={canOfferNoticeRetry ? handleRetry : undefined}
        retryLabel={
          !session.launchConfigId && (session.status === 'error' || session.status === 'closed')
            ? 'Resume chat'
            : 'Retry'
        }
        onDismiss={() => setDismissedError(session.lastError)}
      />
      <PlanPanel
        key={`plan-${session.id}`}
        entries={plan}
        defaultCollapsed={isMobileShell}
        forceCollapsed={compactDock}
      />
      <ChatMessageList
        items={timeline}
        sessionId={session.id}
        showRunningIndicator={showRunningIndicator}
        filePathContext={filePathContext}
        onEditMessage={seedComposer}
        onRetry={canOfferRetry ? handleRetry : undefined}
      />
      {showPromptReconcile && promptCommand && session.activeTurn && (
        // AD-6: the host has not yet confirmed the last prompt (the connection
        // dropped before the reply). Not an error — the same turn id is resent, and
        // the user can re-check it (same id; a new send only after a rejection).
        // In flow above the composer so it never covers the transcript.
        <div className={`${CHAT_GUTTER_X} pb-1 pt-2`}>
          <div className="mx-auto w-full max-w-3xl">
            <PromptReconcileNotice
              state={promptCommand}
              onRecheck={() => recheckPromptCommand(sessionId)}
            />
          </div>
        </div>
      )}
      {/* Browser-automation consent (CAP-5): the in-chat card is the fallback
          surface for any non-browser focus — mounted once so it shows both
          next to the composer and while a structured question is pending.
          The gate covers every suppression term so the strip, remote clients,
          and closed sessions never leave an empty gutter block. */}
      {showBrowserConsentCard && (
        <div className={`${CHAT_GUTTER_X} pb-2 pt-3`}>
          <div className="mx-auto w-full max-w-3xl">
            <BrowserConsentCard consent={pendingBrowserConsent} />
          </div>
        </div>
      )}
      {/* Any pending agent prompt morphs the composer into the question
          dialog — the composer, changed-files strip, and queued prompts all
          hide until the prompt resolves. */}
      {!isClosed && (pendingElicitation || pendingQuestion) ? (
        <div ref={dockRef} data-chat-dock="true" className={dockClassName}>
          {pendingElicitation && (
            <ElicitationPrompt
              key={pendingElicitation.requestId}
              request={pendingElicitation}
              autoFocusHeading={isMobileShell && isVisible}
            />
          )}
          {pendingPermission && (
            <div className={`${CHAT_GUTTER_X} pb-2 pt-3`}>
              <div className="mx-auto w-full max-w-3xl">
                <PermissionPrompt
                  permission={pendingPermission}
                  embedded={false}
                  isVisible={isVisible}
                />
              </div>
            </div>
          )}
          {pendingQuestion && (
            <AskUserQuestion
              key={pendingQuestion.questionId}
              question={pendingQuestion}
              autoFocusFirstOption={isMobileShell && isVisible}
            />
          )}
        </div>
      ) : (
        <div ref={dockRef} data-chat-dock="true" className={dockClassName}>
          <ChatChangedFilesPanel
            cwd={session.cwd}
            toolCalls={toolCalls}
            forceCollapsed={compactDock}
            onOpenGitChanges={
              isMobileShell ? (opener) => openGitSheet(session.cwd, opener) : undefined
            }
          />
          {!isClosed && (
            <div className={CHAT_GUTTER_X}>
              <div className="mx-auto w-full max-w-3xl">
                <ClaudeLimitNotice sessionId={sessionId} />
              </div>
            </div>
          )}
          <ChatInputBar
            session={composerSession ?? session}
            projectRoot={skillsProjectRoot}
            busy={session.activeTurn}
            disabled={isClosed && !isResumableStop}
            controlsDisabled={isClosed}
            onDraftStart={isResumableStop ? startAutoResume : undefined}
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
          {/* Empty chat: starters under the composer. With the hero above
              (ChatEmptyState) both fill the free space, so the composer sits
              in the middle. Mobile keeps the composer at the bottom. */}
          {isEmptyChat && !isMobileShell ? (
            <div className="flex min-h-0 flex-1 flex-col items-center px-6">
              <ChatStarters onPick={seedComposer} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
