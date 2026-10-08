/**
 * Prompt slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import { toast } from 'sonner'
import type { StateCreator } from 'zustand'
import {
  acpApi,
  type ContentBlock,
  type ElicitationField,
  type SessionId,
  type StopReason
} from '@/lib/acp-api'
import { getCachedSessionPayload, setCachedSessionPayload } from '@/lib/acp-history-persistence'
import { isTransientAcpTransportError } from '@/lib/acp-transport'
import { bumpTurnEndNotice } from '@/lib/agent-chat-notify'
import { logFrontendError } from '@/lib/log-api'
import { randomUUID } from '@/lib/uuid'
import {
  appendQueuedPrompt,
  isAgentDeadError,
  isPromptTurnInProgressError,
  type QueuedPrompt,
  sessionTurnBusy,
  waitForTurnClear
} from '../../prompt-queue-orchestration'
import {
  appendPlanSnapshot,
  cacheOptionsFromSession,
  configIdForAgentId,
  dropElicitationsForSession,
  dropPermissionsForSession,
  dropQuestionsForSession,
  dropRecordKey,
  finalizeStreaming,
  mergeAgentConfigOptions,
  newId,
  nextQueueId,
  noteForStopReason,
  recoverPromptToQueue,
  SWITCH_SPLICE_ID_PREFIX,
  writeAgentOptionsCache
} from '../helpers'
import { useAcpStore } from '../index'
import {
  acceptedServerPromptTurnIds,
  commitMessageCollectors,
  inFlightPromotions,
  isHistoryCoveredEvent,
  nextSeq,
  PROMOTE_SLOW_WARNING_MS,
  persistComposerOptions,
  persistSession,
  rejectCommitMessageCollector,
  rejectTerminalAssistCollector,
  terminalAssistCollectors
} from '../shared-state'
import type { AcpSession, AcpState, ChatMessage, TurnEndSetter } from '../types'
import { clampLiveToolCallFields, flushCoalescedSync } from './transcript'

/** Send the next queued prompt after the current turn closes. */
export function flushNextQueuedPrompt(set: TurnEndSetter, sessionId: SessionId): void {
  const state = useAcpStore.getState()
  if (state.suppressQueueFlush[sessionId]) return
  const session = state.sessions[sessionId]
  if (!session || session.status === 'closed' || sessionTurnBusy(session)) return

  const queue = state.promptQueues[sessionId] ?? []
  if (queue.length === 0) return

  const [next, ...rest] = queue
  set((s) => ({
    promptQueues: { ...s.promptQueues, [sessionId]: rest }
  }))

  void runPromptTurn(
    set,
    () => useAcpStore.getState(),
    sessionId,
    next.blocks,
    (s, turnId) => acpApi.sendPromptBlocks(s.agentId, sessionId, next.blocks, turnId),
    next,
    next.displayBlocks ? { displayBlocks: next.displayBlocks } : undefined
  ).catch((err) => {
    // Busy recovery is handled inside runPromptTurn (FIFO restore via queuedOrigin).
    if (isPromptTurnInProgressError(err)) return
    // Agent-dead rejections are surfaced by the crash/disconnect events.
    if (isAgentDeadError(err)) return
    toast.error(`Failed to send queued message: ${String(err)}`)
  })
}

/**
 * End the current turn after the macrotask queue drains so streamed
 * `acp:message_chunk` events delivered after `acp_send_prompt` / `acp:prompt_complete`
 * are still accepted. Idempotent when the turn is already closed.
 *
 * `expectedTurnId` guards against duplicate end signals (dispatch resolve +
 * `acp:prompt_complete` both schedule end) clearing a newer turn — e.g. a
 * queued prompt flushed immediately after the previous turn closed.
 *
 * When there is no turn id but `activeTurn` is still set (defensive activeTurn-only
 * state), clear the busy flags and flush the queue so send-now / completion can
 * make progress.
 */
