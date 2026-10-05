/**
 * Session slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import { toast } from 'sonner'
import type { StateCreator } from 'zustand'
import { loadAgentConfigs as loadAgentConfigsFromDisk } from '@/lib/acp-agents-persistence'
import {
  type AgentId,
  acpApi,
  type ContentBlock,
  type SessionId,
  type SessionInfo,
  type SessionReopenOutcome,
  type ToolCall
} from '@/lib/acp-api'
import {
  type AgentSwitchRecord,
  HISTORY_TAIL_MESSAGE_LIMIT,
  loadSessionIndex as loadSessionIndexFromDisk,
  loadSessionPayload,
  loadSessionPayloadTail,
  maxPayloadSeq,
  queueSessionPayloadDelete,
  restoredSwitches,
  restoredToolCalls,
  type SessionIndexEntry,
  type SessionPayload
} from '@/lib/acp-history-persistence'
import { selectMcpServersForAgent } from '@/lib/acp-mcp-persistence'
import { decideResume, resumeMissesSession } from '@/lib/acp-resume-policy'
import { getAcpTransport, isTransientAcpTransportError } from '@/lib/acp-transport'
import { classifySetupError } from '@/lib/agents/acp-spawn-errors'
import { deleteSessionTempFiles } from '@/lib/attachment-temp-cleanup'
import { logFrontendError } from '@/lib/log-api'
import { sanitizeDisplayText } from '@/lib/skill-tokens'
import { getTabFocusedSessionId, setTabFocusedSessionId } from '@/lib/web-tab-session'
import { useProjectStore } from '@/stores/project-store'
import {
  agentChatTabId,
  findPaneContainingTab,
  getAllLeafPanes,
  useWorkspaceStore
} from '@/stores/workspace-store'
import { pendingRestartVersionsAfterSpawn } from '../../agent-update-orchestration'
import { dropPromptQueueForSession } from '../../prompt-queue-orchestration'
import {
  cacheOptionsFromSession,
  captureReopenControlBaseline,
  configIdForAgentId,
  creationOptionDefaultsFrom,
  deriveOpenTurn,
  discoveryKey,
  dropHiddenToolCalls,
  dropPermissionsForSession,
  dropPreparedSlots,
  dropElicitationsForSession,
  dropQuestionsForSession,
  dropRecordKey,
  extractTermulPlanFenceJson,
  finalizeStreaming,
  mergeSessionIndexEntries,
  normalizeUserMessages,
  partitionTranscriptTurns,
  refreshHostOwnedIndex,
  resolveSwitchRedirect,
  SWITCH_SPLICE_ID_PREFIX,
  scanPlanFenceFromMessages,
  spliceSwitchTranscript,
  trimLiveToolCalls,
  withSessionActive,
  withSessionResumeError,
  writeAgentOptionsCache
} from '../helpers'
import { useAcpStore } from '../index'
import {
  isReopenTurnActiveError,
  noteDroppedLaunchPlaceholders,
  persistedTurnIsLive,
  selectLaunchRecoverySessions,
  takeDroppedLaunchPlaceholders
} from '../live-turn'
import {
  adoptHostOwnedAgent,
  beginSessionReopen,
  cancelledChatLaunches,
  commitMessageCollectors,
  ensureLiveAgent,
  ephemeralSessionIds,
  invalidateSessionReopen,
  isCurrentSessionReopen,
  liveSwitchSources,
  noteHistoryWatermark,
  persistSession,
  rebaseSeqCounter,
  rebaseUntitledCounter,
  rejectCommitMessageCollector,
  rejectTerminalAssistCollector,
  sessionReopenGenerations,
  terminalAssistCollectors
} from '../shared-state'
import {
  type AcpState,
  ChatLaunchCancelledError,
  type ChatMessage,
  type ReopenControlBaseline,
  type TurnEndSetter
} from '../types'
import { authenticatedAgents, evictAgentForTransport, withAuthRetry } from './agent'
import { runPromptTurn } from './prompt'
import { dropSessionTranscriptState, flushCoalescedSync, trimLiveWindow } from './transcript'

/**
 * Project a fetched payload into the installable transcript: hidden /
 * pre-first-user-prompt turns never render (CAP-3 replay contract) and the
 * authoritative history watermark is recorded for live-event seq-dedupe.
 *
 * `headAnchored` must be true only when the payload starts at the
 * conversation head (full payload, recovery snapshot, or a tail window that
 * holds the whole conversation). A windowed tail cuts at a turn-unaware
 * boundary, so its leading agent/thought bubbles usually belong to a visible
 * turn whose user prompt lies outside the window — filtering those as
 * "hidden" would silently truncate legitimate history.
 */
function installableTranscript(
  sessionId: SessionId,
  payload: SessionPayload,
  options: { headAnchored: boolean }
): { messages: ChatMessage[]; toolCalls: ToolCall[]; switches: AgentSwitchRecord[] } {
  noteHistoryWatermark(sessionId, payload)
  if (!options.headAnchored) {
    return {
      // A tail window can cut through a switch turn — boundary rows only
      // carry meaning for the turn partition, never render standalone.
      messages: normalizeUserMessages(payload.messages).filter((m) => m.handoffBoundary !== true),
      toolCalls: restoredToolCalls(payload),
      switches: restoredSwitches(payload)
    }
  }
  const { visible, hidden } = partitionTranscriptTurns(payload.messages)
  const messages =
    visible.length === payload.messages.length
      ? normalizeUserMessages(payload.messages)
      : normalizeUserMessages(visible)
  return {
    messages,
    toolCalls: dropHiddenToolCalls(restoredToolCalls(payload), messages, hidden),
    switches: restoredSwitches(payload)
  }
}

/**
 * End a session/load replay after the macrotask queue drains, so replayed
 * chunks that lose the IPC race against the `acp_load_session` response are
 * still accepted (mirrors `scheduleTurnEnd`). Idempotent when already cleared.
 *
 * After clearing `replaying`, projects a title that arrived during replay into
 * the session index: a `session_info_update` that landed while `replaying` was
 * truthy set `session.title` but was skipped by `persistSession` (which guards
 * on `session.replaying`). Now that replay has cleared, `persistSession` can
 * safely project the title so the sidebar converges without a partial
 * transcript projection.
 */
function scheduleReplayEnd(
  set: TurnEndSetter,
  sessionId: SessionId,
  reopenGeneration: number
): void {
  setTimeout(() => {
    if (!isCurrentSessionReopen(sessionId, reopenGeneration)) return
    let replayCleared = false
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current?.replaying) return {}
      replayCleared = true
      return {
        messages: finalizeStreaming(s.messages, sessionId),
        sessions: { ...s.sessions, [sessionId]: { ...current, replaying: null } }
      }
    })
    // Project a replay-time title into the index once replay has cleared.
    // Gate on `sessionIndex` membership like the other projection calls so an
    // un-promoted (ephemeral) session is never persisted by a replay event.
    if (replayCleared) {
      const state = useAcpStore.getState()
      const session = state.sessions[sessionId]
      if (session?.title && state.sessionIndex.some((e) => e.id === sessionId)) {
        persistSession(state, sessionId, (entries) => set({ sessionIndex: entries }))
      }
    }
  }, 0)
}

/**
 * Attach to a turn the host is still running (issue #882). `session/load` and
 * `session/resume` are rejected by the single-owner guard while that turn is
 * active; the second-client path is subscribe/replay (web) or accepting the
 * already-broadcast events (desktop, which has no `subscribeSession`).
 */
async function attachLiveTurn(
  set: TurnEndSetter,
  id: SessionId,
  agentId: AgentId,
  payload: SessionPayload,
  reopenGeneration: number
): Promise<void> {
  const cursor = Math.max(payload.metadata.lastSeq ?? 0, maxPayloadSeq(payload))
  const transport = getAcpTransport()
  transport.seedSessionCursor?.(id, cursor)
  let missing = false
  set((s) => {
    const session = s.sessions[id]
    if (!session) {
      missing = true
      return {}
    }
    return {
      sessions: {
        ...s.sessions,
        [id]: {
          ...session,
          agentId,
          status: 'active',
          lastError: null,
          replaying: 'streaming',
          activeTurn: true,
          openTurnId: session.openTurnId ?? 'turn:live'
        }
      }
    }
  })
  if (missing) throw new Error(`no session record to attach for ${id}`)
  void logFrontendError({
    level: 'info',
    source: 'acp.attachLiveTurn',
    message: `Attaching to live turn for session ${id} via subscribe/replay instead of resume/load`
  })
  try {
    if (transport.subscribeSession) {
      await transport.subscribeSession(id, cursor, true)
    }
    if (!isCurrentSessionReopen(id, reopenGeneration)) return
    set((s) => ({ sessions: withSessionActive(s.sessions, id) }))
    scheduleReplayEnd(set, id, reopenGeneration)
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'acp.attachLiveTurn',
      message: `Live-turn subscribe failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`
    })
    if (isCurrentSessionReopen(id, reopenGeneration)) {
      // A failed subscribe does not finish the host turn. Keep the spinner
      // and stop control, and surface the same resume-error banner load
      // and resume already use. Callers `return` only after this resolves.
      set((s) => ({ sessions: withSessionResumeError(s.sessions, id, err) }))
    }
    throw err
  }
}

/**
 * In-flight `openHistorySession` calls keyed by session id, so the sidebar
 * click and the restored-tab rehydrate (which can race at startup) coalesce
 * into one open instead of double-loading/spawning. Held outside reactive
 * state (promises don't belong in the store); the reactive
 * `openingHistoryIds` map mirrors membership for UI loading states.
 */
type InFlightHistoryOpen = {
  generation: number
  promise: Promise<void>
}

const inFlightHistoryOpens = new Map<SessionId, InFlightHistoryOpen>()

type InFlightDiscoveredOpen = {
  generation: number
  promise: Promise<void>
}

/** In-flight discovered-session reopens keyed by ACP session id. */
const inFlightDiscoveredOpens = new Map<SessionId, InFlightDiscoveredOpen>()

/**
 * Monotonic generation counter for `loadSessionIndex`. An older async index
 * request that resolves after a local session/title mutation must not replace
 * or downgrade the local projection; the stale response is discarded when the
 * generation is no longer current.
 */
let sessionIndexLoadGeneration = 0

let sessionIndexAppliedGeneration = 0

/** Sessions with an in-flight `retryCrashedSession` (re-launch + replay + re-send).
 * Dedupes concurrent Retry clicks so only one reopen+send runs per session. */
const inFlightCrashedRetries = new Set<SessionId>()

const RESTORE_PRELOAD_MIN_MS = 400

