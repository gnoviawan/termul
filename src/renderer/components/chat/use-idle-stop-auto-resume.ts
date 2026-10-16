import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { SessionId } from '@/lib/acp-api'
import { CODEX_CLI_SIGNED_OUT_MESSAGE } from '@/lib/agents/codex-cli-auth'
import { logFrontendError } from '@/lib/log-api'
import type { AcpSession } from '@/stores/acp-store'
import { isResumeFailureError } from '@/stores/acp-store/helpers'

/** Toast shown once when an automatic resume fails with a message still queued. */
export const AUTO_RESUME_FAILED_QUEUED_TOAST =
  'Could not resume this chat. Your message is still queued — use Resume chat.'

/**
 * Reason recorded (as `Resume failed: <reason>`) when the automatic resume
 * settles without reconnecting and the store wrote no resume error itself.
 */
export const AUTO_RESUME_FAILED_REASON = 'could not reconnect to the agent'

const LOG_SOURCE = 'AgentChatPanel.idleStopAutoResume'

interface AutoResumeAttempt {
  sessionId: SessionId
  /** Per-attempt token: a settle from an earlier attempt is ignored. */
  token: number
  phase: 'running' | 'failed'
  /** The open was seen in flight (`openingHistoryIds`) or its promise settled. */
  openSeen: boolean
  /** Failed while the store still held the restore mark from this attempt. */
  restoreTail: boolean
}

interface UseIdleStopAutoResumeArgs {
  sessionId: SessionId
  session: AcpSession | null | undefined
  hasHistoryEntry: boolean
  hasDiscoveredReopenContext: boolean
  isOpeningHistory: boolean
  isRestoringChat: boolean
  isLaunchingSession: boolean
  /** Prompts queued for this session (drives the failure toast). */
  queuedCount: number
  openHistorySession: (id: SessionId) => Promise<void>
  /** Store action recording a resume failure on a `closed` session. */
  markResumeFailed: (id: SessionId, reason: string) => void
}

interface IdleStopAutoResume {
  /**
   * The chat stopped cleanly (`closed`, has a history entry, no discovered
   * reopen context, not Codex signed-out, `lastError` is not a resume
   * failure) and its one automatic resume has not failed. The composer stays
   * enabled and the "This chat stopped." bar / "Session closed" pill hide.
   */
  isResumableStop: boolean
  /**
   * An automatic resume is under way for this session. The panel keeps the
   * composer (and the draft being typed) mounted instead of swapping in the
   * full-panel restore preload.
   */
  autoResumeActive: boolean
  /**
   * Start the automatic resume (first keystroke into an empty draft, or a
   * send). One automatic attempt per stop; never on view alone.
   */
  startAutoResume: () => void
}

/**
 * Seamless resume of a chat the host idle reaper stopped (#837). The resume
 * starts on the user's first keystroke or send through `openHistorySession`,
 * whose synchronous `openingHistoryIds` mark makes `runPromptTurn` queue a
 * send until the agent is back.
 *
 * Failure is derived from store state: the attempt is running, its open was
 * seen in flight, the open is no longer in flight and the session is still not
 * `active`. The manual "Resume chat" UI then returns (no automatic retry) and,
 * when the store wrote no resume error itself, a `Resume failed: …` lastError
 * is recorded so Attention ("Needs you") and a remount agree. The
 * attempt resets only once the session is `active` AND the restore mark has
 * cleared, so the preload bypass holds through the whole auto-started restore.
 */