function scheduleTurnEnd(
  set: TurnEndSetter,
  sessionId: SessionId,
  stopReason?: StopReason,
  expectedTurnId?: string | null
): void {
  const session = useAcpStore.getState().sessions[sessionId]
  const turnId = expectedTurnId ?? session?.openTurnId ?? null
  if (!turnId) {
    if (!session?.activeTurn) return
    setTimeout(() => {
      let closedTurn = false
      set((s) => {
        const current = s.sessions[sessionId]
        // Only clear activeTurn-only sessions; if an openTurnId appeared, leave it.
        if (!current?.activeTurn || current.openTurnId) return {}
        closedTurn = true
        const note = stopReason !== undefined ? noteForStopReason(stopReason) : null
        return {
          messages: finalizeStreaming(s.messages, sessionId),
          turnEndNotices: bumpTurnEndNotice(s.turnEndNotices ?? {}, sessionId, stopReason),
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...current,
              openTurnId: null,
              activeTurn: false,
              lastError: note ?? current.lastError
            }
          }
        }
      })
      if (closedTurn) {
        const state = useAcpStore.getState()
        if (state.sessions[sessionId] && state.sessionIndex.some((e) => e.id === sessionId)) {
          persistSession(state, sessionId, (entries) => set({ sessionIndex: entries }))
        }
        flushNextQueuedPrompt(set, sessionId)
      }
    }, 0)
    return
  }

  setTimeout(() => {
    let closedTurn = false
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current?.openTurnId || current.openTurnId !== turnId) return {}
      closedTurn = true
      const note = stopReason !== undefined ? noteForStopReason(stopReason) : null
      return {
        messages: finalizeStreaming(s.messages, sessionId),
        turnEndNotices: bumpTurnEndNotice(s.turnEndNotices ?? {}, sessionId, stopReason),
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...current,
            openTurnId: null,
            activeTurn: false,
            lastError: note ?? current.lastError
          }
        }
      }
    })
    // Re-mirror after the turn actually closed: chunks that lost the IPC race
    // and landed inside this deferred window are in memory but were missed by
    // the persist in `_onPromptComplete`. Guarded against deleted sessions so
    // the write can't resurrect a removed index entry.
    if (closedTurn) {
      const state = useAcpStore.getState()
      if (state.sessions[sessionId] && state.sessionIndex.some((e) => e.id === sessionId)) {
        persistSession(state, sessionId, (entries) => set({ sessionIndex: entries }))
      }
      flushNextQueuedPrompt(set, sessionId)
    }
  }, 0)
}

/**
 * Shared orchestration for a user-initiated prompt turn: stage the optimistic
 * user message, mark the turn active, persist, then dispatch to the agent and
 * schedule turn-end. On failure, finalize any streaming markers and record the
 * error. `sendPrompt` and `sendPromptBlocks` differ only in the blocks they
 * stage and which IPC they invoke — captured by `userBlocks` and `dispatch`.
 *
 * `queuedOrigin` marks a dequeue/send-now path: on `ACP_TURN_IN_PROGRESS` (or
 * if the session is still busy at stage time), the original queue item is
 * restored at the front with its existing id so FIFO order is preserved.
 */