type RestorePreloadTracker = {
  token: number
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const restorePreloadTrackers = new Map<SessionId, RestorePreloadTracker>()

let nextRestorePreloadToken = 0

function beginRestorePreload(set: TurnEndSetter, sessionId: SessionId): number {
  const previous = restorePreloadTrackers.get(sessionId)
  if (previous?.timer) clearTimeout(previous.timer)

  const token = ++nextRestorePreloadToken
  restorePreloadTrackers.set(sessionId, { token, startedAt: Date.now(), timer: null })
  set((s) => ({ restoringChatIds: { ...s.restoringChatIds, [sessionId]: true } }))
  return token
}

function scheduleRestorePreloadEnd(set: TurnEndSetter, sessionId: SessionId, token: number): void {
  const tracker = restorePreloadTrackers.get(sessionId)
  if (!tracker || tracker.token !== token) return
  if (tracker.timer) clearTimeout(tracker.timer)

  const clearIfCurrent = (): void => {
    const current = restorePreloadTrackers.get(sessionId)
    if (!current || current.token !== token) return
    restorePreloadTrackers.delete(sessionId)
    set((s) => ({ restoringChatIds: dropRecordKey(s.restoringChatIds, sessionId) }))
  }
  const remaining = Math.max(0, RESTORE_PRELOAD_MIN_MS - (Date.now() - tracker.startedAt))
  if (remaining === 0) {
    clearIfCurrent()
    return
  }

  tracker.timer = setTimeout(clearIfCurrent, remaining)
}

function invalidateRestorePreload(set: TurnEndSetter, sessionId: SessionId): void {
  const tracker = restorePreloadTrackers.get(sessionId)
  if (tracker?.timer) clearTimeout(tracker.timer)
  restorePreloadTrackers.delete(sessionId)
  set((s) => ({ restoringChatIds: dropRecordKey(s.restoringChatIds, sessionId) }))
}

/** Test-only: clear module-level reopen tracking between tests. */
export function _resetInFlightHistoryOpensForTesting(): void {
  for (const sessionId of new Set([
    ...inFlightHistoryOpens.keys(),
    ...inFlightDiscoveredOpens.keys(),
    ...sessionReopenGenerations.keys()
  ])) {
    invalidateSessionReopen(sessionId)
  }
  inFlightHistoryOpens.clear()
  inFlightDiscoveredOpens.clear()
  for (const tracker of restorePreloadTrackers.values()) {
    if (tracker.timer) clearTimeout(tracker.timer)
  }
  restorePreloadTrackers.clear()
}

/** Test-only: reset the index load generation counter between tests. */
export function _resetSessionIndexLoadGenerationForTesting(): void {
  sessionIndexLoadGeneration = 0
  sessionIndexAppliedGeneration = 0
}

/**
 * spec-agent-switch-live-merged-transcript: re-splice the pre-switch band
 * after an in-session wholesale reinstall on a live switch TARGET (crash
 * retry, direct history open, resume install). The durable install replaces
 * `messages`/`toolCalls`/`agentSwitches` from the target's own payload, which
 * holds no pre-switch records — the switch marker lives on the SOURCE
 * session's log — so without this the merged view collapses to post-switch
 * turns for the rest of the app session.
 *
 * Only the source's DURABLE payload may re-splice: its ids share the reopen
 * chain's namespace (`switch-splice:<source>:<durable id>`), so a repeat
 * reinstall dedups via `seen` instead of doubling rows — live-slices ids
 * (`…:<live id>`) could never match a durable reinstall. Skips when the
 * source payload is unreadable: the projection was never persisted and the
 * durable-only view is the pre-feature baseline.
 */
async function respliceLiveSwitchTarget(
  set: TurnEndSetter,
  targetId: SessionId,
  stillCurrent?: () => boolean
): Promise<void> {
  const sourceId = liveSwitchSources.get(targetId)
  if (!sourceId) return
  const sourcePayload = await loadSessionPayload(sourceId).catch(() => null)
  if (!sourcePayload) {
    void logFrontendError({
      level: 'info',
      source: 'acp.switchAgent.splice',
      message: `Re-splice for switch target ${targetId} skipped: source session ${sourceId} payload unavailable`
    })
    return
  }
  if (stillCurrent && !stillCurrent()) return
  // loadSessionPayload returns the FULL payload — never a tail window — so the
  // transcript provably contains the conversation head. (The tail-window
  // heuristic used on the open path only applies to loadSessionPayloadTail.)
  const sourceInstalled = installableTranscript(sourceId, sourcePayload, { headAnchored: true })
  set((s) => {
    const merged = spliceSwitchTranscript(
      sourceId,
      sourceInstalled,
      s.messages[targetId] ?? [],
      s.toolCalls[targetId] ?? [],
      s.agentSwitches[targetId] ?? []
    )
    return {
      messages: { ...s.messages, [targetId]: trimLiveWindow(merged.messages, targetId) },
      toolCalls: { ...s.toolCalls, [targetId]: trimLiveToolCalls(merged.toolCalls) },
      agentSwitches: { ...s.agentSwitches, [targetId]: merged.switches }
    }
  })
}

/**
 * Story 3 (CAP-7): the shared switched-chat redirect for reopen/resume.
 *
 * Resolves the FULL marker chain (A→B→C: each session's last marker points at
 * its successor) BEFORE any splice or remap, so ONE target — the FINAL session
 * — receives the entire pre-switch transcript and ONE tab remap; intermediate
 * hops never steal the tab with a partial view. Then delegates the final
 * session's open to the public `openHistorySession` (full
 * ensure/capability-wait/decideResume machinery for the agent the
 * conversation ended with), splices the installed pre-switch transcript under
 * the final id (`spliceSwitchTranscript`), and remaps the tab (guarded — the
 * never-add-an-uninvited-tab rule; the final id owns the ACTIVE conversation).
 *
 * Returns true when the redirect was applied (the caller stops — its own
 * agent/resume work is superseded); false when the chain is unresolvable
 * (no markers / corrupt newSessionId / target already in flight — a marker
 * cycle must not await itself) or the target open failed (degrade to the
 * original path: the old transcript stays readable, no crash).
 */
async function redirectSwitchedReopen(
  set: TurnEndSetter,
  get: () => AcpState,
  id: SessionId,
  installed: { messages: ChatMessage[]; toolCalls: ToolCall[]; switches: AgentSwitchRecord[] },
  logSource: string,
  isOriginalStillCurrent?: () => boolean
): Promise<boolean> {
  const redirect = resolveSwitchRedirect(installed.switches)
  if (!redirect || redirect.newSessionId === id) return false
  // Walk the chain to the FINAL session (its markers carry no further
  // resolvable switch), COLLECTING each hop's (sessionId, transcript) pair.
  // Each hop's payload resolves the next marker; a hop whose payload is
  // missing stops the walk (its marker may be stale — e.g. a delete raced
  // the switch) and the last resolvable target wins. The collected hops
  // splice under the FINAL id so intermediate turns render too.
  //
  // Cycle semantics: a chain that continues into an ALREADY-IN-FLIGHT open
  // ends the walk (its own redirect may point back into this chain —
  // awaiting it could self-await). An in-flight FINAL target with a resolved
  // marker chain is NOT a loop — `openHistorySession` coalesces onto the
  // same in-flight promise below — so a concurrent restore/open of the
  // continuation still lands the redirect instead of reopening the stale
  // source standalone.
  const chain: Array<{
    sessionId: string
    messages: ChatMessage[]
    toolCalls: ToolCall[]
    switches: AgentSwitchRecord[]
  }> = [{ sessionId: id, ...installed }]
  let finalTarget = redirect.newSessionId
  // Whether the resolved final target's own marker chain could be read.
  // (false when its payload is missing OR the chain points onward into an
  // in-flight open — either means we can't prove the await below doesn't
  // self-await, so the redirect is declined.)
  let finalTargetChainResolved = false
  for (let hop = 0; hop < 8; hop++) {
    const hopPayload = await loadSessionPayload(finalTarget).catch(() => null)
    if (!hopPayload) break
    const next = resolveSwitchRedirect(restoredSwitches(hopPayload))
    if (next && next.newSessionId !== finalTarget && !inFlightHistoryOpens.has(next.newSessionId)) {
      // Intermediate hop: its transcript (pre-next-switch turns + its marker)
      // joins the splice chain.
      chain.push({
        sessionId: finalTarget,
        ...installableTranscript(finalTarget, hopPayload, {
          headAnchored: hopPayload.messages.length < HISTORY_TAIL_MESSAGE_LIMIT
        })
      })
      finalTarget = next.newSessionId
      continue
    }
    // The walk stopped here: payload present, no unowned continuation. The
    // chain is resolved UNLESS a further marker points into an in-flight
    // open (a cycle the await below can't safely join).
    finalTargetChainResolved = !(next && inFlightHistoryOpens.has(next.newSessionId))
    break
  }
  if (finalTargetChainResolved === false && inFlightHistoryOpens.has(finalTarget)) {
    void logFrontendError({
      level: 'warn',
      source: logSource,
      message: `Switch marker chain for session ${id} resolves to in-flight session ${finalTarget} whose own chain cannot be verified; reopening on the original session`
    })
    return false
  }
  try {
    // Delegate the FINAL session's open to the public action — it runs the
    // full ensure/capability-wait/decideResume machinery for the final agent.
    await get().openHistorySession(finalTarget)
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: logSource,
      message: `Redirected reopen of session ${id} to new session ${finalTarget} failed; reopening on the original session: ${String(err)}`
    })
    return false
  }
  if (isOriginalStillCurrent && !isOriginalStillCurrent()) return true
  // Splice the whole pre-switch chain under the FINAL id. Folds run NEWEST
  // hop → OLDEST (reverse): each fold prepends its hop before the
  // accumulated target, so the final order is oldest→newest. Idempotent on
  // repeat opens (already-present re-stamped ids are skipped).
  set((s) => {
    let messages = s.messages[finalTarget] ?? []
    let toolCalls = s.toolCalls[finalTarget] ?? []
    let switches = s.agentSwitches[finalTarget] ?? []
    // spec-agent-switch-live-merged-transcript (review fix): an ACTIVE
    // target short-circuited the delegated open above, so its band may still
    // carry the LIVE projection's records — re-stamped from the source's
    // live-slice ids (`switch-splice:<source>:<live id>`), never the
    // durable ids (`…:<durable id>`) this fold re-stamps. The exact-id
    // dedup below can never match them, so the durable band would append a
    // second copy of every pre-switch turn. Drop the projected band first:
    // the durable records that replace it are the authoritative same turns
    // (idempotent on repeat opens — a durable-id band dedups normally).
    // The target's OWN records (non-spliced) always survive.
    messages = messages.filter((m) => !m.id.startsWith(SWITCH_SPLICE_ID_PREFIX))
    toolCalls = toolCalls.filter((t) => !t.toolCallId.startsWith(SWITCH_SPLICE_ID_PREFIX))
    switches = switches.filter((sw) => !sw.id.startsWith(SWITCH_SPLICE_ID_PREFIX))
    for (const hopInstalled of [...chain].reverse()) {
      const spliced = spliceSwitchTranscript(
        hopInstalled.sessionId,
        hopInstalled,
        messages,
        toolCalls,
        switches
      )
      messages = spliced.messages
      toolCalls = spliced.toolCalls
      switches = spliced.switches
    }
    return {
      messages: {
        ...s.messages,
        [finalTarget]: trimLiveWindow(messages, finalTarget)
      },
      toolCalls: { ...s.toolCalls, [finalTarget]: trimLiveToolCalls(toolCalls) },
      agentSwitches: { ...s.agentSwitches, [finalTarget]: switches }
    }
  })
  // Remap the tab old → final in the same pane (guarded).
  const ws = useWorkspaceStore.getState()
  if (findPaneContainingTab(ws.root, agentChatTabId(id))) {
    ws.remapAgentChatSession(id, finalTarget)
  }
  return true
}

function mergeReopenOutcomeIfUnchanged(
  set: TurnEndSetter,
  sessionId: SessionId,
  reopenGeneration: number,
  baseline: ReopenControlBaseline | null,
  outcome: SessionReopenOutcome
): void {
  if (!baseline || !isCurrentSessionReopen(sessionId, reopenGeneration)) return
  set((s) => {
    const session = s.sessions[sessionId]
    if (!session || !isCurrentSessionReopen(sessionId, reopenGeneration)) return {}
    return {
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...session,
          modes:
            outcome.modes !== undefined && Object.is(session.modes, baseline.modes)
              ? outcome.modes
              : session.modes,
          models:
            outcome.models !== undefined && Object.is(session.models, baseline.models)
              ? outcome.models
              : session.models,
          configOptions:
            outcome.configOptions !== undefined &&
            Object.is(session.configOptions, baseline.configOptions)
              ? outcome.configOptions
              : session.configOptions
        }
      }
    }
  })
}

