/**
 * Switch slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import { toast } from 'sonner'
import type { StateCreator } from 'zustand'
import type { PendingLauncherOptions } from '@/components/agents/pending-launcher-options'
import { buildHandoffSummary, sanitizeHandoffWireBlocks } from '@/components/chat/handoff-summary'
import {
  type AgentId,
  acpApi,
  acpRecordAgentSwitch,
  type ContentBlock,
  type SessionId,
  type ToolCall
} from '@/lib/acp-api'
import { type AgentSwitchRecord, maxPayloadSeq } from '@/lib/acp-history-persistence'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { agentChatTabId, findPaneContainingTab, useWorkspaceStore } from '@/stores/workspace-store'
import {
  acceptsSessionTranscriptEvents,
  appendOrderedAgents,
  configIdForAgentId,
  detachOldAgentForSwitch,
  killSpawnedAgentIfUnused,
  MAX_LIVE_TOOL_CALLS,
  setSwitchRejection,
  spliceSwitchTranscript,
  switchBlockedReason,
  trimLiveToolCalls
} from '../helpers'
import {
  ensureLiveAgent,
  handoffOnlyTurnIds,
  isHistoryCoveredEvent,
  liveSwitchSources,
  nextSeq,
  persistComposerOptions
} from '../shared-state'
import type { AcpState, ChatMessage } from '../types'
import { runPromptTurn } from './prompt'
import { flushCoalescedSync, trimLiveWindow } from './transcript'

/**
 * Story 3: sessions with an in-flight `switchAgent` execution. The staged
 * switch-on-send reads `switching` synchronously, so two rapid sends could
 * both observe the armed state before the first clears it (double spawn,
 * double marker, double remap). The guard rejects the second send while the
 * first execution runs.
 */
const inFlightAgentSwitches = new Set<SessionId>()

type SwitchSliceState = Pick<
  AcpState,
  | 'agentSwitches'
  | 'armAgentSwitch'
  | 'cancelAgentSwitch'
  | 'setSwitchPendingOption'
  | 'switchAgent'
  | '_onAgentSwitch'
>