export async function runPromptTurn(
  set: TurnEndSetter,
  get: () => AcpState,
  sessionId: SessionId,
  userBlocks: ContentBlock[],
  dispatch: (session: AcpSession, turnId: string) => Promise<StopReason>,
  queuedOrigin?: QueuedPrompt,
  options?: { skipUserAppend?: boolean; displayBlocks?: ContentBlock[] }
): Promise<void> {
  const session = get().sessions[sessionId]
  if (!session) throw new Error(`unknown session ${sessionId}`)
  // A history reopen keeps the record 'closed' until the load lands — a send
  // typed during that window must queue (the atomic gate below) rather than
  // throw, so it flushes onto the repointed live agent when the open ends.
  if (session.status === 'closed' && !get().openingHistoryIds[sessionId])
    throw new Error('session is closed')
  if (userBlocks.length === 0) throw new Error('prompt content must not be empty')

  // The optimistic user message stores the display blocks (token text) so the
  // timeline renders inline chips; the agent receives the wire blocks via
  // `dispatch`. When no display override is given, display == wire.
  const displayBlocks = options?.displayBlocks ?? userBlocks

  let enqueued = false
  let userMessage: ChatMessage | null = null
  let openTurnId = ''
  const previousOpenTurnId = session.openTurnId
  const skipUserAppend = Boolean(options?.skipUserAppend)
  // Mint the client turn-id HERE (not inside the transport) so the optimistic
  // user message below can share the same `turn:<turnId>` id as the server's
  // `user_prompt` echo → reliable dedup in `_onUserPrompt` regardless of block
  // differences (the bug: the echo rendered a second user bubble because the
  // optimistic id (`msg-<uuid>`) never matched the echo's `turn:<uuid>`).
  const turnId = randomUUID()

  // Atomically decide enqueue vs start so rapid sends cannot both reach the backend.
  set((s) => {
    const current = s.sessions[sessionId]
    if (!current || (current.status === 'closed' && !s.openingHistoryIds[sessionId])) return {}

    // Launch handoff already painted the user message + active turn; don't re-queue.
    // A mid-reopen (`openingHistoryIds`) session is busy too: until the open
    // repoints `agentId` at the resolved live agent, dispatching would hit the
    // old (possibly dead) agent with `unknown agent`. Queue here; the open's
    // finally flushes once agentId is repointed and the transcript installed.
    if ((sessionTurnBusy(current) || s.openingHistoryIds[sessionId]) && !skipUserAppend) {
      enqueued = true
      if (queuedOrigin) {
        return {
          promptQueues: {
            ...s.promptQueues,
            [sessionId]: [queuedOrigin, ...(s.promptQueues[sessionId] ?? [])]
          }
        }
      }
      return {
        promptQueues: appendQueuedPrompt(
          s.promptQueues,
          sessionId,
          userBlocks,
          nextQueueId,
          options?.displayBlocks
        )
      }
    }

    openTurnId = newId('turn')
    if (skipUserAppend) {
      // Reuse the trailing optimistic user message (the launch placeholder
      // or a seeded follow-up) instead of appending a new one — but RE-STAMP
      // its id to `turn:<turnId>`. The placeholder mints `msg-<uuid>`, so
      // without this re-stamp a display≠wire turn (e.g. skill chips: tokens
      // in the optimistic display, path-framed text in the server echo)
      // would fail `_onUserPrompt`'s `turn:<id>` dedup on BOTH checks (id
      // mismatch + block mismatch) and render a second user bubble from the
      // echo. The display blocks are preserved verbatim — only the id moves
      // to the namespace the server echo will cite.
      const list = s.messages[sessionId] ?? []
      let userIndex = -1
      for (let i = list.length - 1; i >= 0; i--) {
        // spec-agent-switch-live-merged-transcript: after the live splice the
        // new session's list ends with SPLICED pre-switch history — a
        // `switch-splice:` record is projected history, never this turn's
        // reusable optimistic draft bubble (rebranding one would hide the
        // draft and corrupt the copied transcript).
        if (list[i].role === 'user' && !list[i].id.startsWith(SWITCH_SPLICE_ID_PREFIX)) {
          userIndex = i
          break
        }
      }
      userMessage = userIndex >= 0 ? { ...list[userIndex], id: `turn:${turnId}` } : null
      if (!userMessage) {
        // An explicitly-empty display override (the summary-only switch
        // dispatch) appends NO user bubble: the caller said the turn has no
        // user-visible content, so the turn runs without an optimistic user
        // message (the server echo dedup matches on the empty trailing-user
        // absence too — the echo of a summary-only wire has no display to
        // render either).
        if (Array.isArray(options?.displayBlocks) && options.displayBlocks.length === 0) {
          return {
            sessions: {
              ...s.sessions,
              [sessionId]: { ...current, activeTurn: true, openTurnId, lastError: null }
            }
          }
        }
        userMessage = {
          id: `turn:${turnId}`,
          role: 'user',
          blocks: displayBlocks,
          streaming: false,
          timestamp: Date.now(),
          seq: nextSeq()
        }
        // Plan persistence: do NOT drop `plans[sessionId]` here. The ACP
        // spec's empty-entries rule (`_onPlanUpdate`) remains the sole
        // client-visible clear path; clearing on prompt-send wiped
        // in-progress plans between turns (spec: plan-persistence-sticky-snapshot).
        return {
          messages: {
            ...s.messages,
            [sessionId]: [...list, userMessage]
          },
          sessions: {
            ...s.sessions,
            [sessionId]: { ...current, activeTurn: true, openTurnId, lastError: null }
          }
        }
      }
      const rebrandedList = list.slice()
      rebrandedList[userIndex] = userMessage
      return {
        messages: {
          ...s.messages,
          [sessionId]: rebrandedList
        },
        sessions: {
          ...s.sessions,
          [sessionId]: { ...current, activeTurn: true, openTurnId, lastError: null }
        }
      }
    }

    userMessage = {
      id: `turn:${turnId}`,
      role: 'user',
      blocks: displayBlocks,
      streaming: false,
      timestamp: Date.now(),
      seq: nextSeq()
    }
    return {
      messages: {
        ...s.messages,
        [sessionId]: [...(s.messages[sessionId] ?? []), userMessage]
      },
      sessions: {
        ...s.sessions,
        [sessionId]: { ...current, activeTurn: true, openTurnId, lastError: null }
      }
    }
  })

  if (enqueued) return
  // `userMessage` is absent ONLY in the deliberate empty-display dispatch —
  // the turn still runs (the optimistic-bubble step was skipped, not failed).
  if (!openTurnId) throw new Error(`unknown session ${sessionId}`)

  persistSession(get(), sessionId, (entries) => set({ sessionIndex: entries }))
  try {
    // Command reply vs streamed chunks have no ordering guarantee; defer turn
    // end to a macrotask so chunk listeners run first. Idempotent with
    // `_onPromptComplete` (which also calls `scheduleTurnEnd`).
    const liveSession = get().sessions[sessionId]
    if (!liveSession) throw new Error(`unknown session ${sessionId}`)
    // Story 8: a claimed warm-pool session's backend promote must resolve
    // BEFORE the first prompt is dispatched — otherwise the `user_prompt`
    // would not persist (the session is still backend-ephemeral until the
    // promote lands). The optimistic paint above already happened; the
    // promotion promise never rejects.
    const pendingPromotion = inFlightPromotions.get(sessionId)
    if (pendingPromotion) {
      // Wait for the promotion to SETTLE — never dispatch while it is still
      // in flight. A timeout-raced dispatch would run the turn while the
      // session is still backend-ephemeral (the prompt path skips
      // `persist_accepted_prompt`, the completion path skips `flush_session`),
      // so a late successful promote would mint durable history missing the
      // first prompt and possibly its response. No local deadline is needed:
      // the transport guarantees settle — the WS request rejects on socket
      // close and times out on its own request budget, and the Tauri command
      // errors on a dead agent thread — so this await cannot hang. Degraded
      // (non-durable) dispatch is reserved for an ACTUALLY FAILED promotion,
      // which is already toasted + warn-logged at fire time; a settled success
      // has cleared the backend ephemeral mark before its reply resolves, so
      // the prompt persists normally. The timer below is observability only —
      // it logs a slow handoff, it never releases the wait.
      let promoteSlowTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        promoteSlowTimer = null
        console.warn('[acp] warm-pool promotion still in flight; holding the first prompt')
        void logFrontendError({
          level: 'warn',
          source: 'acp-store.warmPoolPromotion',
          message: `Warm-pool promotion for session ${sessionId} still in flight after ${PROMOTE_SLOW_WARNING_MS}ms; holding the first prompt until it settles`
        })
      }, PROMOTE_SLOW_WARNING_MS)
      // The promotion promise never rejects (a failed promote is handled at
      // fire time), so a bare await is safe.
      await pendingPromotion
      if (promoteSlowTimer) clearTimeout(promoteSlowTimer)
    }
    const stopReason = await dispatch(liveSession, turnId)
    // The dispatch settled — the accepted-turn marker served its purpose.
    acceptedServerPromptTurnIds.delete(turnId)
    scheduleTurnEnd(set, sessionId, stopReason, openTurnId)
  } catch (err) {
    if (isPromptTurnInProgressError(err)) {
      // The empty-display dispatch has no optimistic user message to strip;
      // recover the wire blocks into the queue under the turn id so the
      // summary-only handoff is not lost when the new session is busy.
      const recoverable: ChatMessage = userMessage ?? {
        id: `turn:${turnId}`,
        role: 'user',
        blocks: [],
        streaming: false,
        timestamp: Date.now(),
        seq: nextSeq()
      }
      recoverPromptToQueue(
        set,
        sessionId,
        recoverable,
        userBlocks,
        options?.displayBlocks,
        previousOpenTurnId,
        openTurnId,
        queuedOrigin
      )
      return
    }
    // Issue #846: a WS drop while the turn runs leaves the outcome UNKNOWN.
    // The prompt was accepted server-side iff the server's `user_prompt` echo
    // for this turn id already landed (the accept path persists it BEFORE
    // dispatching to the agent). When it did, the agent keeps running on the
    // server and the reconnect resubscribe replays the rest of the turn —
    // finalize the local turn-view as in-flight, NOT as a failed prompt the
    // Retry button would blindly re-send (re-sending runs side effects
    // twice). Keep `activeTurn`+`openTurnId` so the UI shows the running
    // state, drop the error banner, and let reconnect recovery own the rest.
    if (isTransientAcpTransportError(err) && acceptedServerPromptTurnIds.has(turnId)) {
      acceptedServerPromptTurnIds.delete(turnId)
      void logFrontendError({
        level: 'warn',
        source: 'acp-store.promptDrop',
        message: `Transport dropped mid-turn for session ${sessionId}; prompt turn ${turnId} was accepted server-side — resubscribing instead of re-sending`
      })
      // The transport's own reconnect machinery resubscribes with the last
      // seq; prompt_complete for this turn arrives via replay and closes the
      // turn through `_onPromptComplete`.
      return
    }
    acceptedServerPromptTurnIds.delete(turnId)
    // An agent-dead rejection ("agent thread dropped the reply" / "is no longer
    // running") means the driver tore down mid-turn; the `acp:agent_crashed` /
    // `acp:agent_disconnected` events already drive `status: 'error'` +
    // `lastError`. Don't clobber that crash message with the low-level IPC
    // string, and leave the turn finalized so callers can suppress the toast.
    const agentDead = isAgentDeadError(err)
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current) return { messages: finalizeStreaming(s.messages, sessionId) }
      return {
        messages: finalizeStreaming(s.messages, sessionId),
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...current,
            activeTurn: false,
            openTurnId: null,
            ...(agentDead ? {} : { lastError: String(err) })
          }
        }
      }
    })
    throw err
  }
}