async function openHistorySessionInner(
  get: () => AcpState,
  set: TurnEndSetter,
  id: string,
  onTranscriptInstalled: () => void,
  reopenGeneration: number
): Promise<void> {
  // Snapshot before any await so a delete during cold-spawn / capability wait
  // is still detected as a mid-open transition (not "never indexed").
  const wasIndexed = get().sessionIndex.some((e) => e.id === id)
  const deletedMidOpen = (): boolean => wasIndexed && !get().sessionIndex.some((e) => e.id === id)
  const clearReplayIfPresent = (): void => {
    set((s) => {
      const session = s.sessions[id]
      if (!session?.replaying) return {}
      return { sessions: { ...s.sessions, [id]: { ...session, replaying: null } } }
    })
  }

  // Tail-first: fetch only the recent messages so the pane shows the
  // conversation immediately. The full payload loads lazily on scroll-up
  // via `loadOlderMessages`. Falls back to the full `loadSessionPayload`
  let headAnchored = false
  let payload = await loadSessionPayloadTail(id).catch((err) => {
    void logFrontendError({
      level: 'warn',
      source: 'acp.openHistorySession.tailFetch',
      message: `Tail fetch failed for session ${id}, falling back to full load: ${String(err)}`
    })
    return null
  })
  if (payload) {
    // A tail window shorter than the limit provably contains the conversation
    // head (the tail fetch under-read-fallback materializes the full log when
    // the window would be short); a full window may be an arbitrary cut.
    headAnchored = payload.messages.length < HISTORY_TAIL_MESSAGE_LIMIT
  } else {
    payload = await loadSessionPayload(id)
    headAnchored = true
  }
  if (!isCurrentSessionReopen(id, reopenGeneration)) return
  if (!payload) throw new Error(`no persisted history for ${id}`)
  const meta = payload.metadata

  // Rebase the process-wide seq counter so live events appended after the
  // restored transcript sort after it (nextSeq() returns > max restored seq).
  rebaseSeqCounter(maxPayloadSeq(payload))

  // Preserve controls already held by a cached closed session. Persisted
  // history does not contain them, and optional reopen fields may be omitted.
  const existingControls = captureReopenControlBaseline(get().sessions, id)

  // Register the session record + local transcript BEFORE any agent work, so
  // the pane shows the conversation instantly; the (possibly ~30s cold-spawn)
  // reconnect below then only upgrades the session in place. The persisted
  // `meta.agentId` may be a stale per-process UUID — remapped after spawn.
  // The fetched payload is authoritative: hidden greeting turns never render,
  // and the recorded watermark seq-dedupes live replayed events against it.
  const installed = installableTranscript(id, payload, { headAnchored })
  // Issue #838: a trailing `user_prompt` with no matching `prompt_complete`
  // in the installed payload means the turn is still running server-side
  // (metadata carries `turnActive` when the host knows; the transcript
  // derivation covers older hosts + trimmed windows alike). Derive the open
  // turn so the spinner + stop button show immediately after reload instead
  // of only after a `rate_limited` send attempt.
  const openTurn = deriveOpenTurn(installed.messages, meta.turnActive)
  // Older hosts omit `metadata.turnActive`. A trailing user bubble with no
  // assistant reply is the same open-turn signal, and desktop must adopt the
  // host owner instead of `ensureLiveAgent` (that spawn is a duplicate).
  // A closed chat can end on a user bubble; that is not a running turn.
  // `status: 'active'` plus that bubble is how older hosts (no `turnActive`)
  // still say the prompt is in flight.
  const turnLive = persistedTurnIsLive(meta) || (meta.status !== 'closed' && openTurn !== null)
  set((s) => ({
    sessions: {
      ...s.sessions,
      [id]: {
        id,
        agentId: meta.agentId,
        cwd: meta.cwd,
        projectId: meta.projectId,
        status: 'closed',
        title: meta.title,
        activeTurn: openTurn !== null,
        openTurnId: openTurn,
        modes: existingControls?.modes ?? null,
        models: existingControls?.models ?? null,
        configOptions: existingControls?.configOptions ?? [],
        lastError: null,
        createdAt: meta.createdAt,
        replaying: null,
        worktreePath: meta.worktreePath,
        worktreeBranch: meta.worktreeBranch
      }
    },
    messages: { ...s.messages, [id]: trimLiveWindow(installed.messages, id) },
    // Restore the mirrored tool calls so the timeline shows the tool cards
    // again — without this only thoughts + replies survive a reopen. The
    // live cap applies on install too (a payload/restored list must not
    // exceed the live bound).
    toolCalls: { ...s.toolCalls, [id]: trimLiveToolCalls(installed.toolCalls) },
    // CAP-2: restore the durable switch markers so the timeline shows the
    // borderless separators at their seq positions after a reopen.
    agentSwitches: { ...s.agentSwitches, [id]: installed.switches }
  }))
  onTranscriptInstalled()

  // Rehydrate the sticky plan from the latest assistant message's
  // `termul-plan` fence (single source of truth). Scans the payload messages
  // (not the trimmed live window) so the fence is found even when the
  // trimming boundary lands on the snapshot carrier. Skip silently when a
  // live `plans[id]` already exists from an in-flight turn — the live plan
  // owns the active turn; the fence only rehydrates a closed/reopened chat.
  if (!get().plans[id]) {
    // Scan the INSTALLED (hidden-filtered) transcript: a fence inside a hidden
    // greeting turn must not rehydrate a plan whose source never renders.
    const rehydrated = scanPlanFenceFromMessages(installed.messages)
    if (rehydrated && rehydrated.length > 0) {
      set((s) => ({ plans: { ...s.plans, [id]: rehydrated } }))
    } else {
      // Detect a malformed fence (fence present but JSON unparseable / not an
      // array / empty after coercion) and warn so a corrupted snapshot is
      // visible without crashing the rehydrate. Leave `plans[id]` empty so
      // the agent can still emit a fresh plan.
      const lastAgent = [...installed.messages].reverse().find((m) => m.role === 'agent')
      const hasMalformedFence =
        lastAgent?.blocks.some(
          (b) => b.type === 'text' && extractTermulPlanFenceJson(b.text) !== null
        ) ?? false
      if (hasMalformedFence) {
        void logFrontendError({
          level: 'warn',
          source: 'planRehydrate',
          message: `Malformed termul-plan fence in history session ${id}; leaving plans empty`
        })
      }
    }
  }
  // CAP-7 (spec-in-chat-agent-switch): a switched chat reopens with the agent
  // the conversation ENDED with — the shared redirect resolves the full
  // marker chain, delegates the FINAL session's open (full
  // ensure/capability-wait/decideResume machinery), splices the pre-switch
  // transcript under the final id, and remaps the tab. A corrupt/missing
  // newSessionId (or a failed target open) degrades to the original path
  // unchanged — the old transcript stays readable, no crash.
  const redirected = await redirectSwitchedReopen(
    set,
    get,
    id,
    installed,
    'acp.openHistorySession.switchRedirect',
    () => !deletedMidOpen() && isCurrentSessionReopen(id, reopenGeneration)
  )
  if (redirected) return
  // spec-agent-switch-live-merged-transcript: this session may be the TARGET
  // of an earlier same-app-session live switch (crash retry, direct history
  // open) — its durable install above holds only the post-switch log, so
  // re-splice the pre-switch band while the in-memory source link is warm.
  await respliceLiveSwitchTarget(
    set,
    id,
    () => !deletedMidOpen() && isCurrentSessionReopen(id, reopenGeneration)
  )
  // Resolve the CURRENT live agent for this chat's config+cwd. Without this
  // remap the `agentStatus`/`agents` lookups miss (stale UUID after restart)
  // and `decideResume` falls to 'local', leaving `sendPrompt` rejected.
  // The history index and agent-config loader run concurrently at startup, so a
  // restored tab can reach this path before `useAcpAgents` has populated the
  // store. Reload the configs here rather than silently downgrading that chat
  // to read-only on this cold-start race.
  if (meta.agentConfigId && !get().agentConfigs.some((c) => c.id === meta.agentConfigId)) {
    try {
      const configs = await loadAgentConfigsFromDisk()
      if (
        !get().agentConfigs.some((c) => c.id === meta.agentConfigId) &&
        configs.some((c) => c.id === meta.agentConfigId)
      ) {
        set({ agentConfigs: configs })
      }
    } catch (error) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.openHistorySession',
        message: `Failed to reload config ${meta.agentConfigId} for history session ${id}: ${String(error)}`
      })
    }
  }
  if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) return

  let liveAgentId: AgentId = meta.agentId
  // Guard both fields: `ensureLiveAgent` trims `cwd` (throws on undefined),
  // and a missing/empty cwd can't map to a live agent anyway — fall through
  // to read-only 'local' instead of throwing (spec: do not throw).
  if (meta.agentConfigId && meta.cwd) {
    // Issue #837: on web, the host may already have a live agent owning this
    // session (the original tab's process, still streaming). Adopt it before
    // spawning — otherwise every reload spawns a duplicate agent and resumes
    // on it while the original keeps running. A live turn also adopts on
    // desktop (#882): spawning would race the owner the guard is protecting.
    const adopted = await adoptHostOwnedAgent(get, set, id, meta.agentConfigId, meta.cwd, {
      allowDesktop: turnLive
    })
    if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) return
    if (adopted) {
      liveAgentId = adopted
    } else if (!turnLive) {
      const ensured = await ensureLiveAgent(get, set, meta.agentConfigId, meta.cwd, {
        silentSpawnFailure: true
      })
      if (ensured) liveAgentId = ensured
    } else {
      void logFrontendError({
        level: 'warn',
        source: 'acp.attachLiveTurn',
        message: `No host agent listed for live session ${id}; attaching to persisted agent ${meta.agentId} without spawning`
      })
    }
  }
  // CAP-4: `spawnAgent` seeds capabilities synchronously from the spawn
  // response, so a freshly spawned agent already has them by this point.
  // This 3s subscribe+timeout is a defensive fallback for edge cases where
  // capabilities aren't yet populated (e.g., a prewarmed agent whose spawn
  // hasn't resolved, or a legacy entry seeded without the response), not the
  // primary delivery mechanism. It resolves instantly when capabilities are
  // already present.
  if (get().agentStatus[liveAgentId] === 'connected' && !get().agents[liveAgentId]?.capabilities) {
    await new Promise<void>((resolve) => {
      if (get().agents[liveAgentId]?.capabilities) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        unsubscribe()
        resolve()
      }, 3000)
      const unsubscribe = useAcpStore.subscribe((state) => {
        if (state.agents[liveAgentId]?.capabilities) {
          clearTimeout(timeout)
          unsubscribe()
          resolve()
        }
      })
    })
  }

  // Deleted, recreated, or superseded during spawn/capability wait — leave the
  // newer session incarnation alone.
  if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) return

  // Issue #882: a turn still running on the host rejects session/load and
  // session/resume (ACP_REOPEN_TURN_ACTIVE). Re-subscribe instead so the
  // in-flight turn keeps painting. Idle status-active chats still reopen.
  if (turnLive) {
    await attachLiveTurn(set, id, liveAgentId, payload, reopenGeneration)
    return
  }

  const connected = get().agentStatus[liveAgentId] === 'connected'
  const capabilities = get().agents[liveAgentId]?.capabilities ?? null
  let strategy = decideResume({ connected, capabilities })

  // Point the record at the resolved live agent so streaming events from
  // `session/load` route to this session, and (for 'load') open the replay
  // window BEFORE the IPC is sent — replayed chunks stream in while the load
  // request is still in flight and must be accepted, not dropped.
  set((s) => {
    const session = s.sessions[id]
    if (!session) return {}
    return {
      sessions: {
        ...s.sessions,
        [id]: {
          ...session,
          agentId: liveAgentId,
          replaying:
            strategy === 'load'
              ? ('pending' as const)
              : strategy === 'resume'
                ? ('streaming' as const)
                : null
        }
      }
    }
  })

  const reopenBaseline = captureReopenControlBaseline(get().sessions, id)
  const reopenRoots = additionalWorkspaceRoots(
    Boolean(
      get().agents[liveAgentId]?.capabilities?.sessionCapabilities?.additionalDirectories
    ),
    meta.cwd,
    meta.projectId
  )

  if (strategy === 'load') {
    try {
      // Authenticate-on-demand: `session/load` first, `authenticate` + one
      // retry only on an auth-required reply (spec-acp-persistent-auth-reuse).
      const outcome =
        (await withAuthRetry(get, liveAgentId, 'session/load', 'text', () =>
          acpApi.loadSession(liveAgentId, id, meta.cwd, reopenRoots)
        )) ?? {}
      if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) {
        if (isCurrentSessionReopen(id, reopenGeneration)) clearReplayIfPresent()
        return
      }
      mergeReopenOutcomeIfUnchanged(set, id, reopenGeneration, reopenBaseline, outcome)
      set((s) => {
        const session = s.sessions[id]
        if (!session) return { sessions: s.sessions }
        // 'pending' after the response means the agent replayed nothing while
        // the request was in flight: close the window immediately so a later
        // live chunk can't replace the local transcript. An in-progress
        // ('streaming') replay keeps its window one macrotask longer for
        // chunks that lose the IPC race against the response.
        const clearingPending = session.replaying === 'pending'
        return {
          // Closing the window inline skips scheduleReplayEnd's finalize (it
          // only fires while replaying is still set) — finalize here so a
          // chunk that landed during the window (server-history mode: a
          // genuinely new, non-replayed event) can't strand its streaming
          // cursor. No-op when nothing streams (the desktop no-replay case).
          messages: clearingPending ? finalizeStreaming(s.messages, id) : s.messages,
          sessions: withSessionActive(
            {
              ...s.sessions,
              [id]: clearingPending ? { ...session, replaying: null } : session
            },
            id
          )
        }
      })
      scheduleReplayEnd(set, id, reopenGeneration)
    } catch (err) {
      // Deleted or superseded mid-load: do not restore transcript or surface a
      // resume error on the newer session incarnation.
      if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) {
        if (isCurrentSessionReopen(id, reopenGeneration)) clearReplayIfPresent()
        return
      }
      // The host refused the reopen because the turn is still running. Attach
      // instead of painting "Resume failed: ACP_REOPEN_TURN_ACTIVE".
      if (isReopenTurnActiveError(err)) {
        await attachLiveTurn(set, id, liveAgentId, payload, reopenGeneration)
        return
      }
      // Load failed — restore the local transcript so the user still sees
      // history (a partial replay may have replaced it). Hidden turns stay
      // filtered on the restore path too.
      const restored = installableTranscript(id, payload, { headAnchored })
      set((s) => ({
        messages: { ...s.messages, [id]: trimLiveWindow(restored.messages, id) },
        toolCalls: { ...s.toolCalls, [id]: trimLiveToolCalls(restored.toolCalls) },
        agentSwitches: { ...s.agentSwitches, [id]: restored.switches },
        sessions: withSessionResumeError(s.sessions, id, err)
      }))
      throw err
    }
  } else if (strategy === 'resume') {
    try {
      const outcome =
        (await withAuthRetry(get, liveAgentId, 'session/resume', 'text', () =>
          acpApi.resumeSession(liveAgentId, id, meta.cwd, reopenRoots)
        )) ?? {}
      if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) {
        if (isCurrentSessionReopen(id, reopenGeneration)) clearReplayIfPresent()
        return
      }
      mergeReopenOutcomeIfUnchanged(set, id, reopenGeneration, reopenBaseline, outcome)
      set((s) => ({ sessions: withSessionActive(s.sessions, id) }))
      scheduleReplayEnd(set, id, reopenGeneration)
      return
    } catch (err) {
      if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) return
      // The host refused the reopen because the turn is still running. Attach
      // instead of painting "Resume failed" or falling through to session/load.
      if (isReopenTurnActiveError(err)) {
        await attachLiveTurn(set, id, liveAgentId, payload, reopenGeneration)
        return
      }
      if (capabilities?.loadSession === true && resumeMissesSession(err)) {
        void logFrontendError({
          level: 'warn',
          source: 'acp.openHistorySession.resumeFallback',
          message: `session/resume missed session ${id}; falling back to session/load once`
        })
        strategy = 'load'
        set((s) => {
          const session = s.sessions[id]
          if (!session) return {}
          return { sessions: { ...s.sessions, [id]: { ...session, replaying: 'pending' } } }
        })
      } else {
        set((s) => ({ sessions: withSessionResumeError(s.sessions, id, err) }))
        throw err
      }
    }
  }
  if (strategy === 'load' && capabilities?.sessionCapabilities?.resume != null) {
    try {
      const outcome =
        (await withAuthRetry(get, liveAgentId, 'session/load', 'text', () =>
          acpApi.loadSession(liveAgentId, id, meta.cwd, reopenRoots)
        )) ?? {}
      if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) {
        if (isCurrentSessionReopen(id, reopenGeneration)) clearReplayIfPresent()
        return
      }
      mergeReopenOutcomeIfUnchanged(set, id, reopenGeneration, reopenBaseline, outcome)
      set((s) => {
        const session = s.sessions[id]
        if (!session) return { sessions: s.sessions }
        const clearingPending = session.replaying === 'pending'
        return {
          messages: clearingPending ? finalizeStreaming(s.messages, id) : s.messages,
          sessions: withSessionActive(
            {
              ...s.sessions,
              [id]: clearingPending ? { ...session, replaying: null } : session
            },
            id
          )
        }
      })
      scheduleReplayEnd(set, id, reopenGeneration)
    } catch (err) {
      if (deletedMidOpen() || !isCurrentSessionReopen(id, reopenGeneration)) {
        if (isCurrentSessionReopen(id, reopenGeneration)) clearReplayIfPresent()
        return
      }
      if (isReopenTurnActiveError(err)) {
        await attachLiveTurn(set, id, liveAgentId, payload, reopenGeneration)
        return
      }
      const restored = installableTranscript(id, payload, { headAnchored })
      set((s) => ({
        messages: { ...s.messages, [id]: trimLiveWindow(restored.messages, id) },
        toolCalls: { ...s.toolCalls, [id]: trimLiveToolCalls(restored.toolCalls) },
        agentSwitches: { ...s.agentSwitches, [id]: restored.switches },
        sessions: withSessionResumeError(s.sessions, id, err)
      }))
      throw err
    }
  }
  // 'local' → nothing more; the transcript is already shown.
}