export function useIdleStopAutoResume({
  sessionId,
  session,
  hasHistoryEntry,
  hasDiscoveredReopenContext,
  isOpeningHistory,
  isRestoringChat,
  isLaunchingSession,
  queuedCount,
  openHistorySession,
  markResumeFailed
}: UseIdleStopAutoResumeArgs): IdleStopAutoResume {
  const [attempt, setAttempt] = useState<AutoResumeAttempt | null>(null)
  // Mirror of `attempt` for callbacks only (never read during render), so two
  // calls in one tick (keystroke then send) start one attempt.
  const attemptRef = useRef<AutoResumeAttempt | null>(null)
  const nextTokenRef = useRef(0)
  const commit = useCallback((next: AutoResumeAttempt | null) => {
    attemptRef.current = next
    setAttempt(next)
  }, [])

  const status = session?.status
  const lastError = session?.lastError ?? null
  const current = attempt?.sessionId === sessionId ? attempt : null
  const derivedFailed =
    current?.phase === 'running' && current.openSeen && !isOpeningHistory && status !== 'active'
  const autoResumeFailed = current?.phase === 'failed' || derivedFailed
  const isResumableStop =
    session != null &&
    status === 'closed' &&
    hasHistoryEntry &&
    !hasDiscoveredReopenContext &&
    !isLaunchingSession &&
    lastError !== CODEX_CLI_SIGNED_OUT_MESSAGE &&
    !isResumeFailureError(lastError) &&
    !autoResumeFailed
  // A failed attempt keeps the bypass only for the tail of its own restore
  // mark (the store holds it ≥400 ms); a manual Resume chat after that shows
  // the normal preload.
  const autoResumeActive =
    current != null &&
    (!autoResumeFailed || (isRestoringChat && (current.phase === 'running' || current.restoreTail)))

  useEffect(() => {
    const live = attempt
    if (!live) return
    // A different chat now owns this panel, or the resume landed and its
    // restore mark cleared: the stop is over.
    if (live.sessionId !== sessionId || (status === 'active' && !isRestoringChat)) {
      commit(null)
      return
    }
    if (live.phase === 'running') {
      if (!live.openSeen) {
        if (isOpeningHistory) commit({ ...live, openSeen: true })
        return
      }
      if (isOpeningHistory || status === 'active') return
      commit({ ...live, phase: 'failed', restoreTail: isRestoringChat })
      const storeRecorded = isResumeFailureError(lastError)
      // Record the failure on the session (store-side guard: closed only,
      // never over an existing resume failure) so Attention and remounts see it.
      if (!storeRecorded) markResumeFailed(sessionId, AUTO_RESUME_FAILED_REASON)
      void logFrontendError({
        level: 'warn',
        source: LOG_SOURCE,
        message: `Automatic resume of stopped chat ${sessionId} did not reconnect (${
          storeRecorded ? 'resume error' : 'no live agent'
        }; ${queuedCount} queued); manual Resume chat offered`
      })
      if (queuedCount > 0) toast.error(AUTO_RESUME_FAILED_QUEUED_TOAST)
      return
    }
    if (live.restoreTail && !isRestoringChat) commit({ ...live, restoreTail: false })
  }, [
    attempt,
    sessionId,
    status,
    isOpeningHistory,
    isRestoringChat,
    lastError,
    queuedCount,
    markResumeFailed,
    commit
  ])

  const startAutoResume = useCallback(() => {
    if (!isResumableStop) return
    // One automatic attempt per stop.
    if (attemptRef.current?.sessionId === sessionId) return
    const token = ++nextTokenRef.current
    if (isOpeningHistory) {
      // An open is already in flight (e.g. a sidebar click): track it instead
      // of starting another.
      commit({ sessionId, token, phase: 'running', openSeen: true, restoreTail: false })
      void logFrontendError({
        level: 'info',
        source: LOG_SOURCE,
        message: `Stopped chat ${sessionId} already resuming; tracking the in-flight open`
      })
      return
    }
    commit({ sessionId, token, phase: 'running', openSeen: false, restoreTail: false })
    void logFrontendError({
      level: 'info',
      source: LOG_SOURCE,
      message: `Resuming stopped chat ${sessionId} on user input`
    })
    const settle = (): void => {
      const live = attemptRef.current
      if (!live || live.token !== token || live.openSeen) return
      commit({ ...live, openSeen: true })
    }
    // A rejection already lands in `lastError` (store) and keeps any queued
    // prompt queued; the effect above derives the failure.
    void openHistorySession(sessionId).then(settle, settle)
  }, [isResumableStop, isOpeningHistory, openHistorySession, sessionId, commit])

  return { isResumableStop, autoResumeActive, startAutoResume }
}