type PromptSliceState = Pick<
  AcpState,
  | 'promptQueues'
  | 'turnEndNotices'
  | 'suppressQueueFlush'
  | 'pendingPermissions'
  | 'pendingQuestions'
  | 'pendingElicitations'
  | 'sendPrompt'
  | 'sendPromptBlocks'
  | 'cancelPrompt'
  | 'removeQueuedPrompt'
  | 'sendQueuedPromptNow'
  | 'setConfigOption'
  | 'setMode'
  | 'setModel'
  | 'respondPermission'
  | 'answerQuestion'
  | 'respondElicitation'
  | '_onPermissionRequest'
  | '_onQuestionRequest'
  | '_onElicitationRequest'
  | '_onPromptComplete'
>

export const createPromptSlice: StateCreator<AcpState, [], [], PromptSliceState> = (set, get) => ({
  pendingPermissions: {},
  pendingQuestions: {},
  pendingElicitations: {},
  promptQueues: {},
  turnEndNotices: {},
  suppressQueueFlush: {},

  sendPrompt: (sessionId, text) => {
    // Staged switch-on-send (CAP-1/CAP-4): an armed switch intercepts the
    // NEXT send — the composer's text becomes the pending draft carried into
    // the handoff instead of a normal turn on the old agent.
    const armed = get().sessions[sessionId]?.switching
    if (armed) {
      return get().switchAgent(sessionId, armed.toConfigId, {
        pendingText: text,
        wireBlocks: [{ type: 'text', text }],
        displayBlocks: [{ type: 'text', text }]
      })
    }
    return runPromptTurn(set, get, sessionId, [{ type: 'text', text }], (session, turnId) =>
      acpApi.sendPrompt(session.agentId, sessionId, text, turnId)
    )
  },

  sendPromptBlocks: (sessionId, blocks, options) => {
    // Staged switch-on-send (CAP-1/CAP-4): the composer already built the
    // wire/display pair — route them straight into the armed switch rather
    // than re-deriving the pending draft from the wire text.
    const armed = get().sessions[sessionId]?.switching
    if (armed) {
      return get().switchAgent(sessionId, armed.toConfigId, {
        wireBlocks: blocks,
        displayBlocks: options?.displayBlocks ?? blocks
      })
    }
    return runPromptTurn(
      set,
      get,
      sessionId,
      blocks,
      (session, turnId) => acpApi.sendPromptBlocks(session.agentId, sessionId, blocks, turnId),
      undefined,
      options
    )
  },

  cancelPrompt: async (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session?.activeTurn) return
    await acpApi.cancelPrompt(session.agentId, sessionId)
    // turn cleared by _onPromptComplete (cancelled) or by sendPrompt's resolution
  },

  removeQueuedPrompt: (sessionId, queueId) => {
    set((s) => ({
      promptQueues: {
        ...s.promptQueues,
        [sessionId]: (s.promptQueues[sessionId] ?? []).filter((item) => item.id !== queueId)
      }
    }))
  },

  sendQueuedPromptNow: async (sessionId, queueId) => {
    const queue = get().promptQueues[sessionId] ?? []
    const item = queue.find((q) => q.id === queueId)
    if (!item) throw new Error('queued prompt not found')

    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    if (session.status === 'closed') throw new Error('session is closed')

    set((s) => ({
      promptQueues: {
        ...s.promptQueues,
        [sessionId]: (s.promptQueues[sessionId] ?? []).filter((q) => q.id !== queueId)
      },
      suppressQueueFlush: { ...s.suppressQueueFlush, [sessionId]: true }
    }))

    try {
      if (sessionTurnBusy(session)) {
        await acpApi.cancelPrompt(session.agentId, sessionId)
        await waitForTurnClear(sessionId, get, useAcpStore.subscribe)
      }
      await runPromptTurn(
        set,
        get,
        sessionId,
        item.blocks,
        (s, turnId) =>
          acpApi.sendPromptBlocks(s.agentId, sessionId, item.blocks, turnId, item.displayBlocks),
        item,
        item.displayBlocks ? { displayBlocks: item.displayBlocks } : undefined
      )
    } catch (err) {
      set((s) => ({
        promptQueues: {
          ...s.promptQueues,
          [sessionId]: [item, ...(s.promptQueues[sessionId] ?? [])]
        }
      }))
      throw err
    } finally {
      set((s) => ({
        suppressQueueFlush: dropRecordKey(s.suppressQueueFlush, sessionId)
      }))
    }
  },

  setConfigOption: async (sessionId, configId, valueId) => {
    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    const response = await acpApi.setConfigOption(session.agentId, sessionId, configId, valueId)
    // Factory Droid acknowledges successful changes with `{}` (no snapshot).
    // Preserve the known option list and update only the selected value.
    // The response snapshot can also re-assert creation defaults for OTHER
    // options (stale echo) — `mergeAgentConfigOptions` preserves moved-off
    // values in that case; the option just set always takes the response.
    const prior = get().sessions[sessionId]
    const preservedEchoOptionIds: string[] = []
    const updated = mergeAgentConfigOptions(
      prior?.configOptions,
      response ??
        (prior?.configOptions ?? []).map((option) =>
          option.id === configId ? { ...option, currentValue: valueId } : option
        ),
      {
        optedConfigId: configId,
        creationValues: prior?.creationOptionDefaults?.configValues,
        onEchoPreserved: (optionId) => {
          if (!prior?.creationEchoLogged?.[optionId]) preservedEchoOptionIds.push(optionId)
        }
      }
    )
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current) return {}
      let creationEchoLogged = current.creationEchoLogged
      if (preservedEchoOptionIds.length > 0) {
        creationEchoLogged = { ...creationEchoLogged }
        for (const optionId of preservedEchoOptionIds) creationEchoLogged[optionId] = true
      }
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...current, configOptions: updated, creationEchoLogged }
        }
      }
    })
    for (const optionId of preservedEchoOptionIds) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.configOptionEchoPreserved',
        message: `set_config_option response for session ${sessionId} re-asserted the creation default on '${optionId}'; kept the session's current value`
      })
    }
    const agentConfigId = configIdForAgentId(get(), session.agentId)
    if (agentConfigId) {
      writeAgentOptionsCache(set, agentConfigId, { configOptions: updated })
      persistComposerOptions(
        agentConfigId,
        { configValues: { [configId]: typeof valueId === 'boolean' ? String(valueId) : valueId } },
        sessionId
      )
    }
  },

  setMode: async (sessionId, modeId) => {
    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    await acpApi.setMode(session.agentId, sessionId, modeId)
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current?.modes) return {}
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...current,
            modes: { ...current.modes, currentModeId: modeId }
          }
        }
      }
    })
    cacheOptionsFromSession(set, get, sessionId)
    const configId = configIdForAgentId(get(), session.agentId)
    if (configId) {
      persistComposerOptions(configId, { modeId }, sessionId)
    }
  },

  setModel: async (sessionId, modelId) => {
    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    await acpApi.setModel(session.agentId, sessionId, modelId)
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current) return {}
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...current,
            // The chat picker prefers the model-category config option over
            // the legacy `models` projection. Keep both in sync so applying a
            // launcher selection cannot leave the composer showing the
            // session/new default.
            models: current.models
              ? { ...current.models, currentModelId: modelId }
              : current.models,
            configOptions: current.configOptions.map((option) =>
              option.category === 'model' ? { ...option, currentValue: modelId } : option
            )
          }
        }
      }
    })
    cacheOptionsFromSession(set, get, sessionId)
    const configId = configIdForAgentId(get(), session.agentId)
    if (configId) {
      persistComposerOptions(configId, { modelId }, sessionId)
    }
  },

  respondPermission: async (requestId, optionId) => {
    const pending = get().pendingPermissions[requestId]
    if (!pending) return
    // Optimistically remove so a rapid double-click can't fire a second backend
    // call for the same request (which would error as 'unknown request').
    set((s) => {
      const pendingPermissions = { ...s.pendingPermissions }
      delete pendingPermissions[requestId]
      return { pendingPermissions }
    })
    try {
      await acpApi.respondPermission(pending.agentId, requestId, optionId)
    } catch (err) {
      // Restore the entry so the user can retry.
      set((s) => ({ pendingPermissions: { ...s.pendingPermissions, [requestId]: pending } }))
      throw err
    }
  },

  answerQuestion: async (questionId, values) => {
    const pending = get().pendingQuestions[questionId]
    if (!pending) return
    // Optimistically remove so a rapid double-click can't fire a second backend
    // call for the same question (which would error as 'unknown question request').
    set((s) => {
      const pendingQuestions = { ...s.pendingQuestions }
      delete pendingQuestions[questionId]
      return { pendingQuestions }
    })
    try {
      await acpApi.answerQuestion(pending.agentId, questionId, values)
    } catch (err) {
      // Restore the entry so the user can retry.
      set((s) => ({ pendingQuestions: { ...s.pendingQuestions, [questionId]: pending } }))
      throw err
    }
  },

  _onPermissionRequest: (e, eventSeq) => {
    // CAP-3 replay contract: a replayed request the payload already covered
    // must not re-surface a stale modal after reconnect.
    if (isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    const hadCommit = commitMessageCollectors.has(e.sessionId)
    const hadAssist = terminalAssistCollectors.has(e.sessionId)
    if (hadCommit) rejectCommitMessageCollector(e.sessionId, 'The ACP agent requested permission')
    if (hadAssist) rejectTerminalAssistCollector(e.sessionId, 'The ACP agent requested permission')
    if (hadCommit || hadAssist) return
    set((s) => {
      // Keep an existing pending request for this id; never silently drop it.
      if (s.pendingPermissions[e.requestId]) return {}
      return {
        pendingPermissions: {
          ...s.pendingPermissions,
          [e.requestId]: {
            requestId: e.requestId,
            agentId: e.agentId,
            sessionId: e.sessionId,
            options: e.options,
            // F-2 sibling: the pending request holds the same agent-sent
            // toolCall verbatim — bound it at ingest like the transcript so a
            // giant write-file diff cannot park unclamped in the modal queue.
            // A call dropped as un-storable (`null`, e.g. an oversized
            // toolCallId) still leaves the request answerable — `toolTitle`
            // renders a fallback for the missing card fields.
            toolCall: clampLiveToolCallFields(e.sessionId, e.toolCall) ?? null
          }
        }
      }
    })
  },

  respondElicitation: async (requestId, action, content) => {
    const pending = get().pendingElicitations[requestId]
    if (!pending) return
    set((s) => {
      const pendingElicitations = { ...s.pendingElicitations }
      delete pendingElicitations[requestId]
      return { pendingElicitations }
    })
    try {
      await acpApi.respondElicitation(pending.agentId, requestId, action, content)
    } catch (error) {
      set((s) => ({ pendingElicitations: { ...s.pendingElicitations, [requestId]: pending } }))
      void logFrontendError({
        level: 'warn',
        source: 'acp.respondElicitation',
        message: `Elicitation response failed for ${requestId}: ${error instanceof Error ? error.message : String(error)}`
      })
      throw error
    }
  },

  _onElicitationRequest: (e, eventSeq) => {
    if (e.sessionId && isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    const hadCommit = Boolean(e.sessionId) && commitMessageCollectors.has(e.sessionId)
    const hadAssist = Boolean(e.sessionId) && terminalAssistCollectors.has(e.sessionId)
    if (hadCommit) {
      rejectCommitMessageCollector(e.sessionId, 'The ACP agent requested more information')
    }
    if (hadAssist) {
      rejectTerminalAssistCollector(e.sessionId, 'The ACP agent requested more information')
    }
    if (hadCommit || hadAssist) return
    set((s) => {
      if (s.pendingElicitations[e.requestId]) return {}
      return {
        pendingElicitations: {
          ...s.pendingElicitations,
          [e.requestId]: {
            requestId: e.requestId,
            agentId: e.agentId,
            sessionId: e.sessionId,
            mode: e.mode,
            message: e.message,
            url: e.url,
            // GH-935: normalize options for host/renderer version skew — an
            // older host emits `options: string[]`; the current contract is
            // `{value,label,description?}[]`.
            fields: (e.fields ?? []).map((field) => ({
              ...field,
              options: ((field.options ?? []) as unknown[]).map((option) =>
                typeof option === 'string' ? { value: option, label: option } : option
              ) as ElicitationField['options']
            })),
            // GH-935: free-text "Other" affordance flag from the request
            // `_meta` — rendered per-question by the prompt UI.
            allowOther: e.allowOther
          }
        }
      }
    })
  },

  _onQuestionRequest: (e, eventSeq) => {
    // CAP-3 replay contract: same stale-modal guard as permission requests.
    if (isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    const hadCommit = commitMessageCollectors.has(e.sessionId)
    const hadAssist = terminalAssistCollectors.has(e.sessionId)
    if (hadCommit)
      rejectCommitMessageCollector(e.sessionId, 'The ACP agent asked an interactive question')
    if (hadAssist)
      rejectTerminalAssistCollector(e.sessionId, 'The ACP agent asked an interactive question')
    if (hadCommit || hadAssist) return
    set((s) => {
      // Keep an existing pending question for this id; never silently drop it.
      if (s.pendingQuestions[e.questionId]) return {}
      return {
        pendingQuestions: {
          ...s.pendingQuestions,
          [e.questionId]: {
            questionId: e.questionId,
            agentId: e.agentId,
            sessionId: e.sessionId,
            question: e.question,
            options: e.options
          }
        }
      }
    })
  },

  _onPromptComplete: (e, eventSeq) => {
    // CAP-3 replay contract: drop a replayed turn-end the installed payload
    // already covers — re-running it would re-stamp `lastError` stop-reason
    // notes and re-finalize restored messages on a reopened chat.
    if (isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    const commitCollector = commitMessageCollectors.get(e.sessionId)
    if (commitCollector) {
      commitCollector.complete(e.stopReason)
      return
    }
    const assistCollector = terminalAssistCollectors.get(e.sessionId)
    if (assistCollector) {
      assistCollector.complete(e.stopReason)
      return
    }
    // Flush any coalesced streaming updates so the final transcript is
    // consistent before the turn status flips.
    flushCoalescedSync()
    set((s) => {
      // Snapshot the live plan onto the just-finished assistant message's
      // `blocks` BEFORE `finalizeStreaming` so historical turns retain their
      // plan-of-record (the fence is the rehydrate source of truth). The
      // append is a pure data op; `finalizeStreaming` only flips the
      // `streaming` flag, so the fence survives the finalize pass.
      let withSnapshot = s.messages
      try {
        withSnapshot = appendPlanSnapshot(s.messages, e.sessionId, s.plans[e.sessionId])
      } catch (error) {
        // Impossible in practice (pure JS over a PlanEntry[]), but a bad
        // entry could throw inside JSON.stringify. Log + continue turn-end
        // without blocking; the live sticky plan still covers the turn.
        void logFrontendError({
          level: 'warn',
          source: 'planSnapshot',
          message: `Failed to snapshot plan for ${e.sessionId}: ${String(error)}`
        })
      }
      const messages = finalizeStreaming(withSnapshot, e.sessionId)
      const session = s.sessions[e.sessionId]
      // A finished turn abandons any unanswered permission for this session;
      // the backend resolves it 'cancelled', so clear the stale store entry too.
      const pendingPermissions = dropPermissionsForSession(s.pendingPermissions, e.sessionId)
      const pendingQuestions = dropQuestionsForSession(s.pendingQuestions, e.sessionId)
      const pendingElicitations = dropElicitationsForSession(
        s.pendingElicitations ?? {},
        e.sessionId
      )
      if (!session) return { messages, pendingPermissions, pendingQuestions, pendingElicitations }
      const note = noteForStopReason(e.stopReason)
      return {
        messages,
        pendingPermissions,
        pendingQuestions,
        pendingElicitations,
        sessions: {
          ...s.sessions,
          [e.sessionId]: {
            ...session,
            lastError: note ?? session.lastError
          }
        }
      }
    })
    // Update the in-memory payload cache so a same-session rehydrate (switching
    // away and back, or any path that re-runs `loadSessionPayload`) finds the
    // fence. Since CAP-2 host-owned history, `persistSession` only updates the
    // session-index projection — the durable message wire shape is owned by the
    // Rust host, and the renderer's `messages` is a projection. Without this
    // cache update, the snapshot fence would be lost the moment the live
    // projection is re-fetched. Cross-restart durability requires a host-side
    // synthetic record (renegotiate the spec's "Never: no Rust-side persistence"
    // rule if needed).
    //
    // Only update the specific assistant message in the cache — the live window
    // (`get().messages[sessionId]`) may be trimmed (MAX_LIVE_WINDOW_MESSAGES),
    // so replacing the entire cached messages array with the live window would
    // drop older messages and break `loadOlderMessages`.
    const cachedPayload = getCachedSessionPayload(e.sessionId)
    if (cachedPayload) {
      const liveMessages = get().messages[e.sessionId]
      if (liveMessages) {
        // Find the last assistant message in the live window (the snapshot target).
        let lastAgentIdx = -1
        for (let i = liveMessages.length - 1; i >= 0; i--) {
          if (liveMessages[i].role === 'agent') {
            lastAgentIdx = i
            break
          }
        }
        if (lastAgentIdx >= 0) {
          const liveAgent = liveMessages[lastAgentIdx]
          // Find the corresponding message in the cached payload by id and
          // update only its blocks — preserve all other cached messages.
          const cachedIdx = cachedPayload.messages.findIndex((m) => m.id === liveAgent.id)
          if (cachedIdx >= 0 && cachedPayload.messages[cachedIdx].blocks !== liveAgent.blocks) {
            const updatedCachedMessages = [...cachedPayload.messages]
            updatedCachedMessages[cachedIdx] = liveAgent
            setCachedSessionPayload(e.sessionId, {
              ...cachedPayload,
              messages: updatedCachedMessages
            })
          }
        }
      }
    }
    // Mirror the finished turn (including the agent's reply) to disk. Without
    // this, only user sends persist and a restart loses the last reply. Skip
    // sessions no longer in the index — persisting would resurrect a chat the
    // user deleted while the turn was in flight.
    if (
      get().sessions[e.sessionId] &&
      get().sessionIndex.some((entry) => entry.id === e.sessionId)
    ) {
      persistSession(get(), e.sessionId, (entries) => set({ sessionIndex: entries }))
    }
    scheduleTurnEnd(set, e.sessionId, e.stopReason, get().sessions[e.sessionId]?.openTurnId ?? null)
  }
})