/**
 * Copy a live in-memory turn onto index rows. Production host listings omit
 * `turnActive`, so recovery would otherwise skip every multi-active project.
 */
function stampLiveTurnOnIndex(
  entries: SessionIndexEntry[],
  sessions: Record<string, { activeTurn?: boolean; openTurnId?: string | null }>
): SessionIndexEntry[] {
  return entries.map((entry) => {
    if (entry.turnActive === true) return entry
    const live = sessions[entry.id]
    if (live && (live.activeTurn === true || live.openTurnId != null)) {
      return { ...entry, turnActive: true }
    }
    return entry
  })
}

/**
 * When several status-active chats remain and none carry `turnActive`, read
 * the payload (which older indexes still omit) and stamp the open turn
 * before selection.
 */
async function deriveTurnActiveForRecovery(
  entries: SessionIndexEntry[],
  projectId: string,
  openIds: ReadonlySet<string>
): Promise<SessionIndexEntry[]> {
  const candidates = entries.filter(
    (entry) => entry.projectId === projectId && entry.discovered !== true && !openIds.has(entry.id)
  )
  if (candidates.some((entry) => entry.turnActive === true)) return entries
  const active = candidates.filter((entry) => entry.status === 'active')
  if (active.length <= 1) return entries
  const liveIds = new Set<string>()
  await Promise.all(
    active.map(async (entry) => {
      try {
        const payload =
          (await loadSessionPayloadTail(entry.id).catch(() => null)) ??
          (await loadSessionPayload(entry.id))
        if (!payload) return
        const openTurn = deriveOpenTurn(payload.messages, payload.metadata.turnActive)
        if (
          persistedTurnIsLive(payload.metadata) ||
          (payload.metadata.status !== 'closed' && openTurn !== null)
        ) {
          liveIds.add(entry.id)
        }
      } catch (err) {
        void logFrontendError({
          level: 'warn',
          source: 'acp.recoverDroppedLaunch',
          message: `Could not derive turnActive for session ${entry.id}: ${err instanceof Error ? err.message : String(err)}`
        })
      }
    })
  )
  if (liveIds.size === 0) return entries
  return entries.map((entry) => (liveIds.has(entry.id) ? { ...entry, turnActive: true } : entry))
}

/**
 * After a reload drops `launch-*` tabs, open a real persisted chat for the
 * project that is on screen. Drops for other projects stay noted until that
 * project is active. Never reinserts the placeholder id and never deletes
 * history. No-ops before the first successful index load so a note that
 * arrives first is still here when the index lands.
 */
async function recoverDroppedLaunchChats(entries: SessionIndexEntry[]): Promise<void> {
  if (sessionIndexAppliedGeneration === 0) return
  const projectId = useProjectStore.getState().activeProjectId
  if (!projectId) return
  const droppedIds = takeDroppedLaunchPlaceholders(projectId)
  if (droppedIds.length === 0) return
  const workspace = useWorkspaceStore.getState()
  const openIds = new Set<string>()
  for (const pane of getAllLeafPanes(workspace.root)) {
    for (const tab of pane.tabs) {
      if (tab.type === 'agent-chat') openIds.add(tab.sessionId)
    }
  }
  const stamped = stampLiveTurnOnIndex(entries, useAcpStore.getState().sessions)
  const derived = await deriveTurnActiveForRecovery(stamped, projectId, openIds)
  if (useProjectStore.getState().activeProjectId !== projectId) {
    noteDroppedLaunchPlaceholders(projectId, droppedIds)
    return
  }
  const selected = selectLaunchRecoverySessions(derived, projectId, openIds, droppedIds.length)
  if (selected.length === 0) {
    void logFrontendError({
      level: 'warn',
      source: 'acp.recoverDroppedLaunch',
      message: `Dropped ${droppedIds.length} launch placeholder tab(s) for project ${projectId}; no unambiguous persisted session to restore`
    })
    return
  }
  for (const entry of selected) {
    workspace.addAgentChatTab(entry.id)
    openIds.add(entry.id)
    void logFrontendError({
      level: 'info',
      source: 'acp.recoverDroppedLaunch',
      message: `Opened persisted session ${entry.id} after a launch placeholder tab was dropped on reload`
    })
  }
}

