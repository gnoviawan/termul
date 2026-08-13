/**
 * Prompt-queue helpers for ACP chat.
 *
 * Owns FIFO queue mutations, turn-busy checks, and the stable
 * `ACP_TURN_IN_PROGRESS` error contract shared with Rust `acp_send_prompt`.
 */

import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import type { ContentBlock, SessionId } from '@/lib/acp-api'
import { AcpTransportError } from '@/lib/acp-transport'

/** Stable code from Rust when `acp_send_prompt` rejects a concurrent turn. */
export const ACP_TURN_IN_PROGRESS_CODE = 'ACP_TURN_IN_PROGRESS'

/** Default budget for waiting on turn clear after cancel (send-now path). */
export const TURN_CLEAR_TIMEOUT_MS = 5000

/** A user prompt waiting to send after the current turn finishes. */
export interface QueuedPrompt {
  id: string
  /** Wire blocks dispatched to the agent (path-framed skill text). */
  blocks: ContentBlock[]
  createdAt: number
  /**
   * Display blocks stored in the optimistic user message when this queue item
   * flushes (token text → inline chips in the timeline). When omitted, the wire
   * blocks are used for display (display == wire). Preserved across enqueue +
   * recover so the queue preview and the flushed optimistic message keep chips
   * while the dispatch still sends the wire.
   */
  displayBlocks?: ContentBlock[]
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
  // Two surfaces report "a prompt turn is already in progress"; both must trigger
  // `runPromptTurn`'s `recoverPromptToQueue` recovery (parity across desktop/web):
  //  • Desktop/IPC: `acp_send_prompt` rejects with `Error('ACP_TURN_IN_PROGRESS: …')`.
  //  • Web/WS: the relay maps the turn-busy condition to `WsErrorCode::RateLimited` via
  //    `map_prompt_error_code` (preserving the `ACP_TURN_IN_PROGRESS: …` message) AND via
  //    the pre-flight `TurnClaim::DuplicateInFlight | Busy` branch (message
  //    "a prompt turn is already in progress"). Both surface as
  //    `AcpTransportError(WS_ERROR_CODES.RATE_LIMITED, …)`.
  // The string branch covers IPC + the WS `map_prompt_error_code` form (message keeps the
  // code prefix); the instanceof branch covers the WS turn-claim form (different message).
  return (
    String(err).includes(ACP_TURN_IN_PROGRESS_CODE) ||
    (err instanceof AcpTransportError && err.code === WS_ERROR_CODES.RATE_LIMITED)
  )
}

/**
 * Errors from Rust `send_command` when the agent driver thread is gone or
 * tore down mid-request (agent subprocess crashed/exited mid-turn). These are
 * already surfaced to the UI by the `acp:agent_crashed` / `acp:agent_disconnected`
 * events (which set `status: 'error'` + `lastError`), so the generic
 * `send_prompt` rejection must NOT also fire a redundant toast or clobber the
 * crash event's `lastError`.
 */
const AGENT_DEAD_MARKERS = [
  'agent thread is no longer running',
  'agent thread dropped the reply'
] as const

export function isAgentDeadError(err: unknown): boolean {
  const message = String(err)
  return AGENT_DEAD_MARKERS.some((marker) => message.includes(marker))
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
  createId: () => string,
  displayBlocks?: ContentBlock[]
): PromptQueueMap {
  const item: QueuedPrompt = {
    id: createId(),
    blocks,
    createdAt: Date.now(),
    ...(displayBlocks ? { displayBlocks } : {})
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
  /** Display blocks to preserve on the re-queued item (token text → chips). */
  displayBlocks?: ContentBlock[]
  previousOpenTurnId: string | null
  attemptedTurnId: string
  createQueueId: () => string
  /** When set, restore this exact queue item at the front (FIFO) instead of appending a new id. */
  queuedOrigin?: QueuedPrompt
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
  const {
    sessionId,
    userMessage,
    blocks,
    displayBlocks,
    previousOpenTurnId,
    attemptedTurnId,
    createQueueId,
    queuedOrigin
  } = args
  const session = state.sessions[sessionId]
  const list = state.messages[sessionId] ?? []
  const restoredOpenTurnId =
    session?.openTurnId === attemptedTurnId ? previousOpenTurnId : (session?.openTurnId ?? null)

  const promptQueues = queuedOrigin
    ? {
        ...state.promptQueues,
        [sessionId]: [queuedOrigin, ...(state.promptQueues[sessionId] ?? [])]
      }
    : appendQueuedPrompt(state.promptQueues, sessionId, blocks, createQueueId, displayBlocks)

  return {
    messages: {
      ...state.messages,
      [sessionId]: list.filter((m) => m.id !== userMessage.id)
    },
    promptQueues,
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
  sessions: Record<SessionId, TurnBusySession | undefined>
}

type TurnClearSubscribe = (
  listener: (
    state: { sessions: Record<SessionId, TurnBusySession | undefined> },
    prevState: { sessions: Record<SessionId, TurnBusySession | undefined> }
  ) => void
) => () => void

/**
 * Resolve when the session is no longer turn-busy (`openTurnId` and `activeTurn`
 * both clear), or reject on timeout. Uses store subscription instead of a
 * busy-poll loop.
 */
export function waitForTurnClear(
  sessionId: SessionId,
  get: TurnClearGet,
  subscribe: TurnClearSubscribe,
  timeoutMs = TURN_CLEAR_TIMEOUT_MS
): Promise<void> {
  if (!sessionTurnBusy(get().sessions[sessionId])) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('timed out waiting for turn to clear'))
    }, timeoutMs)

    const unsub = subscribe((state, prev) => {
      const wasBusy = sessionTurnBusy(prev.sessions[sessionId])
      const isBusy = sessionTurnBusy(state.sessions[sessionId])
      if (wasBusy && !isBusy) {
        clearTimeout(timer)
        unsub()
        resolve()
      }
    })

    // Cover the race where the turn cleared between the initial check and subscribe.
    if (!sessionTurnBusy(get().sessions[sessionId])) {
      clearTimeout(timer)
      unsub()
      resolve()
    }
  })
}
