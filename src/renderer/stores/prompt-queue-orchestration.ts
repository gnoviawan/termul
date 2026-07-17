/**
 * Prompt-queue helpers for ACP chat.
 *
 * Owns FIFO queue mutations, turn-busy checks, and the stable
 * `ACP_TURN_IN_PROGRESS` error contract shared with Rust `acp_send_prompt`.
 */

import type { ContentBlock, SessionId } from '@/lib/acp-api'

/** Stable code from Rust when `acp_send_prompt` rejects a concurrent turn. */
export const ACP_TURN_IN_PROGRESS_CODE = 'ACP_TURN_IN_PROGRESS'

/** Default budget for waiting on turn clear after cancel (send-now path). */
export const TURN_CLEAR_TIMEOUT_MS = 5000

/** A user prompt waiting to send after the current turn finishes. */
export interface QueuedPrompt {
  id: string
  blocks: ContentBlock[]
  createdAt: number
}

export interface TurnBusySession {
  openTurnId?: string | null
  activeTurn?: boolean
  status?: string
}

export interface RecoverableChatMessage {
  id: string
}

type PromptQueueMap = Record<SessionId, QueuedPrompt[]>

export function isPromptTurnInProgressError(err: unknown): boolean {
  return String(err).includes(ACP_TURN_IN_PROGRESS_CODE)
}

export function sessionTurnBusy(session: TurnBusySession | undefined): boolean {
  if (!session) return false
  return Boolean(session.openTurnId || session.activeTurn)
}

export function dropPromptQueueForSession(
  queues: PromptQueueMap,
  sessionId: SessionId
): PromptQueueMap {
  if (!(sessionId in queues)) return queues
  const next = { ...queues }
  delete next[sessionId]
  return next
}

export function appendQueuedPrompt(
  queues: PromptQueueMap,
  sessionId: SessionId,
  blocks: ContentBlock[],
  createId: () => string
): PromptQueueMap {
  const item: QueuedPrompt = {
    id: createId(),
    blocks,
    createdAt: Date.now()
  }
  return {
    ...queues,
    [sessionId]: [...(queues[sessionId] ?? []), item]
  }
}

export interface RecoverPromptArgs {
  sessionId: SessionId
  userMessage: RecoverableChatMessage
  blocks: ContentBlock[]
  previousOpenTurnId: string | null
  attemptedTurnId: string
  createQueueId: () => string
}

export interface RecoverPromptState {
  sessions: Record<SessionId, TurnBusySession & { lastError?: string | null }>
  messages: Record<SessionId, RecoverableChatMessage[]>
  promptQueues: PromptQueueMap
}

/** Build the store patch that moves a failed optimistic send back onto the queue. */
export function buildRecoverPromptToQueuePatch(
  state: RecoverPromptState,
  args: RecoverPromptArgs
): {
  messages: RecoverPromptState['messages']
  promptQueues: PromptQueueMap
  sessions: RecoverPromptState['sessions']
} {
  const { sessionId, userMessage, blocks, previousOpenTurnId, attemptedTurnId, createQueueId } =
    args
  const session = state.sessions[sessionId]
  const list = state.messages[sessionId] ?? []
  const restoredOpenTurnId =
    session?.openTurnId === attemptedTurnId ? previousOpenTurnId : (session?.openTurnId ?? null)

  return {
    messages: {
      ...state.messages,
      [sessionId]: list.filter((m) => m.id !== userMessage.id)
    },
    promptQueues: appendQueuedPrompt(state.promptQueues, sessionId, blocks, createQueueId),
    sessions: session
      ? {
          ...state.sessions,
          [sessionId]: {
            ...session,
            activeTurn: Boolean(restoredOpenTurnId),
            openTurnId: restoredOpenTurnId,
            lastError: null
          }
        }
      : state.sessions
  }
}

type TurnClearGet = () => {
  sessions: Record<SessionId, { openTurnId?: string | null } | undefined>
}

type TurnClearSubscribe = (
  listener: (
    state: { sessions: Record<SessionId, { openTurnId?: string | null } | undefined> },
    prevState: { sessions: Record<SessionId, { openTurnId?: string | null } | undefined> }
  ) => void
) => () => void

/**
 * Resolve when `openTurnId` clears for `sessionId`, or reject on timeout.
 * Uses store subscription instead of a busy-poll loop.
 */
export function waitForTurnClear(
  sessionId: SessionId,
  get: TurnClearGet,
  subscribe: TurnClearSubscribe,
  timeoutMs = TURN_CLEAR_TIMEOUT_MS
): Promise<void> {
  if (!get().sessions[sessionId]?.openTurnId) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('timed out waiting for turn to clear'))
    }, timeoutMs)

    const unsub = subscribe((state, prev) => {
      const wasOpen = Boolean(prev.sessions[sessionId]?.openTurnId)
      const isOpen = Boolean(state.sessions[sessionId]?.openTurnId)
      if (wasOpen && !isOpen) {
        clearTimeout(timer)
        unsub()
        resolve()
      }
    })

    // Cover the race where the turn cleared between the initial check and subscribe.
    if (!get().sessions[sessionId]?.openTurnId) {
      clearTimeout(timer)
      unsub()
      resolve()
    }
  })
}