/** Editor restore records placeholders after the index load; recover then. */
export function recoverNotedLaunchChats(): Promise<void> {
  return recoverDroppedLaunchChats(useAcpStore.getState().sessionIndex)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/** Extra workspace roots for agents that advertise additionalDirectories. */
export function additionalWorkspaceRoots(
  supports: boolean,
  cwd: string,
  projectId?: string | null
): string[] {
  if (!supports) return []
  const project = projectId
    ? useProjectStore.getState().projects.find((item) => item.id === projectId)
    : undefined
  const candidates = [project?.path, ...(project?.worktrees ?? []).map((item) => item.path)]
  const seen = new Set<string>()
  const roots: string[] = []
  for (const path of candidates) {
    if (!path || path === cwd || seen.has(path) || !isAbsolutePath(path)) continue
    seen.add(path)
    roots.push(path)
  }
  return roots
}

type SessionSliceState = Pick<
  AcpState,
  | 'sessions'
  | 'activeSessionId'
  | 'sessionIndex'
  | 'sessionUsage'
  | 'openingHistoryIds'
  | 'restoringChatIds'
  | 'launchingSessionIds'
  | 'discoveredSessions'
  | 'discoveringKeys'
  | 'discoveredReopenContexts'
  | 'queuedProjectSwitchId'
  | 'failedProjectSwitchId'
  | 'createSession'
  | 'switchProject'
  | 'setFailedProjectSwitch'
  | 'closeSession'
  | 'setActiveSession'
  | 'loadSessionIndex'
  | 'openHistorySession'
  | 'resumeLiveSession'
  | 'flushLiveSessionSaves'
  | 'retryCrashedSession'
  | 'retryFailedLaunch'
  | 'deleteHistorySession'
  | 'discoverSessions'
  | 'openDiscoveredSession'
  | '_onSessionCreated'
  | '_onSessionClosed'
>

export const createSessionSlice: StateCreator<AcpState, [], [], SessionSliceState> = (
  set,
  get
) => ({
  sessionIndex: [],
  openingHistoryIds: {},
  restoringChatIds: {},
  launchingSessionIds: {},
  discoveredSessions: {},
  discoveringKeys: {},
  discoveredReopenContexts: {},
  sessions: {},
  activeSessionId: null,
  sessionUsage: {},
  queuedProjectSwitchId: null,
  failedProjectSwitchId: null,

  createSession: async (agentId, cwd, mcpServers, projectId, opts) => {
    try {
      const selection =
        mcpServers === undefined
          ? selectMcpServersForAgent(get().mcpServers, get().agents[agentId]?.capabilities)
          : { servers: mcpServers, skipped: [], pending: false }
      const sessionMcpServers = selection.servers
      if (!selection.pending && selection.skipped.length > 0) {
        toast.warning('Some MCP servers were skipped', {
          description: `${selection.skipped.map((server) => server.name).join(', ')} require HTTP or SSE support from this agent.`
        })
      }
      // Authenticate-on-demand (spec-acp-persistent-auth-reuse): try
      // `session/new` FIRST — a globally logged-in agent (or reused
      // authenticated process) creates the session with zero sign-in UI.
      // Only an auth-required reply triggers `authenticate` + one retry.
      const outcome = await withAuthRetry(get, agentId, 'session/new', 'picker', () =>
        acpApi.newSession(agentId, cwd, sessionMcpServers, {
          ephemeral: opts?.backendEphemeral ?? false,
          promotable: opts?.promotable ?? false,
          ...(projectId ? { projectId } : {}),
          ...(opts?.worktreePath ? { worktreePath: opts.worktreePath } : {}),
          ...(opts?.worktreeBranch ? { worktreeBranch: opts.worktreeBranch } : {}),
          additionalDirectories: additionalWorkspaceRoots(
            Boolean(get().agents[agentId]?.capabilities?.sessionCapabilities?.additionalDirectories),
            cwd,
            projectId
          )
        })
      )
      const sessionId = outcome.sessionId
      invalidateSessionReopen(sessionId)
      set((s) => {
        // Merge with any record an event may have created during the await window,
        // so we don't discard event-set lastError/activeTurn/modes.
        const existing = s.sessions[sessionId]
        // Warm-pool prepares stay ephemeral and must not hide Restart. Clear
        // the pending marker only after a user-facing chat is created.
        const configId = !opts?.ephemeral ? configIdForAgentId(s, agentId) : null
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: {
              id: sessionId,
              agentId,
              cwd,
              projectId,
              status: existing?.status === 'closed' ? 'closed' : 'active',
              title: existing?.title ?? null,
              activeTurn: existing?.activeTurn ?? false,
              mcpServerCount: sessionMcpServers.length,
              openTurnId: existing?.openTurnId ?? null,
              // An event-created stub (session_created/mode_update beating
              // the reply) carries the SAME creation payload plus any genuine
              // updates that landed during the await — prefer it so a real
              // agent-side change isn't reverted by the `session/new` echo.
              modes: existing?.modes ?? outcome.modes ?? null,
              models: existing?.models ?? outcome.models ?? null,
              configOptions:
                existing && existing.configOptions.length > 0
                  ? existing.configOptions
                  : (outcome.configOptions ?? []),
              // Baseline for the creation-default echo guard: the values the
              // session was created WITH (from whichever payload populated
              // them — the `session/new` result or an earlier event stub).
              creationOptionDefaults:
                existing?.creationOptionDefaults ??
                creationOptionDefaultsFrom({
                  modes: outcome.modes ?? existing?.modes,
                  models: outcome.models ?? existing?.models,
                  configOptions: outcome.configOptions ?? existing?.configOptions
                }),
              lastError: existing?.lastError ?? null,
              createdAt: existing?.createdAt ?? Date.now(),
              replaying: null,
              worktreePath: opts?.worktreePath ?? existing?.worktreePath,
              worktreeBranch: opts?.worktreeBranch ?? existing?.worktreeBranch
            }
          },
          messages: { ...s.messages, [sessionId]: s.messages[sessionId] ?? [] },
          activeSessionId: opts?.ephemeral ? s.activeSessionId : (s.activeSessionId ?? sessionId),
          ...(configId
            ? { pendingRestartVersions: pendingRestartVersionsAfterSpawn(s, configId) }
            : {})
        }
      })
      // Track un-promoted pooled sessions so disconnect/close can drop (not persist) them.
      if (opts?.ephemeral) ephemeralSessionIds.add(sessionId)
      // Mirror to disk (index + payload). Skipped for ephemeral (pooled) sessions,
      // which are promoted to history only when `startChat` consumes them — so an
      // unconsumed warm session never leaves an orphan "Untitled Chat" on disk.
      if (!opts?.ephemeral) {
        const st = get()
        persistSession(st, sessionId, (entries) => set({ sessionIndex: entries }))
      }
      // Cache models/modes even for ephemeral prepares so the launcher can paint
      // instantly from the warm pool.
      const configId = configIdForAgentId(get(), agentId)
      if (configId) {
        writeAgentOptionsCache(set, configId, {
          models: outcome.models ?? null,
          modes: outcome.modes ?? null,
          configOptions: outcome.configOptions ?? []
        })
      }
      return sessionId
    } catch (err) {
      const { category } = classifySetupError(err)
      if (category === 'transport') {
        // Broken stream/connection: discard the process so retry spawns fresh.
        await evictAgentForTransport(get, agentId)
      } else if (category === 'auth') {
        // Allow a manual Sign-in + retry to re-authenticate (P3).
        authenticatedAgents.delete(agentId)
      }
      throw err
    }
  },

  switchProject: async (projectId) => {
    const transport = getAcpTransport()
    if (!transport.switchProject) {
      throw new Error('Project switching is only available in web/remote mode')
    }
    // Starting a new switch clears any prior transient failure indicator so a
    // retry doesn't keep a stale "Failed" badge while the new attempt runs.
    set({ failedProjectSwitchId: null })
    const focusedSessionId = getTabFocusedSessionId() ?? get().activeSessionId
    const currentSession = focusedSessionId ? get().sessions[focusedSessionId] : null
    const outcome = await transport.switchProject(projectId)
    if (outcome.status === 'queued') {
      set({ queuedProjectSwitchId: outcome.projectId })
      return outcome
    }
    if (outcome.status === 'selected') {
      // Cold tab: the server updated the shared active project but created no
      // session (no agent spawned). Mirror desktop's local select + clear the
      // transient switch badges; the agent spawns lazily when a chat starts.
      set({ queuedProjectSwitchId: null, failedProjectSwitchId: null })
      useProjectStore.getState().selectProject(outcome.projectId)
      return outcome
    }
    const agentId = currentSession?.agentId
    if (!agentId) throw new Error('Completed project switch has no tracked agent')

    // Switch-back restore (Epic-4 bridge): if the server reopened an existing
    // session (detected via the server history index), fetch its transcript via
    // `openHistorySession` + focus the workspace tab (`addAgentChatTab`) —
    // mirrors desktop's "restore the last tab." Else the server minted a new
    // session → current blank-chat path below.
    if (get().sessionIndex.some((e) => e.id === outcome.sessionId)) {
      // Parity with the new-session branch: set activeSessionId + clear the
      // queued id so the reopened session is the active chat (not just tab
      // focus).
      set({ queuedProjectSwitchId: null, activeSessionId: outcome.sessionId })
      const opening = get().openHistorySession(outcome.sessionId)
      useWorkspaceStore.getState().addAgentChatTab(outcome.sessionId)
      setTabFocusedSessionId(outcome.sessionId)
      useProjectStore.getState().selectProject(outcome.projectId)
      await opening
      return outcome
    }

    set((s) => {
      const existing = s.sessions[outcome.sessionId]
      return {
        queuedProjectSwitchId: null,
        failedProjectSwitchId: null,
        activeSessionId: outcome.sessionId,
        sessions: {
          ...s.sessions,
          [outcome.sessionId]: {
            id: outcome.sessionId,
            agentId,
            cwd: outcome.cwd,
            projectId: outcome.projectId,
            status: 'active',
            title: existing?.title ?? currentSession.title,
            activeTurn: false,
            mcpServerCount: outcome.mcpServerCount,
            openTurnId: null,
            modes: existing?.modes ?? currentSession.modes,
            models: existing?.models ?? currentSession.models ?? null,
            configOptions: existing?.configOptions ?? currentSession.configOptions,
            lastError: existing?.lastError ?? null,
            createdAt: existing?.createdAt ?? Date.now(),
            replaying: null
          }
        },
        messages: { ...s.messages, [outcome.sessionId]: s.messages[outcome.sessionId] ?? [] }
      }
    })
    setTabFocusedSessionId(outcome.sessionId)
    useProjectStore.getState().selectProject(outcome.projectId)
    return outcome
  },

  setFailedProjectSwitch: (projectId) => set({ failedProjectSwitchId: projectId }),

  closeSession: async (sessionId) => {
    invalidateSessionReopen(sessionId)
    const session = get().sessions[sessionId]
    if (session && session.status !== 'closed') {
      try {
        await acpApi.closeSession(session.agentId, sessionId)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'acp.closeSession',
          message: `Failed to close session ${sessionId}: ${String(error)}`
        })
      }
    }
    // Reclaim app-owned temp files (pasted screenshots) staged for this session
    // now that no further turns can read them.
    void deleteSessionTempFiles(sessionId)
    set((s) => {
      const sessions = { ...s.sessions }
      if (sessions[sessionId]) {
        sessions[sessionId] = {
          ...sessions[sessionId],
          status: 'closed',
          activeTurn: false,
          openTurnId: null,
          replaying: null,
          // A closed session can never execute its armed switch — clear it
          // so a later send surfaces the normal closed-session rejection
          // instead of routing into switchAgent.
          switching: null
        }
      }
      return {
        sessions,
        // A closed session can never serve as a warm-pool draft again — drop
        // its slot so the launcher/prepare path stops resolving it.
        preparedSessions: dropPreparedSlots(s.preparedSessions, (sid) => sid === sessionId),
        pendingPermissions: dropPermissionsForSession(s.pendingPermissions, sessionId),
        pendingQuestions: dropQuestionsForSession(s.pendingQuestions, sessionId),
        pendingElicitations: dropElicitationsForSession(s.pendingElicitations ?? {}, sessionId),
        promptQueues: dropPromptQueueForSession(s.promptQueues, sessionId),
        suppressQueueFlush: dropRecordKey(s.suppressQueueFlush, sessionId)
      }
    })
    // Flush closed status + last transcript to disk while maps still hold it,
    // then drop in-memory maps so WebView2 can reclaim heap. Ephemeral (warm
    // pool) sessions are never mirrored.
    if (
      !ephemeralSessionIds.has(sessionId) &&
      get().sessions[sessionId] &&
      sessionId in get().messages
    ) {
      persistSession(get(), sessionId, (entries) => set({ sessionIndex: entries }))
    }
    set((s) => dropSessionTranscriptState(s, sessionId))
  },

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  loadSessionIndex: async () => {
    // Bump the monotonic generation so a stale response that resolves after a
    // local session/title mutation is discarded rather than overwriting the
    // newer projection.
    const generation = ++sessionIndexLoadGeneration
    let entries: SessionIndexEntry[]
    try {
      entries = await loadSessionIndexFromDisk()
    } catch (error) {
      if (isTransientAcpTransportError(error)) {
        void logFrontendError({
          level: 'warn',
          source: 'acp-store.loadSessionIndex',
          message: `ACP history index refresh failed; preserving current entries: ${String(error)}`
        })
      }
      throw error
    }
    if (generation <= sessionIndexAppliedGeneration) return
    sessionIndexAppliedGeneration = generation
    // Continue the placeholder counter from the highest persisted suffix so a
    // restart doesn't restart at 1 and collide with existing `Untitled Chat N`.
    rebaseUntitledCounter(entries)
    // Merge with the locally-known projection so a stale response cannot
    // remove a just-created row or revert a freshly-titled session. The
    // initial empty-load case (no local entries) applies the host response
    // verbatim.
    const current = get().sessionIndex
    const liveSessionIds = new Set(Object.keys(get().sessions) as SessionId[])
    const merged = stampLiveTurnOnIndex(
      mergeSessionIndexEntries(current, entries, liveSessionIds),
      get().sessions
    )
    set({ sessionIndex: merged })
    // Prune restored agent-chat tabs whose session is neither live nor in the
    // hydrated index — they could only render the corpse "chat unavailable"
    // fallback. Live sessions win over index absence (a just-failed launch is
    // local-only until the host learns about it). Runs only on a successful
    // load: the throw path above preserves tabs when the index cannot be read.
    const workspace = useWorkspaceStore.getState()
    const mergedIds = new Set(merged.map((e) => e.id))
    for (const pane of getAllLeafPanes(workspace.root)) {
      for (const tab of pane.tabs) {
        if (tab.type !== 'agent-chat') continue
        if (liveSessionIds.has(tab.sessionId) || mergedIds.has(tab.sessionId)) continue
        workspace.removeTab(tab.id)
      }
    }
    await recoverDroppedLaunchChats(merged)
  },

  openHistorySession: async (id) => {
    const cached = get().sessions[id]
    // Only skip reload for a genuinely live session (active/initializing/error).
    // Still show the click feedback briefly before revealing the already-usable
    // chat, matching every other history-row open.
    if (cached && cached.status !== 'closed') {
      const restoreToken = beginRestorePreload(set, id)
      scheduleRestorePreloadEnd(set, id, restoreToken)
      return
    }

    // Coalesce only with the current session incarnation. Delete/recreate bumps
    // the generation and detaches the old task so a replacement can start.
    const currentGeneration = sessionReopenGenerations.get(id) ?? 0
    const inFlight = inFlightHistoryOpens.get(id)
    if (inFlight?.generation === currentGeneration) return inFlight.promise

    const restoreToken = beginRestorePreload(set, id)
    const reopenGeneration = beginSessionReopen(id)
    let transcriptInstalled = false
    let task!: Promise<void>
    task = (async () => {
      try {
        await openHistorySessionInner(
          get,
          set,
          id,
          () => {
            transcriptInstalled = true
            scheduleRestorePreloadEnd(set, id, restoreToken)
          },
          reopenGeneration
        )
      } finally {
        if (!transcriptInstalled) scheduleRestorePreloadEnd(set, id, restoreToken)
        const current = inFlightHistoryOpens.get(id)
        if (current?.generation === reopenGeneration && current.promise === task) {
          inFlightHistoryOpens.delete(id)
          set((s) => ({ openingHistoryIds: dropRecordKey(s.openingHistoryIds, id) }))
        }
      }
    })()
    inFlightHistoryOpens.set(id, { generation: reopenGeneration, promise: task })
    set((s) => ({ openingHistoryIds: { ...s.openingHistoryIds, [id]: true } }))
    return task
  },

  resumeLiveSession: async (id, agentId, cwd) => {
    // R1: install the persisted transcript, then resume against the
    // authoritative live agent (still owned by the Rust `AcpManager` across a
    // webview/phone reload) — WITHOUT `ensureLiveAgent`, which would cold-spawn
    // a duplicate agent because the renderer lost its `configToLiveAgent` map
    // on refresh. The backend `gate_resume_session` enforces the capability
    // (reused — not duplicated); a rejection rejects here so the bootstrap hook
    // can record `acp-resume-skipped` and keep the transcript read-only.
    // Tail-first: fetch only the recent messages for fast resume. The full
    // payload loads lazily on scroll-up via `loadOlderMessages`. Falls back
    let headAnchored = false
    let payload = await loadSessionPayloadTail(id).catch((err) => {
      void logFrontendError({
        level: 'warn',
        source: 'acp.resumeLiveSession.tailFetch',
        message: `Tail fetch failed for session ${id}, falling back to full load: ${String(err)}`
      })
      return null
    })
    if (payload) {
      // Same head-anchor rule as openHistorySessionInner: only a
      // shorter-than-limit window provably contains the conversation head.
      headAnchored = payload.messages.length < HISTORY_TAIL_MESSAGE_LIMIT
    } else {
      payload = await loadSessionPayload(id)
      headAnchored = true
    }
    if (!payload) throw new Error(`no persisted history for ${id}`)
    const meta = payload.metadata
    const installed = installableTranscript(id, payload, { headAnchored })
    // #838 parity with openHistorySessionInner: a trailing unmatched
    // `user_prompt` (or server metadata) means the turn is still running —
    // the resumed chat must open with the spinner + stop button, not idle.
    const openTurn = deriveOpenTurn(installed.messages, meta.turnActive)
    rebaseSeqCounter(maxPayloadSeq(payload))
    set((s) => ({
      sessions: {
        ...s.sessions,
        [id]: {
          id,
          agentId,
          cwd: meta.cwd,
          projectId: meta.projectId,
          status: 'closed',
          title: meta.title,
          activeTurn: openTurn !== null,
          openTurnId: openTurn,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: meta.createdAt,
          worktreePath: meta.worktreePath,
          worktreeBranch: meta.worktreeBranch,
          // 'streaming' (not null): the session stays 'closed' until resume
          // resolves, but gap-replay chunks arriving during the
          // `acpApi.resumeSession` window (web subscribe-from-watermark) must
          // APPEND to this restored transcript. `acceptsSessionTranscriptEvents`
          // accepts because `replaying` is truthy, and `_onMessageChunk`'s
          // 'pending' replace-block is skipped so the mirror is not erased.
          // Tool/collection reducers share the same gate.
          replaying: 'streaming'
        }
      },
      messages: { ...s.messages, [id]: trimLiveWindow(installed.messages, id) },
      // Restore the mirrored tool calls alongside the transcript so the
      // resumed session's timeline keeps its tool cards (capped at the live
      // bound — an install must not exceed it).
      toolCalls: { ...s.toolCalls, [id]: trimLiveToolCalls(installed.toolCalls) },
      // CAP-2: restore the switch markers alongside the transcript.
      agentSwitches: { ...s.agentSwitches, [id]: installed.switches }
    }))
    // CAP-7 (spec-in-chat-agent-switch): a switched chat resumes with the
    // agent the conversation ENDED with — the LAST durable switch marker is
    // authoritative, superseding the caller's (stale, pre-switch) agent. The
    // shared redirect (identical to `openHistorySessionInner`'s: full marker
    // chain, delegated final-session open, one splice + one guarded remap)
    // owns the continuation; a corrupt/missing `newSessionId` (or a failed
    // redirect) degrades to the original resume path below unchanged.
    const redirected = await redirectSwitchedReopen(
      set,
      get,
      id,
      installed,
      'acp.resumeLiveSession.switchRedirect'
    )
    if (redirected) {
      // The old session's resume window (replaying: 'streaming', set above)
      // must close — its transcript was superseded by the redirected open.
      set((s) => {
        const session = s.sessions[id]
        if (!session?.replaying) return {}
        return { sessions: { ...s.sessions, [id]: { ...session, replaying: null } } }
      })
      return
    }
    // spec-agent-switch-live-merged-transcript: same target-reinstall case
    // as openHistorySessionInner — the resume install replaced the
    // transcript wholesale; restore the merged band while the source link
    // is warm. stillCurrent guards the mid-await teardown: a session deleted
    // (or its transcript state dropped) while the source payload loaded must
    // not get a resurrected band — mirror the sibling call site's invariant.
    await respliceLiveSwitchTarget(set, id, () => {
      const s = get()
      return Boolean(s.sessions[id]) && liveSwitchSources.get(id) !== undefined
    })
    if (persistedTurnIsLive(meta) || (meta.status !== 'closed' && openTurn !== null)) {
      const generation = sessionReopenGenerations.get(id) ?? beginSessionReopen(id)
      await attachLiveTurn(set, id, agentId, payload, generation)
      return
    }
    try {
      // `acpApi.resumeSession` routes to `acp_resume_session` (desktop) or the
      // `resume_session` WS request (web). On web it auto-re-subscribes with
      // `this.lastSeq.get(sid) ?? 0`, so the hook seeds the server cursor first.
      // Authenticate-on-demand wraps it so an auth-required reply runs
      // `authenticate` + one retry (spec-acp-persistent-auth-reuse).
      await withAuthRetry(get, agentId, 'session/resume', 'text', () =>
        acpApi.resumeSession(
          agentId,
          id,
          cwd,
          additionalWorkspaceRoots(
            Boolean(get().agents[agentId]?.capabilities?.sessionCapabilities?.additionalDirectories),
            cwd,
            payload.metadata.projectId
          )
        )
      )
      // Gap-replay has landed on the restored transcript; clear the resume
      // window. `withSessionActive` alone leaves `replaying: 'streaming'`,
      // which would disable rAF coalescing for live chunks after resume.
      // Finalize streaming too: a chunk that landed during the window (server
      // history mode: a genuinely new, non-replayed event) must not strand
      // its streaming cursor once the window closes.
      set((s) => ({
        messages: finalizeStreaming(s.messages, id),
        sessions: {
          ...s.sessions,
          [id]: { ...s.sessions[id], status: 'active', replaying: null, lastError: null }
        }
      }))
    } catch (err) {
      if (isReopenTurnActiveError(err)) {
        const generation = sessionReopenGenerations.get(id) ?? beginSessionReopen(id)
        await attachLiveTurn(set, id, agentId, payload, generation)
        return
      }
      // Restore the local transcript (a partial resume may have replaced it)
      // and surface the failure; the hook classifies skip vs fail and never
      // throws on the bootstrap path. Hidden turns stay filtered on restore.
      const restored = installableTranscript(id, payload, { headAnchored })
      set((s) => ({
        messages: { ...s.messages, [id]: trimLiveWindow(restored.messages, id) },
        toolCalls: { ...s.toolCalls, [id]: trimLiveToolCalls(restored.toolCalls) },
        agentSwitches: { ...s.agentSwitches, [id]: restored.switches },
        sessions: withSessionResumeError(s.sessions, id, err)
      }))
      throw err
    }
  },

  flushLiveSessionSaves: () => {
    // CAP-2: durable writes are host-owned; on unload we only refresh the local
    // index projection for every live session. Reuses `persistSession` — its
    // `session.replaying` / absent-message-key guards + `streaming:true` strip
    // are preserved. `WorkspaceLayout.persistBeforeUnload` still awaits
    // `flushSessionHistory()` to drain any queued deletes (best-effort,
    // never throws — matching `persistSession`'s contract).
    const state = get()
    for (const sessionId of Object.keys(state.sessions)) {
      // Skip un-promoted warm-pool ephemeral sessions and already-closed
      // sessions — matching the guards `closeSession`/`_onDisconnect` use so
      // an ephemeral session can't gain an index entry on unload.
      if (ephemeralSessionIds.has(sessionId)) continue
      if (state.sessions[sessionId]?.status === 'closed') continue
      persistSession(state, sessionId as SessionId, (entries) =>
        set(() => ({ sessionIndex: entries }))
      )
    }
  },

  retryCrashedSession: async (sessionId) => {
    // Dedupe concurrent Retry clicks: only one relaunch+replay+resend per session.
    if (inFlightCrashedRetries.has(sessionId)) return
    inFlightCrashedRetries.add(sessionId)
    try {
      const session = get().sessions[sessionId]
      if (!session) throw new Error(`unknown session ${sessionId}`)
      // Force the reopen path: mark closed so `openHistorySession` re-runs its
      // reopen (re-launch a fresh agent via `ensureLiveAgent`, replay persisted
      // history via `session/load`, restore the local transcript) instead of its
      // "cached non-closed" early-return. The reopen preserves the same tab +
      // history — it never blanks (transcript is installed before agent work).
      set((s) => {
        const cur = s.sessions[sessionId]
        if (!cur) return {}
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: { ...cur, status: 'closed', lastError: null }
          }
        }
      })
      await get().openHistorySession(sessionId)
      // Reopen failed (still closed / no live agent): leave the recovered
      // transcript + let the resume error show — do not blank.
      const reopened = get().sessions[sessionId]
      if (!reopened || reopened.status === 'closed') return
      // Re-send the last user prompt to produce a fresh assistant turn (retry).
      // `switch-splice:` records are projected pre-switch history — retrying
      // one would re-send the OLD agent's prompt to the new session.
      const msgs = get().messages[sessionId] ?? []
      let lastUserBlocks: ContentBlock[] | null = null
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && !msgs[i].id.startsWith(SWITCH_SPLICE_ID_PREFIX)) {
          lastUserBlocks = msgs[i].blocks
          break
        }
      }
      if (!lastUserBlocks || lastUserBlocks.length === 0) return
      // Sanitized WIRE blocks: the stored display text carries private-use
      // pill sentinels (command/skill/file tokens); map each text block to
      // readable wire text (`/name` / `(name)` / `(display)` — the token sits
      // at the front of the display text, so the in-place replacement
      // reproduces the fresh-send wire byte-identically for command-only
      // turns). Non-text blocks (image/resource) pass through unchanged. The
      // original (token) blocks stay as the display so the timeline keeps
      // chips.
      const wireBlocks: ContentBlock[] = lastUserBlocks.map((b) =>
        b.type === 'text' && typeof b.text === 'string'
          ? { type: 'text', text: sanitizeDisplayText(b.text) }
          : b
      )
      const only = wireBlocks.length === 1 ? wireBlocks[0] : null
      await runPromptTurn(
        set,
        get,
        sessionId,
        wireBlocks,
        (s, turnId) =>
          only?.type === 'text' && typeof only.text === 'string'
            ? acpApi.sendPrompt(s.agentId, sessionId, only.text, turnId, lastUserBlocks)
            : acpApi.sendPromptBlocks(s.agentId, sessionId, wireBlocks, turnId, lastUserBlocks),
        undefined,
        { skipUserAppend: true, displayBlocks: lastUserBlocks }
      )
    } finally {
      inFlightCrashedRetries.delete(sessionId)
    }
  },
  retryFailedLaunch: async (sessionId) => {
    // Dedupe concurrent Retry clicks (shared set with retryCrashedSession so a
    // click storm across banners can never run two relaunches for one session).
    if (inFlightCrashedRetries.has(sessionId)) return
    inFlightCrashedRetries.add(sessionId)
    // Durable boundary logs (AGENTS.md): every retry outcome is recorded.
    // Safe context only — session id + operation, never prompts, env values,
    // or credentials.
    void logFrontendError({
      level: 'warn',
      source: 'acp.retryFailedLaunch.start',
      message: `Retrying failed chat launch for session ${sessionId}`
    })
    try {
      const failed = get().sessions[sessionId]
      if (failed?.status !== 'error' || !failed.launchConfigId) {
        throw new Error(`no failed launch recorded for ${sessionId}`)
      }
      // Back to launching: clears the old error banner (lastError null) and
      // marks the session as launching while prepare re-runs. The placeholder keeps
      // its tab + optimistic transcript — a failed launch never blanks the pane.
      set((s) => {
        const cur = s.sessions[sessionId]
        if (!cur) return s
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: { ...cur, status: 'initializing', lastError: null }
          },
          launchingSessionIds: { ...s.launchingSessionIds, [sessionId]: true }
        }
      })
      // Re-send the failed launch's first prompt: the optimistic user message
      // is still in the transcript, and finalizeChatLaunch's hadOptimisticUser
      // check skips the duplicate append (same as the original launch). A
      // launch without a first prompt relaunches without re-sending.
      const msgs = get().messages[sessionId] ?? []
      let lastUserBlocks: ContentBlock[] | null = null
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          lastUserBlocks = msgs[i].blocks
          break
        }
      }
      // Reuses finalizeChatLaunch unchanged: its success branch merges the
      // placeholder into the real session (dropping the failed index entry) and
      // its catch re-marks the session 'error' with fresh actionable text.
      await get().finalizeChatLaunch({
        placeholderId: sessionId,
        configId: failed.launchConfigId,
        cwd: failed.cwd,
        projectId: failed.projectId,
        mcpServers: undefined,
        // Re-apply the launcher model/mode/config selections captured when the
        // launch failed, so Retry honors the user's original choices. MCP
        // servers stay undefined: createSession keeps using the current MCP
        // registry defaults.
        pending: failed.pendingLauncherOptions ?? null,
        initialText: null,
        initialBlocks: lastUserBlocks,
        adoptSession: (from, to) => {
          // Only remap when the tab is still open: remapAgentChatSession's
          // no-pane fallback would ADD an uninvited new tab for a session the
          // user deliberately closed mid-retry.
          const ws = useWorkspaceStore.getState()
          if (findPaneContainingTab(ws.root, agentChatTabId(from))) {
            ws.remapAgentChatSession(from, to)
          }
        },
        worktreePath: failed.worktreePath,
        worktreeBranch: failed.worktreeBranch
      })
      void logFrontendError({
        level: 'warn',
        source: 'acp.retryFailedLaunch.success',
        message: `Failed chat launch retry succeeded for session ${sessionId}`
      })
    } catch (err) {
      if (err instanceof ChatLaunchCancelledError) {
        // The user deleted the failed chat mid-retry; finalizeChatLaunch
        // already tore down the late session. Not a failure — the chat is
        // gone, so there is no banner to re-stamp and nothing for the Retry
        // click handler to show. Record the boundary outcome and resolve.
        void logFrontendError({
          level: 'warn',
          source: 'acp.retryFailedLaunch.cancelled',
          message: `Failed chat launch retry cancelled for session ${sessionId}: chat deleted mid-retry`
        })
        return
      }
      void logFrontendError({
        source: 'acp.retryFailedLaunch',
        message: `Failed chat launch retry failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      })
      throw err
    } finally {
      inFlightCrashedRetries.delete(sessionId)
    }
  },

  deleteHistorySession: async (id) => {
    invalidateSessionReopen(id)
    inFlightHistoryOpens.delete(id)
    inFlightDiscoveredOpens.delete(id)
    invalidateRestorePreload(set, id)
    // Launch cancellation tombstone: deleting a chat whose launch/retry is
    // still in flight (startChat unresolved) revokes that launch —
    // finalizeChatLaunch checks this after startChat resolves and tears the
    // late session down instead of merging the transcript + sending the
    // prompt. Guarded on the launching flag so a post-merge delete cannot
    // leave a stale tombstone behind.
    if (get().launchingSessionIds[id]) {
      cancelledChatLaunches.add(id)
    }
    const live = get().sessions[id]
    const agent = live ? get().agents[live.agentId] : undefined
    if (live && agent?.capabilities?.sessionCapabilities?.delete) {
      try {
        await acpApi.deleteAgentSession(live.agentId, id)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'acp.deleteHistorySession',
          message: `session/delete failed for ${id}: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
    try {
      await queueSessionPayloadDelete(id)
      set((s) => {
        // Only publish deletion after the Rust store confirms the durable
        // payload/index removal, so a failed delete cannot diverge on restart.
        const sessions = { ...s.sessions }
        if (sessions[id]) {
          sessions[id] = {
            ...sessions[id],
            status: 'closed',
            activeTurn: false,
            openTurnId: null,
            replaying: null
          }
        }
        return {
          sessionIndex: s.sessionIndex.filter((e) => e.id !== id),
          sessions,
          openingHistoryIds: dropRecordKey(s.openingHistoryIds, id),
          discoveredReopenContexts: dropRecordKey(s.discoveredReopenContexts, id),
          ...dropSessionTranscriptState(s, id)
        }
      })
      // Close the session's workspace tab if one is open (removeTab no-ops
      // otherwise) so deleting a chat — e.g. an open failed launch — fully
      // discards it instead of leaving a locked-composer pane behind.
      useWorkspaceStore.getState().removeTab(agentChatTabId(id))
      // Reclaim any app-owned temp files staged for this session.
      void deleteSessionTempFiles(id)
    } catch {
      // Same console-vs-log-api rationale as loadAgentConfigs.
      void logFrontendError({
        level: 'warn',
        source: 'acp.deleteHistorySession',
        message: 'failed to delete session history'
      })
    }
  },

  // --- Session discovery (gh-407) -------------------------------------------

  discoverSessions: async (agentId, cwd) => {
    // Gate on sessionCapabilities.list — never call session/list without it.
    const agent = get().agents[agentId]
    if (!agent?.capabilities) {
      console.info('[acp] discoverSessions: no capabilities for agent', agentId)
      return
    }
    if (!agent.capabilities.sessionCapabilities?.list) {
      console.info(
        '[acp] discoverSessions: agent does not advertise sessionCapabilities.list, skipping',
        agentId,
        agent.capabilities.sessionCapabilities
      )
      return
    }

    // Scope the result + in-flight slot per (agent, cwd) so switching cwd never
    // clobbers another cwd's results, and a slow in-flight discovery for one cwd
    // can't overwrite a newer cwd's results.
    const key = discoveryKey(agentId, cwd)

    // Prevent duplicate concurrent discovery for the same (agent, cwd).
    if (get().discoveringKeys[key]) return
    // Gate on a LIVE connection, not just capability presence: _onAgentDisconnected
    // leaves the agent in `agents` (status 'error') but it can no longer service
    // session/list. Skip stale agents up front.
    if (get().agentStatus[agentId] !== 'connected') return
    set((s) => ({ discoveringKeys: { ...s.discoveringKeys, [key]: true } }))

    try {
      const all: SessionInfo[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      // Safety cap: 10 pages max.
      for (let i = 0; i < 10; i++) {
        const res = await acpApi.listSessions(agentId, cwd || undefined, cursor)
        if (Array.isArray(res.sessions)) {
          // De-dupe by sessionId across pages (an agent may repeat an entry
          // when paginating) so the sidebar never renders the same chat twice.
          for (const info of res.sessions) {
            if (seen.has(info.sessionId)) continue
            seen.add(info.sessionId)
            all.push(info)
          }
        }
        // Treat the cursor as opaque: only stop when it is absent (nullish).
        // An empty-string cursor is a valid token and must NOT end pagination.
        if (res.nextCursor == null) break
        cursor = res.nextCursor
      }
      // Drop the result if the agent disconnected while the request was in
      // flight, so a slow response can't repopulate state after teardown.
      if (get().agentStatus[agentId] !== 'connected') return
      // Log only counts + context — never session metadata (titles/ids/cwd can
      // be sensitive). Detailed payloads stay out of the console.
      console.info(`[acp] discoverSessions: agent ${agentId} returned ${all.length} session(s)`)
      set((s) => ({ discoveredSessions: { ...s.discoveredSessions, [key]: all } }))

      // Discovery no longer promotes external sessions into host persistence:
      // the Chats tab renders only Termul-created sessions (`discovered !== true`),
      // and `session/list` results are external chats Termul did not create. The
      // function is retained so store coverage keeps exercising the `session/list`
      // path; it is no longer auto-triggered from the sidebar.
    } catch (e) {
      // Best-effort: log warning, don't toast (discovery is opportunistic).
      console.warn('[acp] session/list failed for agent', agentId, e)
      // Clear any stale discovered entries for this (agent, cwd).
      set((s) => {
        const next = { ...s.discoveredSessions }
        delete next[key]
        return { discoveredSessions: next }
      })
    } finally {
      set((s) => {
        const next = { ...s.discoveringKeys }
        delete next[key]
        return { discoveringKeys: next }
      })
    }
  },

  openDiscoveredSession: (agentId, sessionId, cwd, projectId) => {
    const inFlight = inFlightDiscoveredOpens.get(sessionId)
    const currentGeneration = sessionReopenGenerations.get(sessionId) ?? 0
    if (inFlight?.generation === currentGeneration) return inFlight.promise

    const restoreToken = beginRestorePreload(set, sessionId)
    const reopenGeneration = beginSessionReopen(sessionId)
    set((s) => ({
      discoveredReopenContexts: {
        ...s.discoveredReopenContexts,
        [sessionId]: { agentId, cwd, projectId }
      }
    }))
    const task = (async () => {
      const connected = get().agentStatus[agentId] === 'connected'
      const capabilities = get().agents[agentId]?.capabilities ?? null
      let strategy = decideResume({ connected, capabilities })

      if (strategy === 'local') {
        set((s) => ({
          discoveredReopenContexts: dropRecordKey(s.discoveredReopenContexts, sessionId)
        }))
        throw new Error(
          'agent does not support loading or resuming sessions (no loadSession or sessionCapabilities.resume)'
        )
      }

      // Preserve controls from an existing discovered record when the reopen
      // response omits optional fields. An explicit configOptions: [] below still
      // clears the preserved list.
      const existingControls = captureReopenControlBaseline(get().sessions, sessionId)

      // Create a minimal session record so streaming events (session/update)
      // during replay have a session to attach to, mirroring openHistorySession.
      // For the 'load' strategy the session is marked replaying so replayed
      // chunks are accepted while the session is still 'closed' (load in flight).
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: {
            id: sessionId,
            agentId,
            cwd,
            projectId,
            status: 'closed',
            title: null,
            activeTurn: false,
            openTurnId: null,
            modes: existingControls?.modes ?? null,
            models: existingControls?.models ?? null,
            configOptions: existingControls?.configOptions ?? [],
            lastError: null,
            createdAt: Date.now(),
            replaying: strategy === 'load' ? 'pending' : strategy === 'resume' ? 'streaming' : null,
            // Stamp origin so persistSession keeps this external session hidden
            // even when it has no sessionIndex entry yet (disconnect/close path).
            discovered: true
          }
        },
        messages: { ...s.messages, [sessionId]: [] }
      }))

      const reopenBaseline = captureReopenControlBaseline(get().sessions, sessionId)

      if (strategy === 'load') {
        // Agent replays history via session/update into the empty transcript.
        try {
          const outcome =
            (await withAuthRetry(get, agentId, 'session/load', 'text', () =>
              acpApi.loadSession(
                agentId,
                sessionId,
                cwd,
                additionalWorkspaceRoots(
                  Boolean(
                    get().agents[agentId]?.capabilities?.sessionCapabilities?.additionalDirectories
                  ),
                  cwd,
                  projectId
                )
              )
            )) ?? {}
          if (!isCurrentSessionReopen(sessionId, reopenGeneration)) return
          mergeReopenOutcomeIfUnchanged(set, sessionId, reopenGeneration, reopenBaseline, outcome)
          set((s) => {
            const session = s.sessions[sessionId]
            if (!session) return { sessions: s.sessions }
            // 'pending' after the response = no replay arrived; close the window
            // now so a later live chunk can't replace the transcript. See
            // openHistorySessionInner for the same rule. Closing inline skips
            // scheduleReplayEnd's finalize — finalize here so a chunk that
            // landed during the window can't strand its streaming cursor.
            const clearingPending = session.replaying === 'pending'
            return {
              messages: clearingPending ? finalizeStreaming(s.messages, sessionId) : s.messages,
              sessions: withSessionActive(
                {
                  ...s.sessions,
                  [sessionId]: clearingPending ? { ...session, replaying: null } : session
                },
                sessionId
              ),
              discoveredReopenContexts: dropRecordKey(s.discoveredReopenContexts, sessionId)
            }
          })
          // Deferred so replayed chunks that lose the IPC race still land.
          scheduleReplayEnd(set, sessionId, reopenGeneration)
        } catch (err) {
          if (!isCurrentSessionReopen(sessionId, reopenGeneration)) return
          // Drop any partially replayed content so the pane doesn't show a
          // half-loaded transcript under the error (there is no local mirror to
          // restore for a discovered session).
          set((s) => ({
            messages: { ...s.messages, [sessionId]: [] },
            sessions: withSessionResumeError(s.sessions, sessionId, err)
          }))
          throw err
        }
      } else if (strategy === 'resume') {
        try {
          const outcome =
            (await withAuthRetry(get, agentId, 'session/resume', 'text', () =>
              acpApi.resumeSession(
                agentId,
                sessionId,
                cwd,
                additionalWorkspaceRoots(
                  Boolean(
                    get().agents[agentId]?.capabilities?.sessionCapabilities?.additionalDirectories
                  ),
                  cwd,
                  projectId
                )
              )
            )) ?? {}
          if (!isCurrentSessionReopen(sessionId, reopenGeneration)) return
          mergeReopenOutcomeIfUnchanged(set, sessionId, reopenGeneration, reopenBaseline, outcome)
          set((s) => ({
            sessions: withSessionActive(s.sessions, sessionId),
            discoveredReopenContexts: dropRecordKey(s.discoveredReopenContexts, sessionId)
          }))
          scheduleReplayEnd(set, sessionId, reopenGeneration)
          return
        } catch (err) {
          if (!isCurrentSessionReopen(sessionId, reopenGeneration)) return
          if (capabilities?.loadSession === true && resumeMissesSession(err)) {
            void logFrontendError({
              level: 'warn',
              source: 'acp.openDiscoveredSession.resumeFallback',
              message: `session/resume missed session ${sessionId}; falling back to session/load once`
            })
            strategy = 'load'
            set((s) => {
              const session = s.sessions[sessionId]
              if (!session) return {}
              return {
                sessions: { ...s.sessions, [sessionId]: { ...session, replaying: 'pending' } }
              }
            })
          } else {
            // Resume accepted live chunks (replaying: streaming). Drop them so
            // a failed reopen does not keep a partial transcript.
            set((s) => ({
              messages: { ...s.messages, [sessionId]: [] },
              sessions: withSessionResumeError(s.sessions, sessionId, err)
            }))
            throw err
          }
        }
      }
      if (strategy === 'load' && capabilities?.sessionCapabilities?.resume != null) {
        try {
          const outcome =
            (await withAuthRetry(get, agentId, 'session/load', 'text', () =>
              acpApi.loadSession(
                agentId,
                sessionId,
                cwd,
                additionalWorkspaceRoots(
                  Boolean(
                    get().agents[agentId]?.capabilities?.sessionCapabilities?.additionalDirectories
                  ),
                  cwd,
                  projectId
                )
              )
            )) ?? {}
          if (!isCurrentSessionReopen(sessionId, reopenGeneration)) return
          mergeReopenOutcomeIfUnchanged(set, sessionId, reopenGeneration, reopenBaseline, outcome)
          set((s) => {
            const session = s.sessions[sessionId]
            if (!session) return { sessions: s.sessions }
            const clearingPending = session.replaying === 'pending'
            return {
              messages: clearingPending ? finalizeStreaming(s.messages, sessionId) : s.messages,
              sessions: withSessionActive(
                {
                  ...s.sessions,
                  [sessionId]: clearingPending ? { ...session, replaying: null } : session
                },
                sessionId
              ),
              discoveredReopenContexts: dropRecordKey(s.discoveredReopenContexts, sessionId)
            }
          })
          scheduleReplayEnd(set, sessionId, reopenGeneration)
        } catch (err) {
          if (!isCurrentSessionReopen(sessionId, reopenGeneration)) return
          set((s) => ({
            messages: { ...s.messages, [sessionId]: [] },
            sessions: withSessionResumeError(s.sessions, sessionId, err)
          }))
          throw err
        }
      }
    })()

    const sharedTask = task.finally(() => {
      scheduleRestorePreloadEnd(set, sessionId, restoreToken)
      const current = inFlightDiscoveredOpens.get(sessionId)
      if (current?.generation === reopenGeneration && current.promise === sharedTask) {
        inFlightDiscoveredOpens.delete(sessionId)
      }
    })
    inFlightDiscoveredOpens.set(sessionId, {
      generation: reopenGeneration,
      promise: sharedTask
    })
    return sharedTask
  },

  _onSessionCreated: (e) => {
    set((s) => {
      const existing = s.sessions[e.sessionId]
      if (existing) {
        // Enrich-only — the event re-delivers the SAME `session/new` payload
        // the local create path already installed (manager.rs fans it out
        // before send_reply, so it can land after pending launcher picks were
        // applied). Populated option fields are authoritative: fill only
        // EMPTY ones so a late echo of creation defaults cannot revert values
        // the user already selected.
        return {
          sessions: {
            ...s.sessions,
            [e.sessionId]: {
              ...existing,
              modes: existing.modes ?? e.modes ?? null,
              models: existing.models ?? e.models ?? null,
              configOptions:
                existing.configOptions.length > 0
                  ? existing.configOptions
                  : (e.configOptions ?? existing.configOptions),
              creationOptionDefaults:
                existing.creationOptionDefaults ?? creationOptionDefaultsFrom(e)
            }
          }
        }
      }
      return {
        sessions: {
          ...s.sessions,
          [e.sessionId]: {
            id: e.sessionId,
            agentId: e.agentId,
            cwd: '',
            projectId: '',
            status: 'active',
            title: null,
            activeTurn: false,
            mcpServerCount: 0,
            openTurnId: null,
            modes: e.modes ?? null,
            models: e.models ?? null,
            configOptions: e.configOptions ?? [],
            // The stub's option values ARE the creation payload — they are
            // the echo-guard baseline until `createSession` merges over it.
            creationOptionDefaults: creationOptionDefaultsFrom(e),
            lastError: null,
            createdAt: Date.now(),
            replaying: null
          }
        },
        messages: { ...s.messages, [e.sessionId]: s.messages[e.sessionId] ?? [] }
      }
    })
    cacheOptionsFromSession(set, get, e.sessionId)
    refreshHostOwnedIndex(get)
  },

  _onSessionClosed: (e) => {
    const hadCommit = commitMessageCollectors.has(e.sessionId)
    const hadAssist = terminalAssistCollectors.has(e.sessionId)
    if (hadCommit)
      rejectCommitMessageCollector(e.sessionId, 'The temporary ACP session closed unexpectedly')
    if (hadAssist)
      rejectTerminalAssistCollector(e.sessionId, 'The temporary ACP session closed unexpectedly')
    if (hadCommit || hadAssist) return
    // Flush coalesced updates so transcript eviction sees the final state.
    flushCoalescedSync()
    invalidateSessionReopen(e.sessionId)
    // Reclaim app-owned temp files staged for this session (e.g. agent
    // disconnected) so they do not linger in the OS temp dir.
    void deleteSessionTempFiles(e.sessionId)
    if (ephemeralSessionIds.has(e.sessionId)) {
      const hasContent = (get().messages[e.sessionId]?.length ?? 0) > 0
      if (!hasContent) {
        // Un-promoted pooled session with no transcript, closed by the backend:
        // drop it entirely (never persisted) so no orphan "Untitled Chat" survives.
        ephemeralSessionIds.delete(e.sessionId)
        set((s) => {
          const sessions = { ...s.sessions }
          delete sessions[e.sessionId]
          // Also drop any warm-slot lookup pointing at this session so the UI
          // stops reporting "Session ready" and startChat can't promote a dead id.
          const preparedSessions = dropPreparedSlots(
            s.preparedSessions,
            (sid) => sid === e.sessionId
          )
          return {
            sessions,
            preparedSessions,
            pendingPermissions: dropPermissionsForSession(s.pendingPermissions, e.sessionId),
            pendingQuestions: dropQuestionsForSession(s.pendingQuestions, e.sessionId),
            ...dropSessionTranscriptState(s, e.sessionId)
          }
        })
        return
      }
      // A pooled session that accumulated a transcript is promoted (removed
      // from the ephemeral pool) and falls through to the normal close path
      // below so it is persisted + marked closed — never orphaned.
      ephemeralSessionIds.delete(e.sessionId)
    }
    set((s) => {
      const session = s.sessions[e.sessionId]
      const pendingPermissions = dropPermissionsForSession(s.pendingPermissions, e.sessionId)
      const pendingQuestions = dropQuestionsForSession(s.pendingQuestions, e.sessionId)
      if (!session) {
        return {
          pendingPermissions,
          pendingQuestions,
          preparedSessions: dropPreparedSlots(s.preparedSessions, (sid) => sid === e.sessionId),
          ...dropSessionTranscriptState(s, e.sessionId)
        }
      }
      return {
        pendingPermissions,
        pendingQuestions,
        preparedSessions: dropPreparedSlots(s.preparedSessions, (sid) => sid === e.sessionId),
        sessions: {
          ...s.sessions,
          [e.sessionId]: {
            ...session,
            // Story 1.9 review: a session already in 'error' status (set by the
            // preceding _onAgentCrashed event) must NOT be overwritten to 'closed'
            // — keep the crash Error state visible (mirrors _onAgentDisconnected).
            status: session.status === 'error' ? session.status : 'closed',
            activeTurn: false,
            openTurnId: null,
            replaying: null
          }
        }
      }
    })
    // Persist while transcript maps still hold content, then free WebView heap.
    if (get().sessions[e.sessionId]) {
      persistSession(get(), e.sessionId, (entries) => set({ sessionIndex: entries }))
    }
    set((s) => dropSessionTranscriptState(s, e.sessionId))
    refreshHostOwnedIndex(get)
  }
})