export const createSwitchSlice: StateCreator<AcpState, [], [], SwitchSliceState> = (set, get) => ({
  agentSwitches: {},

  // --- Story 3: staged in-chat agent switch (spec-in-chat-agent-switch) ----

  armAgentSwitch: async (sessionId, toConfigId) => {
    const blocked = switchBlockedReason(get(), sessionId)
    if (blocked) {
      // Busy gate: surface the block on the old session's banner (never a
      // silent queue-jump); the draft stays intact.
      setSwitchRejection(set, sessionId, blocked)
      void logFrontendError({
        level: 'warn',
        source: 'acp.switchAgent.start',
        message: `Switch arm rejected for session ${sessionId} (busy gate) → config ${toConfigId}: ${blocked}`
      })
      return false
    }
    // Same-config switch is a no-op — reject at arm time with the banner
    // (the old agent keeps the chat; nothing to switch to).
    const currentConfigId =
      configIdForAgentId(get(), get().sessions[sessionId]?.agentId ?? '') ??
      get().sessionIndex.find((e) => e.id === sessionId)?.agentConfigId ??
      undefined
    if (toConfigId === currentConfigId) {
      setSwitchRejection(set, sessionId, 'that agent already owns this chat')
      return false
    }
    // Validate the target at ARM time (not first-send time): an unknown
    // config id would otherwise arm silently and blow up on send.
    if (!get().agentConfigs.some((c) => c.id === toConfigId)) {
      setSwitchRejection(set, sessionId, `unknown agent config ${toConfigId}`)
      void logFrontendError({
        level: 'warn',
        source: 'acp.switchAgent.start',
        message: `Switch arm rejected for session ${sessionId}: unknown config ${toConfigId}`
      })
      return false
    }
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) return {}
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, switching: { toConfigId, status: 'pending' } }
        }
      }
    })
    // Warm the target config (silent): while the switch is armed the composer
    // binds to the TARGET agent's advertised options — its prepared session
    // when this resolves, else `agentOptionsCache`. A prepare failure just
    // leaves the armed chips hidden; the armed banner is unchanged.
    const armedSession = get().sessions[sessionId]
    if (armedSession) {
      get().prepareChat(toConfigId, armedSession.cwd, undefined, armedSession.projectId, {
        silent: true
      })
    }
    return true
  },

  cancelAgentSwitch: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session?.switching) return {}
      return {
        sessions: { ...s.sessions, [sessionId]: { ...session, switching: null } }
      }
    })
  },

  setSwitchPendingOption: async (sessionId, patch) => {
    const session = get().sessions[sessionId]
    const switching = session?.switching
    if (!session || !switching) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.setSwitchPendingOption',
        message: `Dropped a composer pick for session ${sessionId}: no switch is armed`
      })
      return
    }
    // Once `switchAgent` is executing, the pick window has closed — the
    // armed options were already read for application to the new session, so
    // accepting a pick now would persist it but never apply it.
    if (inFlightAgentSwitches.has(sessionId)) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.setSwitchPendingOption',
        message: `Dropped a composer pick for session ${sessionId}: the agent switch is already executing`
      })
      return
    }
    const toConfigId = switching.toConfigId
    // Merge into the armed switch's pending options — the pick is queued for
    // the NEW session (`switchAgent` applies it), never written to the old
    // session's option state or its agent's wire.
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current?.switching) return {}
      const prev = current.switching.pendingOptions
      const pendingOptions: PendingLauncherOptions = {
        modelId: patch.modelId ?? prev?.modelId,
        modeId: patch.modeId ?? prev?.modeId,
        configValues: { ...prev?.configValues, ...patch.configValues }
      }
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...current,
            switching: { ...current.switching, pendingOptions }
          }
        }
      }
    })
    const hasPick =
      patch.modelId !== undefined ||
      patch.modeId !== undefined ||
      Object.keys(patch.configValues ?? {}).length > 0
    if (!hasPick) return
    void logFrontendError({
      level: 'info',
      source: 'acp.setSwitchPendingOption',
      message: `Queued switch pick on session ${sessionId} → config ${toConfigId}: model=${patch.modelId ?? '-'} mode=${patch.modeId ?? '-'} config=${Object.keys(patch.configValues ?? {}).join(',') || '-'}`
    })
    // The pick belongs to the agent that will own the next prompt — persist
    // it under the TARGET config (never the session's current owner).
    persistComposerOptions(toConfigId, {
      modelId: patch.modelId,
      modeId: patch.modeId,
      configValues: patch.configValues
    })
    // NOTE: the armed composer's displayed values come from the
    // `switching.pendingOptions` overlay (AgentChatPanel), so the pick is
    // NOT live-applied to the pooled warm session — a mutated pooled session
    // would leak the user's picks into an unrelated launch that claims it
    // after the switch is cancelled.
  },

  switchAgent: async (sessionId, toConfigId, pending) => {
    const oldSession = get().sessions[sessionId]
    if (!oldSession) throw new Error(`unknown session ${sessionId}`)
    // Double-send race guard: the second send while an execution is running
    // is ignored (the first owns the switch — its outcome is already decided).
    if (inFlightAgentSwitches.has(sessionId)) return
    inFlightAgentSwitches.add(sessionId)
    try {
      const cwd = oldSession.cwd
      const config = get().agentConfigs.find((c) => c.id === toConfigId)
      const oldConfigId =
        configIdForAgentId(get(), oldSession.agentId) ??
        get().sessionIndex.find((e) => e.id === sessionId)?.agentConfigId ??
        undefined
      const fromAgentName = get().agentConfigs.find((c) => c.id === oldConfigId)?.name ?? null

      void logFrontendError({
        level: 'info',
        source: 'acp.switchAgent.start',
        message: `Switching session ${sessionId} from config ${oldConfigId ?? '?'} to config ${toConfigId}`
      })

      const clearSwitching = (): void => {
        set((s) => {
          const session = s.sessions[sessionId]
          if (!session?.switching) return {}
          return {
            sessions: { ...s.sessions, [sessionId]: { ...session, switching: null } }
          }
        })
      }

      // Busy gate: refuse while a turn/queue/permission/question is live — no
      // spawn, no marker, no remap, draft intact (the banner carries the reason).
      const blocked = switchBlockedReason(get(), sessionId)
      if (blocked) {
        setSwitchRejection(set, sessionId, blocked)
        clearSwitching()
        void logFrontendError({
          level: 'warn',
          source: 'acp.switchAgent.failure',
          message: `Switch blocked for session ${sessionId} (busy gate) → config ${toConfigId}: ${blocked}`
        })
        return
      }
      if (!config) {
        setSwitchRejection(set, sessionId, `unknown agent config ${toConfigId}`)
        clearSwitching()
        void logFrontendError({
          level: 'warn',
          source: 'acp.switchAgent.failure',
          message: `Switch failed for session ${sessionId}: unknown config ${toConfigId}`
        })
        return
      }
      if (toConfigId === oldConfigId) {
        setSwitchRejection(set, sessionId, 'that agent already owns this chat')
        clearSwitching()
        return
      }

      // The pending user message: prefer the caller-provided wire/display pair
      // (the composer's submit seam already built them); fall back to deriving
      // the pair from `pendingText` so a bare `switchAgent` call still carries
      // the draft.
      const pendingText = pending?.pendingText ?? ''
      const pendingWireBlocks: ContentBlock[] =
        pending?.wireBlocks && pending.wireBlocks.length > 0
          ? pending.wireBlocks
          : pendingText.trim().length > 0
            ? [{ type: 'text', text: pendingText }]
            : []
      const pendingDisplayBlocks: ContentBlock[] =
        pending?.displayBlocks && pending.displayBlocks.length > 0
          ? pending.displayBlocks
          : pendingText.trim().length > 0
            ? [{ type: 'text', text: pendingText }]
            : []

      // Build the handoff from the old session's transcript (story 1). The
      // builder owns the wire contract: summary + '---' + sanitized pending
      // (sentinel-free) for a plain-text draft, and `displayBlocks` = the
      // pending draft only (the summary never renders as a user message).
      const handoff = buildHandoffSummary({
        messages: get().messages[sessionId] ?? [],
        toolCalls: get().toolCalls[sessionId] ?? [],
        agentName: fromAgentName,
        pendingText
      })
      let wireBlocks: ContentBlock[]
      if (pendingWireBlocks.length > 0) {
        // Caller supplied the composer's structured wire blocks (skills/file
        // pills/attachments): keep the structure — summary as its own text
        // block + the caller's blocks, their text fields swept sentinel-free by
        // the builder's own wire sanitizer; non-text blocks pass through.
        wireBlocks =
          handoff.summaryText.length > 0
            ? [
                { type: 'text', text: handoff.summaryText },
                ...sanitizeHandoffWireBlocks(pendingWireBlocks)
              ]
            : sanitizeHandoffWireBlocks(pendingWireBlocks)
      } else {
        // Plain-text (or empty) draft: the builder's own wireBlocks output is
        // the wire — summary + '---' + sanitized pending in one text block.
        wireBlocks = handoff.wireBlocks
      }
      const displayBlocks = pendingDisplayBlocks

      // Clear the old session's composer draft (CAP-3: the draft is the pending
      // user message, cleared from the old session's draft state).
      const draftKey = `chat-draft/${oldSession.projectId}/${sessionId}`
      void persistenceApi.delete(draftKey).catch(() => {})

      // Live merged transcript (spec-agent-switch-live-merged-transcript):
      // run the SAME splice the reopen redirect runs so the remapped tab's
      // first paint already shows old turns → the switch separator → the new
      // agent's turns — instead of a fresh empty pane. Renderer-only
      // projection: the durable model (marker on the OLD session's host log)
      // is unchanged, the copied records stay memory-only (every persistence
      // path round-trips the host), and the OLD session's slices are never
      // mutated (the reopen chain walk and its live-event handlers still
      // need them).
      //
      // Exactly one separator lands on the new timeline: a real record
      // already present on the OLD session (the `acp:agent_switch` fan-out
      // can beat the marker reply — EVENT_EARLY) rides the splice; otherwise
      // a fabricated marker joins the splice INPUT at the top of the old
      // band (seq = maxPayloadSeq + 1, mirroring the host's writer-assigned
      // next seq) so its re-stamped slot sits after every old record and
      // before every target record. Fabrication is pure projection — it
      // never depends on the durable write having succeeded (markerWarned
      // path still renders the separator).
      //
      // Re-entry (the dispatch-failure catch re-applies it) is a no-op: a
      // target-side record pointing at this new session means the splice
      // already ran — re-running would also steal late old-agent arrivals
      // into the new band, violating the live-event ownership contract.
      const spliceLiveSwitchTranscript = (targetId: SessionId): void => {
        // Drain buffered coalesced applies first: chunks queued for the OLD
        // session between the busy gate and this point must land in its
        // slices BEFORE the snapshot — a flush racing the splice would write
        // them onto the old session afterwards and the merged view would
        // silently drop pre-switch tail content until the next reopen.
        flushCoalescedSync()
        const pre = get()
        const targetSwitches = pre.agentSwitches[targetId] ?? []
        if (targetSwitches.some((sw) => sw.newSessionId === targetId)) {
          void logFrontendError({
            level: 'info',
            source: 'acp.switchAgent.splice',
            message: `Live switch splice for session ${targetId} already applied; skipping re-entry`
          })
          return
        }
        // Never grow transcript maps for a dead/missing session — the
        // dispatch-failure re-apply can run after the target record was
        // dropped mid-switch, and resurrecting an orphan band for a ghost id
        // violates the no-orphan-state invariant every other writer honors.
        // A host that ever answers createSession with the SOURCE id would
        // self-splice into a feedback loop — refuse that too.
        if (targetId === sessionId || !pre.sessions[targetId]) {
          void logFrontendError({
            level: 'warn',
            source: 'acp.switchAgent.splice',
            message: `Live switch splice skipped: target ${targetId} ${targetId === sessionId ? 'equals source session' : 'no longer exists'}`
          })
          return
        }
        // Normalize the live band to the shape the reopen path installs:
        // durable records never stream and never hold mid-flight tool
        // statuses (`structuralToolCall` forces those to 'failed'). The
        // copies outlive their source's event routing (`_onMessageChunk`/
        // `_onToolCall` key the OLD session id), so a copied streaming flag
        // or spinner would freeze forever.
        const sourceMessages = (pre.messages[sessionId] ?? []).map((m) =>
          m.streaming ? { ...m, streaming: false } : m
        )
        const sourceToolCalls = (pre.toolCalls[sessionId] ?? []).map((t) =>
          t.status === 'completed' || t.status === 'failed' ? t : { ...t, status: 'failed' }
        )
        const sourceSwitches = pre.agentSwitches[sessionId] ?? []
        const installedSwitches = sourceSwitches.some((sw) => sw.newSessionId === targetId)
          ? sourceSwitches
          : [
              ...sourceSwitches,
              fabricatedSwitchRecord(sourceMessages, sourceToolCalls, sourceSwitches, targetId)
            ]
        const spliced = spliceSwitchTranscript(
          sessionId,
          {
            messages: sourceMessages,
            toolCalls: sourceToolCalls,
            switches: installedSwitches
          },
          pre.messages[targetId] ?? [],
          pre.toolCalls[targetId] ?? [],
          targetSwitches
        )
        // Same trims the reopen path applies: a merged live list must
        // still fit the live window (the durable store owns the rest).
        set((s) => ({
          messages: {
            ...s.messages,
            [targetId]: trimLiveWindow(spliced.messages, targetId)
          },
          toolCalls: {
            ...s.toolCalls,
            [targetId]: trimLiveToolCalls(spliced.toolCalls)
          },
          agentSwitches: { ...s.agentSwitches, [targetId]: spliced.switches },
          // The conversation's sticky plan belongs to the merged view too —
          // after the remap the plan panel reads `plans[targetId]` and would
          // otherwise blank even though the plan fence renders in the copied
          // transcript bubble.
          plans: s.plans[sessionId] ? { ...s.plans, [targetId]: s.plans[sessionId] } : s.plans
        }))
        // Record the target→source link so an in-session wholesale reinstall
        // on the target (crash retry, direct history open, resume) can
        // re-splice the band — see `respliceLiveSwitchTarget`.
        liveSwitchSources.set(targetId, sessionId)
        void logFrontendError({
          level: 'info',
          source: 'acp.switchAgent.splice',
          message: `Spliced pre-switch transcript of session ${sessionId} into ${targetId}: ${sourceMessages.length} message(s), ${sourceToolCalls.length} tool call(s), ${installedSwitches.length - sourceSwitches.length === 1 ? 'fabricated switch marker' : 'real switch marker'}`
        })
      }

      /**
       * Marker for the live projection when the real record isn't on the
       * old session yet (durable write pending/failed or the event hasn't
       * arrived). Field parity with the host-written record (`newSessionId`
       * is what `resolveSwitchRedirect`/`_onAgentSwitch` dedup match on);
       * `seq` is the band top so the splice places it between old and new.
       */
      const fabricatedSwitchRecord = (
        bandMessages: ChatMessage[],
        bandToolCalls: ToolCall[],
        bandSwitches: AgentSwitchRecord[],
        targetId: SessionId
      ): AgentSwitchRecord => {
        const bandTop =
          maxPayloadSeq({
            messages: bandMessages,
            toolCalls: bandToolCalls,
            switches: bandSwitches
          }) + 1
        return {
          // `switch:fabricated:` — visibly NOT the host-written `switch:seq-*`
          // shape so no dedup/inspect path can mistake the projection for a
          // durable record (the host's real seq may differ: writer seqs cover
          // every record kind, not just renderer-visible ones).
          id: `switch:fabricated:${bandTop}`,
          fromConfigId: oldConfigId ?? '',
          toConfigId,
          newSessionId: targetId,
          summaryText: handoff.summaryText,
          timestamp: Date.now(),
          seq: bandTop
        }
      }

      let newAgentId: AgentId | null = null
      let newSessionId: SessionId | null = null
      try {
        // 1. Ensure a live agent for the target config (fresh spawn on a NEW
        //    configId; one-process-per-open-chat detaches same-config cases).
        newAgentId = await ensureLiveAgent(get, set, toConfigId, cwd)
        if (!newAgentId) throw new Error(`failed to spawn agent for config ${toConfigId}`)

        // 2. Create the new session on the new agent's process.
        newSessionId = await get().createSession(newAgentId, cwd, undefined, oldSession.projectId, {
          worktreePath: oldSession.worktreePath,
          worktreeBranch: oldSession.worktreeBranch
        })

        // 2b. Composer picks made while the switch was armed belong to the NEW
        //     session — apply before the handoff prompt so the target agent
        //     sees the armed-time selections from its first turn. Option
        //     failures are isolated inside applyPendingLauncherOptions (warn +
        //     continue), so an unadvertised pick can never fail the switch.
        // Re-read at apply time: `oldSession` was snapshotted before the
        // spawn + session/new awaits, and a pick landing in that window must
        // still reach the new session (further picks are then gated by the
        // in-flight guard in setSwitchPendingOption).
        const armedOptions = get().sessions[sessionId]?.switching?.pendingOptions
        if (armedOptions) {
          await get().applyPendingLauncherOptions(newSessionId, armedOptions)
        }

        // 3. Record the durable marker on the OLD session (after the new
        //    session id exists). Failure is NON-blocking: the conversation is
        //    already on the new agent — surfacing a warning and continuing
        //    beats stranding the user (CAP-7 reopen then falls back to the
        //    original agent for this chat).
        let markerWarned = false
        try {
          await acpRecordAgentSwitch(sessionId, {
            fromConfigId: oldConfigId ?? '',
            toConfigId,
            newSessionId,
            summaryText: handoff.summaryText
          })
        } catch (err) {
          markerWarned = true
          toast.warning('Could not save the switch marker', {
            description:
              'The conversation continues on the new agent, but reopening this chat reconnects to the original agent.'
          })
          void logFrontendError({
            level: 'warn',
            source: 'acp.switchAgent.failure',
            message: `Marker write failed for session ${sessionId} → config ${toConfigId}, new session ${newSessionId} (continuing without it): ${err instanceof Error ? err.message : String(err)}`
          })
        }
        // (markerWarned feeds only the success log below.)

        // 3b. Live merged transcript: splice the old session's live slices
        //     into the new session's BEFORE the remap paints, so the tab's
        //     first render under the new id already shows the whole
        //     conversation (old turns → switch separator → new turns). Same
        //     splice + trims as the reopen redirect — one ordering/id
        //     convention across live and reopened views.
        spliceLiveSwitchTranscript(newSessionId)

        // 4. Remap the tab old → new in the same pane (guarded: never add an
        //    uninvited tab when the old tab is gone).
        const ws = useWorkspaceStore.getState()
        if (findPaneContainingTab(ws.root, agentChatTabId(sessionId))) {
          ws.remapAgentChatSession(sessionId, newSessionId)
        }

        // 5. Dispatch the handoff prompt to the NEW session. `skipUserAppend`
        //    keeps the user bubble to the pending draft only (the summary
        //    travels on the wire, never rendered as a user message). An EMPTY
        //    draft (summary-only switch) appends NO user bubble: the re-stamp
        //    path finds no trailing user message on the fresh new session, so
        //    it appends one carrying the (empty) display blocks — ChatMessage
        //    renders nothing for an empty-block user message (no bubble: the
        //    text guard at ChatMessage.tsx, media absent), leaving the turn's
        //    response as the visible tail.
        if (wireBlocks.length > 0) {
          const switchedSessionId = newSessionId
          const switchedWireBlocks = wireBlocks
          await runPromptTurn(
            set,
            get,
            switchedSessionId,
            switchedWireBlocks,
            (session, turnId) => {
              // Summary-only dispatch (no draft): register the client-minted
              // turn id so `_onUserPrompt` skips the echo — the summary wire
              // must never render as a user bubble (the draft-carrying case
              // dedups against the optimistic draft bubble by id already).
              if (displayBlocks.length === 0) handoffOnlyTurnIds.add(turnId)
              const only = switchedWireBlocks.length === 1 ? switchedWireBlocks[0] : null
              if (only?.type === 'text' && typeof only.text === 'string') {
                // displayContent: the durable user_prompt persists only the
                // pending draft — the handoff summary travels on the wire but
                // must never replay as a transcript bubble (annotation #2).
                // Empty draft → pass undefined so the wire framing persists
                // and the strip drops the row on every consumer (an empty
                // array would persist a zero-block row that replays as a
                // ghost bubble and hides the handoff turn's reply).
                return acpApi.sendPrompt(
                  session.agentId,
                  switchedSessionId,
                  only.text,
                  turnId,
                  displayBlocks.length > 0 ? displayBlocks : undefined
                )
              }
              return acpApi.sendPromptBlocks(
                session.agentId,
                switchedSessionId,
                switchedWireBlocks,
                turnId,
                displayBlocks.length > 0 ? displayBlocks : undefined
              )
            },
            undefined,
            {
              skipUserAppend: true,
              displayBlocks
            }
          )
        }

        // 6. Detach the old agent's canonical reuse key (kill stays the idle
        //    reaper's decision — a live old session keeps its process).
        if (oldConfigId) {
          detachOldAgentForSwitch(set, oldConfigId, cwd, oldSession.agentId)
        }

        // 7. Ordered-agent cache on the index entry (append, consecutive-dedup).
        set((s) => ({
          sessionIndex: appendOrderedAgents(s, sessionId, oldConfigId, toConfigId)
        }))

        // 8. Clear the armed switch on the old session (the launchConfigId
        //    lifetime pattern: replaced/cleared on completion).
        clearSwitching()

        void logFrontendError({
          level: 'info',
          source: 'acp.switchAgent.success',
          message: `Switched session ${sessionId} (config ${oldConfigId ?? '?'}) to config ${toConfigId}, new session ${newSessionId}${markerWarned ? ' (marker write failed — non-blocking)' : ''}`
        })
      } catch (err) {
        // Dispatch-phase failure (step 5 threw AFTER the marker was recorded
        // and the tab remapped): the switch DURABLY happened — the new session
        // exists and owns the conversation. This is NOT a rollback: banner the
        // NEW (visible) session, still run the teardown/cache/clear steps, and
        // warn instead of failure. True rollbacks (banner on the old session,
        // kill the orphaned spawn) are spawn/new-session failures only.
        const dispatchTarget = newSessionId
        if (dispatchTarget) {
          // The merged transcript must still hold: the switch is durable once
          // the session exists. The splice normally ran before the remap, so
          // this re-apply is a no-op — it exists to keep the invariant if the
          // step order above ever changes.
          spliceLiveSwitchTranscript(dispatchTarget)
          set((s) => {
            const session = s.sessions[dispatchTarget]
            if (!session) return {}
            return {
              sessions: {
                ...s.sessions,
                [dispatchTarget]: {
                  ...session,
                  activeTurn: false,
                  openTurnId: null,
                  lastError: `Could not deliver the handoff prompt: ${err instanceof Error ? err.message : String(err)}`
                }
              }
            }
          })
          if (oldConfigId) {
            detachOldAgentForSwitch(set, oldConfigId, cwd, oldSession.agentId)
          }
          set((s) => ({
            sessionIndex: appendOrderedAgents(s, sessionId, oldConfigId, toConfigId)
          }))
          clearSwitching()
          void logFrontendError({
            level: 'warn',
            source: 'acp.switchAgent.failure',
            message: `Handoff dispatch failed for session ${sessionId} → config ${toConfigId}, new session ${newSessionId} (switch already durable): ${err instanceof Error ? err.message : String(err)}`
          })
          return
        }
        // Rollback: the ORIGINAL session stays live and usable (agent attached,
        // transcript intact, no marker recorded, `switching` cleared). Never
        // `status:'error'` on a live session — the banner carries the failure.
        clearSwitching()
        setSwitchRejection(set, sessionId, err instanceof Error ? err.message : String(err))
        // A spawn that produced no session/new left the freshly-spawned agent
        // orphaned — kill it only when it has no other sessions (it was
        // spawned for THIS switch).
        if (newAgentId && !newSessionId) {
          await killSpawnedAgentIfUnused(get, newAgentId)
        }
        void logFrontendError({
          source: 'acp.switchAgent.failure',
          message: `Switch failed for session ${sessionId} → config ${toConfigId}: ${err instanceof Error ? err.message : String(err)}`
        })
      }
    } finally {
      inFlightAgentSwitches.delete(sessionId)
    }
  },

  // CAP-2 (spec-in-chat-agent-switch): live `acp:agent_switch` marker. The
  // host emits it only AFTER the durable record is flushed; the watermark
  // guard drops replays the installed payload already covers. Two upsert
  // keys close the remaining reconnect hole: (a) the stable
  // `switch:seq-<seq>` id (same-seq re-emission), and (b) switch CONTENT
  // (toConfigId + newSessionId + summaryText) — a reload-resubscribed
  // client re-receives the live event at a NEW relay seq (assign_and_append
  // stamps every session-scoped emit; the durable record kept its own seq),
  // so the fabricated id differs from the payload-installed entry's id.
  // Content matching replaces that entry (keeping the installed id/seq —
  // the durable record is the timeline authority) instead of appending a
  // duplicate separator.
  _onAgentSwitch: (e, eventSeq) => {
    if (isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    set((s) => {
      if (!acceptsSessionTranscriptEvents(s.sessions[e.sessionId])) return {}
      const seq = typeof eventSeq === 'number' && Number.isFinite(eventSeq) ? eventSeq : nextSeq()
      const record: AgentSwitchRecord = {
        id: `switch:seq-${seq}`,
        fromConfigId: e.fromConfigId,
        toConfigId: e.toConfigId,
        newSessionId: e.newSessionId,
        summaryText: e.summaryText,
        timestamp: Date.now(),
        seq
      }
      const list = s.agentSwitches[e.sessionId] ?? []
      const idx = list.findIndex(
        (sw) =>
          sw.id === record.id ||
          (sw.toConfigId === record.toConfigId &&
            sw.newSessionId === record.newSessionId &&
            sw.summaryText === record.summaryText)
      )
      if (idx !== -1) {
        // Idempotent upsert: the latest fields win, placement stays, and
        // the matched entry keeps its durable id/seq + arrival timestamp.
        const next = [...list]
        next[idx] = {
          ...list[idx],
          ...record,
          id: list[idx].id,
          timestamp: list[idx].timestamp,
          seq: list[idx].seq
        }
        return { agentSwitches: { ...s.agentSwitches, [e.sessionId]: next } }
      }
      return {
        agentSwitches: {
          ...s.agentSwitches,
          [e.sessionId]: [...list, record].slice(-MAX_LIVE_TOOL_CALLS)
        }
      }
    })
  }
})
