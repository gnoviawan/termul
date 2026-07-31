import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useOskViewport } from '@/hooks/use-osk-viewport'
import type { AvailableCommand, ContentBlock, PlanEntry, SessionId, ToolCall } from '@/lib/acp-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useAcpMessages, useAcpSession, useAcpStore, usePromptQueue } from '@/stores/acp-store'
import { isAgentDeadError } from '@/stores/prompt-queue-orchestration'
import { AgentConnectionLamp } from './AgentConnectionLamp'
import { ChatErrorNotice } from './ChatErrorNotice'
import { ChatInputBar } from './ChatInputBar'
import { ChatMessageList } from './ChatMessageList'
import { buildTimeline, consolidateThoughtGroups } from './chat-timeline'
import { PermissionDialog } from './PermissionDialog'
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
const EMPTY_PLAN: PlanEntry[] = []

function ChatRestorePreload(): React.JSX.Element {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 bg-background text-muted-foreground"
      role="status"
      aria-live="polite"
      aria-label="Restoring chat"
    >
      <div className="relative flex size-16 items-center justify-center">
        <div className="absolute inset-0 rounded-2xl bg-sky-500/15 blur-xl" aria-hidden="true" />
        <TermulMark
          size={52}
          className="relative animate-pulse text-foreground drop-shadow-[0_0_18px_rgba(56,189,248,0.28)] motion-reduce:animate-none"
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
  const messages = useAcpMessages(sessionId)
  const imageCapable = useAcpStore((s) =>
    session ? Boolean(s.agents[session.agentId]?.capabilities?.promptCapabilities?.image) : false
  )
  const embedCapable = useAcpStore((s) =>
    session
      ? Boolean(s.agents[session.agentId]?.capabilities?.promptCapabilities?.embeddedContext)
      : false
  )
  const commands = useAcpStore((s) => s.commands[sessionId] ?? EMPTY_COMMANDS)
  const toolCalls = useAcpStore((s) => s.toolCalls[sessionId] ?? EMPTY_TOOL_CALLS)
  const plan = useAcpStore((s) => s.plans[sessionId] ?? EMPTY_PLAN)
  // The oldest pending permission for THIS session (resolve one to reveal the next).
  const pendingPermission = useAcpStore(
    useShallow(
      (s) => Object.values(s.pendingPermissions).find((p) => p.sessionId === sessionId) ?? null
    )
  )
  const sendPrompt = useAcpStore((s) => s.sendPrompt)
  const sendPromptBlocks = useAcpStore((s) => s.sendPromptBlocks)
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)
  const removeQueuedPrompt = useAcpStore((s) => s.removeQueuedPrompt)
  const sendQueuedPromptNow = useAcpStore((s) => s.sendQueuedPromptNow)
  const retryCrashedSession = useAcpStore((s) => s.retryCrashedSession)
  const promptQueue = usePromptQueue(sessionId)
  const setConfigOption = useAcpStore((s) => s.setConfigOption)
  const setMode = useAcpStore((s) => s.setMode)
  const setModel = useAcpStore((s) => s.setModel)
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
        toast.error(`Failed to send queued message: ${String(err)}`)
      })
    },
    [sendQueuedPromptNow, sessionId]
  )

  const handleSend = useCallback(
    (text: string) => {
      void sendPrompt(sessionId, text).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error(`Failed to send: ${String(err)}`)
      })
    },
    [sendPrompt, sessionId]
  )

  const handleSendBlocks = useCallback(
    (blocks: ContentBlock[]) => {
      void sendPromptBlocks(sessionId, blocks).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error(`Failed to send: ${String(err)}`)
      })
    },
    [sendPromptBlocks, sessionId]
  )

  const handleCancel = useCallback(() => {
    void cancelPrompt(sessionId).catch((err) => {
      toast.error(`Failed to cancel: ${String(err)}`)
    })
  }, [cancelPrompt, sessionId])

  const handleSetConfig = useCallback(
    async (configId: string, valueId: string) => {
      try {
        await setConfigOption(sessionId, configId, valueId)
      } catch (err) {
        toast.error(`Failed to set option: ${String(err)}`)
        throw err
      }
    },
    [setConfigOption, sessionId]
  )

  const handleSetMode = useCallback(
    async (modeId: string) => {
      try {
        await setMode(sessionId, modeId)
      } catch (err) {
        toast.error(`Failed to set mode: ${String(err)}`)
        throw err
      }
    },
    [setMode, sessionId]
  )

  const handleSetModel = useCallback(
    async (modelId: string) => {
      try {
        await setModel(sessionId, modelId)
      } catch (err) {
        toast.error(`Failed to set model: ${String(err)}`)
        throw err
      }
    },
    [setModel, sessionId]
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
    if (!lastUserBlocks || !canRetryLastUserTurn) return
    setDismissedError(session?.lastError ?? null)
    // A crashed/disconnected chat can't re-send into the dead agent — restart
    // the agent + replay history first (user-initiated Retry; honors ADR-003's
    // no-silent-respawn: the crash is still surfaced, respawn is on click).
    if (session?.status === 'error' || session?.status === 'closed') {
      void retryCrashedSession(sessionId).catch((err) => {
        if (isAgentDeadError(err)) return
        toast.error(`Failed to retry: ${String(err)}`)
      })
      return
    }
    const hasStructuredBlocks = lastUserBlocks.some((b) => b.type !== 'text')
    const task = hasStructuredBlocks
      ? sendPromptBlocks(sessionId, lastUserBlocks)
      : sendPrompt(sessionId, lastUserText.trim())
    void task.catch((err) => {
      if (isAgentDeadError(err)) return
      toast.error(`Failed to send: ${String(err)}`)
    })
  }, [
    lastUserBlocks,
    canRetryLastUserTurn,
    lastUserText,
    sendPrompt,
    sendPromptBlocks,
    retryCrashedSession,
    sessionId,
    session?.status,
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
  const timeline = useMemo(
    () => consolidateThoughtGroups(buildTimeline(messages, toolCalls)),
    [messages, toolCalls]
  )
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
          <div className="max-w-md px-6 text-center">Failed to restore chat: {rehydrateError}</div>
          <Button type="button" variant="outline" size="sm" onClick={() => setRehydrateError(null)}>
            Retry
          </Button>
        </div>
      )
    }
    if (isOpeningHistory || hasHistoryEntry) return <ChatRestorePreload />
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No active chat for this pane.
      </div>
    )
  }

  const isClosed = session.status === 'closed'
  const retryDiscoveredReopen = discoveredReopenContext
    ? () => {
        void openDiscoveredSession(
          discoveredReopenContext.agentId,
          sessionId,
          discoveredReopenContext.cwd,
          discoveredReopenContext.projectId
        ).catch((err) => {
          toast.error(`Failed to open chat: ${String(err)}`)
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
      {(isLaunchingSession ||
        (session.status === 'initializing' && !session.agentId) ||
        (isLaunchingSession && session.activeTurn)) && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          Starting agent…
        </div>
      )}
      {isClosed && isOpeningHistory && !isLaunchingSession && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          Reconnecting to agent…
        </div>
      )}
      {isClosed &&
        !isOpeningHistory &&
        !isLaunchingSession &&
        discoveredReopenContext &&
        session.lastError && (
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            <span>Failed to restore agent chat.</span>
            <button
              type="button"
              onClick={retryDiscoveredReopen}
              className="rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-background/60"
            >
              Retry
            </button>
          </div>
        )}
      {isClosed &&
        !isOpeningHistory &&
        !isLaunchingSession &&
        hasHistoryEntry &&
        !discoveredReopenContext && (
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            <span>Chat disconnected.</span>
            <button
              type="button"
              onClick={() => {
                void openHistorySession(sessionId).catch((err) => {
                  toast.error(`Failed to reconnect chat: ${String(err)}`)
                })
              }}
              className="rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-background/60"
            >
              Reconnect
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
          <AgentConnectionLamp connected={false} reconnecting size={8} />
          <span>Reconnecting…</span>
        </div>
      )}
      <ChatErrorNotice
        message={activeError}
        onRetry={canRetryLastUserTurn && !session.activeTurn ? handleRetry : undefined}
        onDismiss={() => setDismissedError(session.lastError)}
      />
      <PlanPanel entries={plan} />
      <ChatMessageList
        items={timeline}
        sessionId={session.id}
        agentId={session.agentId}
        showRunningIndicator={showRunningIndicator}
        filePathContext={filePathContext}
        onEditMessage={seedComposer}
        onRetry={canRetryLastUserTurn && !session.activeTurn ? handleRetry : undefined}
      />
      <ChatInputBar
        session={session}
        busy={session.activeTurn}
        disabled={isClosed}
        imageCapable={imageCapable}
        embedCapable={embedCapable}
        onSend={handleSend}
        onSendBlocks={handleSendBlocks}
        onCancel={handleCancel}
        queue={promptQueue}
        onRemoveQueued={handleRemoveQueued}
        onSendQueuedNow={handleSendQueuedNow}
        commands={commands}
        configOptions={session.configOptions}
        modes={session.modes}
        onSetConfig={handleSetConfig}
        onSetMode={handleSetMode}
        onSetModel={handleSetModel}
        seedText={seed?.text}
        seedNonce={seed?.nonce}
      />
      {pendingPermission && !isClosed && <PermissionDialog permission={pendingPermission} />}
    </div>
  )
}
