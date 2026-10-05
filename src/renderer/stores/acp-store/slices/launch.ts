/**
 * Launch slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import { toast } from 'sonner'
import type { StateCreator } from 'zustand'
import { acpApi, type ContentBlock, type SessionId } from '@/lib/acp-api'
import { agentPolicyForConfigId } from '@/lib/agents/acp-registry'
import {
  classifySetupError,
  formatAcpSpawnError,
  type PrepareChatError,
  SETUP_ERROR_LABELS
} from '@/lib/agents/acp-spawn-errors'
import { logFrontendError } from '@/lib/log-api'
import { pendingRestartVersionsAfterSpawn } from '../../agent-update-orchestration'
import {
  cacheOptionsFromSession,
  dropRecordKey,
  newId,
  prepareChatKey,
  reapOrphanPreparedSession
} from '../helpers'
import { isIndexedRealSession } from '../live-turn'
import {
  cancelledChatLaunches,
  ensureLiveAgent,
  ephemeralSessionIds,
  inFlightPrepared,
  inFlightPromotions,
  nextSeq,
  persistSession
} from '../shared-state'
import {
  type AcpSession,
  type AcpState,
  ChatLaunchCancelledError,
  type ChatMessage
} from '../types'
import { runPromptTurn } from './prompt'

function cancelPreparedChatEntry(
  key: string,
  set: (fn: (s: AcpState) => Partial<AcpState> | AcpState) => void
): void {
  // Drop the in-flight promise identity so a stale task cannot write results
  // or clear a newer prepare's preparingChatKeys in `finally`.
  inFlightPrepared.delete(key)
  set((s) => {
    if (
      !(key in s.preparedSessions) &&
      !(key in s.preparingChatKeys) &&
      !(key in s.prepareChatErrors)
    ) {
      return s
    }
    const preparedSessions = { ...s.preparedSessions }
    const preparingChatKeys = { ...s.preparingChatKeys }
    const prepareChatErrors = { ...s.prepareChatErrors }
    delete preparedSessions[key]
    delete preparingChatKeys[key]
    delete prepareChatErrors[key]
    return { preparedSessions, preparingChatKeys, prepareChatErrors }
  })
}

/**
 * Promote an ephemeral pooled session to a real (persisted) chat now that it is
 * actually consumed by `startChat`. Persisting here (not at prepare time) is
 * what keeps an unconsumed warm session from leaving an orphan "Untitled Chat"
 * on disk. Also clears the warm-slot lookup and refills one warm session for the
 * pool's target agent (default MCP only), so the next chat is instant too.
 *
 * Refill is gated by `selectedAgentConfigId` so callers that don't opt into the
 * warm pool (and the GH-288 reuse assertion of a single `acp_new_session` invoke)
 * never fire an extra session/new.
 */
function promotePreparedSession(
  key: string,
  sessionId: SessionId,
  projectId: string,
  get: () => AcpState,
  set: (fn: (s: AcpState) => Partial<AcpState> | AcpState) => void
): void {
  // Promoted: no longer an un-promoted pooled session — remove from the
  // ephemeral set so a later disconnect/close persists (not drops) it.
  ephemeralSessionIds.delete(sessionId)
  // Story 8: the session was created backend-ephemeral + promotable — fire
  // the backend promote (registers persistence metadata + clears the
  // ephemeral mark) and track it so `runPromptTurn` can await durability
  // before dispatching the first prompt. A failed promote is warn-logged and
  // non-fatal: the chat works, just non-durable.
  const promoteAgentId = get().sessions[sessionId]?.agentId
  if (promoteAgentId && !inFlightPromotions.has(sessionId)) {
    const promotion = acpApi
      .promoteSession(promoteAgentId, sessionId)
      .catch((err) => {
        console.warn('[acp] warm-pool session promotion failed (chat stays non-durable)', err)
        // Visible, not just logged: the chat works but its history will not
        // survive a reload, and the user deserves to know.
        toast.error('Chat history will not be saved for this session', {
          description: err instanceof Error ? err.message : String(err)
        })
        // Keep renderer behavior consistent with the backend reality: the
        // session is STILL backend-ephemeral, so close/disconnect must drop
        // (never persist) it — same as an un-promoted pooled session.
        ephemeralSessionIds.add(sessionId)
      })
      .finally(() => {
        inFlightPromotions.delete(sessionId)
      })
    inFlightPromotions.set(sessionId, promotion)
  }
  // Prepared keys exclude projectId; if projects share a cwd, the seed's
  // projectId would be wrong for the consumer — stamp the consuming project.
  set((s) => {
    const session = s.sessions[sessionId]
    if (!session) return {}
    // Claiming a prepared session is a user-facing chat — the applied
    // update is now live in that chat, so Restart can clear.
    const [kConfig] = key.split('\0')
    return {
      sessions: { ...s.sessions, [sessionId]: { ...session, projectId } },
      pendingRestartVersions: pendingRestartVersionsAfterSpawn(s, kConfig)
    }
  })
  persistSession(get(), sessionId, (entries) => set(() => ({ sessionIndex: entries })))
  cancelPreparedChatEntry(key, set)
  const state = get()
  // `key` is a prepareChatKey (`configId\0cwd\0mcpKey`) — not a reuse key.
  const [kConfig, kCwd, kMcp] = key.split('\0')
  if (
    kConfig === state.selectedAgentConfigId &&
    // S2-TS policy: agents with `isolateNewSessions` reset every session's
    // model in their process, so a pooled reseed would clobber the active
    // chat — skip the warm-pool reseed for them (Factory Droid).
    agentPolicyForConfigId(kConfig).auth.isolateNewSessions !== true &&
    !kMcp
  ) {
    void state.prepareChat(kConfig, kCwd, undefined, projectId, { silent: true })
  }
}

type LaunchSliceState = Pick<
  AcpState,
  | 'preparedSessions'
  | 'preparingChatKeys'
  | 'prepareChatErrors'
  | 'cancelPreparedChat'
  | 'prepareChat'
  | 'startChat'
  | 'claimPreparedChat'
  | 'createLaunchPlaceholder'
  | 'discardLaunchPlaceholder'
  | 'seedLaunchUserMessage'
  | 'clearLaunchingSession'
  | 'applyPendingLauncherOptions'
  | 'finalizeChatLaunch'
>

export const createLaunchSlice: StateCreator<AcpState, [], [], LaunchSliceState> = (set, get) => ({
  /** Prepared `session/new` results keyed by {@link prepareChatKey}. */
  preparedSessions: {},
  preparingChatKeys: {},
  prepareChatErrors: {},

  cancelPreparedChat: (key) => {
    // A prepared session was created via `createSession` — a live backend
    // session that is backend-EPHEMERAL since story 8 (nothing persisted).
    // When the user abandons it (dialog closed / inputs changed) we must tear
    // it down, not just drop the lookup entry.
    const sessionId = get().preparedSessions[key]
    cancelPreparedChatEntry(key, set)
    if (!sessionId) return
    // If the user already navigated to this session, don't reap it.
    if (get().activeSessionId === sessionId) return
    // A prepare cancel must not close or delete a chat that already has a
    // persisted history row (issue #882). Warm-pool ids are not indexed.
    if (isIndexedRealSession(get().sessionIndex, sessionId)) {
      ephemeralSessionIds.delete(sessionId)
      void logFrontendError({
        level: 'warn',
        source: 'acp.cancelPreparedChat',
        message: `Skipped teardown of indexed session ${sessionId}; prepare cancel must not close or delete a persisted chat`
      })
      return
    }
    void get()
      .closeSession(sessionId)
      .catch(() => {
        /* best-effort: backend may already be gone */
      })
      .finally(() => {
        void get().deleteHistorySession(sessionId)
      })
  },

  prepareChat: (configId, cwd, mcpServers, projectId, opts) => {
    const trimmedCwd = cwd.trim()
    if (!configId || trimmedCwd.length === 0) return
    const key = prepareChatKey(configId, trimmedCwd, mcpServers)
    if (get().preparedSessions[key] || inFlightPrepared.has(key)) return
    set((s) => {
      const prepareChatErrors = { ...s.prepareChatErrors }
      delete prepareChatErrors[key]
      return {
        preparingChatKeys: { ...s.preparingChatKeys, [key]: true },
        prepareChatErrors
      }
    })

    // Register the promise before any await so cancel/reopen can replace it
    // atomically and stale tasks can detect they are no longer current.
    let settle!: (value: SessionId | null) => void
    const task = new Promise<SessionId | null>((resolve) => {
      settle = resolve
    })
    inFlightPrepared.set(key, task)

    void (async (): Promise<void> => {
      try {
        const agentId = await ensureLiveAgent(get, set, configId, trimmedCwd)
        if (inFlightPrepared.get(key) !== task) {
          settle(null)
          return
        }
        if (!agentId) {
          if (inFlightPrepared.get(key) === task) {
            const config = get().agentConfigs.find((c) => c.id === configId)
            // Classify the spawn failure so the launcher renders a category
            // label (consistent with the catch path); only toast when
            // user-initiated (pool seeds stay silent).
            const classified: PrepareChatError = {
              category: 'spawn',
              label: SETUP_ERROR_LABELS.spawn,
              detail: formatAcpSpawnError(
                new Error(`failed to spawn agent for config ${configId}`),
                config
              )
            }
            set((s) => ({
              prepareChatErrors: { ...s.prepareChatErrors, [key]: classified }
            }))
            if (!opts?.silent) toast.error(classified.detail)
          }
          settle(null)
          return
        }
        // Story 8: the warm session is backend-ephemeral (never persisted —
        // no per-boot junk "Untitled Chat") + promotable (plan tool injected;
        // `promote_session` on claim makes it durable before the first
        // prompt).
        const sessionId = await get().createSession(agentId, trimmedCwd, mcpServers, projectId, {
          ephemeral: true,
          backendEphemeral: true,
          promotable: true
        })
        // Disconnect race: if the agent died mid-prepare, don't register a dead
        // session — drop it (createSession added it to `ephemeralSessionIds`) and
        // bail so the pool re-seeds lazily on the next chat (re-spawn + refill).
        if (get().agentStatus[agentId] !== 'connected') {
          if (ephemeralSessionIds.has(sessionId)) {
            ephemeralSessionIds.delete(sessionId)
            set((s) => {
              if (!s.sessions[sessionId]) return s
              const sessions = { ...s.sessions }
              delete sessions[sessionId]
              return { sessions }
            })
          }
          settle(null)
          return
        }
        // Task-identity guard: cancel deletes the map entry; a newer prepare
        // replaces it. Either way the stale task must not write results.
        if (inFlightPrepared.get(key) !== task) {
          reapOrphanPreparedSession(get, set, sessionId)
          settle(null)
          return
        }
        if (prepareChatKey(configId, trimmedCwd, mcpServers) !== key) {
          reapOrphanPreparedSession(get, set, sessionId)
          settle(null)
          return
        }
        set((s) => ({
          preparedSessions: { ...s.preparedSessions, [key]: sessionId }
        }))
        // createSession already wrote the options cache when possible; refresh
        // from the live session in case events enriched modes/models.
        cacheOptionsFromSession(set, get, sessionId)
        settle(sessionId)
      } catch (err) {
        console.warn('[acp] prepareChat failed', configId, err)
        if (inFlightPrepared.get(key) === task) {
          const config = get().agentConfigs.find((c) => c.id === configId)
          // Classify from the RAW error (P4) so the launcher can render a
          // category-specific label/action; `detail` carries the friendly text.
          const classified = classifySetupError(err, config)
          set((s) => ({
            prepareChatErrors: { ...s.prepareChatErrors, [key]: classified }
          }))
          // A spawn (missing binary) failure is the only one worth a toast; the
          // rest are surfaced inline on the model picker (auth needs Sign-in, a
          // multi-method agent has no useful retry, etc.). Pool seeds stay
          // silent so a failing agent doesn't spam on startup.
          if (classified.category === 'spawn' && !opts?.silent) toast.error(classified.detail)
        }
        settle(null)
      } finally {
        // Only this task may clear preparing / in-flight state.
        if (inFlightPrepared.get(key) === task) {
          inFlightPrepared.delete(key)
          set((s) => {
            const preparingChatKeys = { ...s.preparingChatKeys }
            delete preparingChatKeys[key]
            return { preparingChatKeys }
          })
        }
      }
    })()
  },

  startChat: async (configId, cwd, mcpServers, projectId, opts) => {
    const trimmedCwd = cwd.trim()
    const config = get().agentConfigs.find((c) => c.id === configId)
    if (!config) throw new Error(`unknown agent config ${configId}`)
    const key = prepareChatKey(configId, trimmedCwd, mcpServers)
    // Loop so a cancelled in-flight prepare that returns null can pick up a
    // newer prepare that started during the await (cancel+reopen race).
    for (;;) {
      const prepared = get().preparedSessions[key]
      if (prepared) {
        promotePreparedSession(key, prepared, projectId, get, set)
        return prepared
      }
      const inFlight = inFlightPrepared.get(key)
      if (!inFlight) break
      const sessionId = await inFlight
      if (sessionId) {
        promotePreparedSession(key, sessionId, projectId, get, set)
        return sessionId
      }
      // null: cancelled or failed — re-check for a newer prepare before spawning.
    }
    const agentId = await ensureLiveAgent(get, set, configId, trimmedCwd)
    if (!agentId) throw new Error(`failed to spawn agent for config ${configId}`)
    return get().createSession(agentId, trimmedCwd, mcpServers, projectId, opts)
  },

  claimPreparedChat: (key, projectId) => {
    const sessionId = get().preparedSessions[key]
    if (!sessionId) return null
    promotePreparedSession(key, sessionId, projectId, get, set)
    return sessionId
  },

  createLaunchPlaceholder: ({
    cwd,
    projectId,
    models,
    modes,
    configOptions,
    initialUserBlocks,
    worktreePath,
    worktreeBranch,
    worktreeProgressId
  }) => {
    const sessionId = newId('launch')
    const blocks = initialUserBlocks ?? []
    const openTurnId = blocks.length > 0 ? newId('turn') : null
    const userMessage: ChatMessage | null =
      blocks.length > 0
        ? {
            id: newId('msg'),
            role: 'user',
            blocks,
            streaming: false,
            timestamp: Date.now(),
            seq: nextSeq()
          }
        : null
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          id: sessionId,
          agentId: '',
          cwd,
          projectId,
          status: 'initializing',
          title: null,
          activeTurn: Boolean(userMessage),
          openTurnId,
          modes: modes ?? null,
          models: models ?? null,
          configOptions: configOptions ?? [],
          lastError: null,
          createdAt: Date.now(),
          replaying: null,
          worktreePath,
          worktreeBranch,
          worktreeProgressId
        }
      },
      messages: {
        ...s.messages,
        [sessionId]: userMessage ? [userMessage] : (s.messages[sessionId] ?? [])
      },
      launchingSessionIds: { ...s.launchingSessionIds, [sessionId]: true }
    }))
    return sessionId
  },

  discardLaunchPlaceholder: (sessionId) => {
    set((s) => {
      if (!s.launchingSessionIds[sessionId] && !s.sessions[sessionId]) return s
      const sessions = { ...s.sessions }
      const messages = { ...s.messages }
      const launchingSessionIds = { ...s.launchingSessionIds }
      delete sessions[sessionId]
      delete messages[sessionId]
      delete launchingSessionIds[sessionId]
      return {
        sessions,
        messages,
        launchingSessionIds,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId
      }
    })
  },

  seedLaunchUserMessage: (sessionId, blocks) => {
    if (blocks.length === 0) return
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current || current.status === 'closed') return s
      if ((s.messages[sessionId] ?? []).some((m) => m.role === 'user')) {
        return {
          launchingSessionIds: { ...s.launchingSessionIds, [sessionId]: true },
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...current,
              activeTurn: true,
              openTurnId: current.openTurnId ?? newId('turn'),
              lastError: null
            }
          }
        }
      }
      const userMessage: ChatMessage = {
        id: newId('msg'),
        role: 'user',
        blocks,
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
          [sessionId]: {
            ...current,
            activeTurn: true,
            openTurnId: newId('turn'),
            lastError: null
          }
        },
        launchingSessionIds: { ...s.launchingSessionIds, [sessionId]: true }
      }
    })
  },

  clearLaunchingSession: (sessionId) => {
    set((s) => {
      if (!s.launchingSessionIds[sessionId]) return s
      const launchingSessionIds = { ...s.launchingSessionIds }
      delete launchingSessionIds[sessionId]
      return { launchingSessionIds }
    })
  },

  applyPendingLauncherOptions: async (sessionId, pending) => {
    if (!pending) return
    // Re-read the session per step: earlier applies (and concurrent events)
    // may have changed the advertised options, and the session may have closed.
    const live = (): AcpSession | undefined => get().sessions[sessionId]
    if (!live() || live()?.status === 'closed') return
    // Per-option failure isolation: a rejected option logs a warn and the
    // remaining options still apply — one bad pick must never abort the rest
    // or fail the launch/switch that called this.
    const warnOptionFailure = (label: string, err: unknown): void => {
      void logFrontendError({
        level: 'warn',
        source: 'acp.applyPendingLauncherOptions',
        message: `Skipping option '${label}' on session ${sessionId} after apply failure: ${err instanceof Error ? err.message : String(err)}`
      })
    }
    if (pending.modeId) {
      const session = live()
      // Skip the wire call when the session already shows this mode.
      if (
        session &&
        session.status !== 'closed' &&
        session.modes?.currentModeId !== pending.modeId
      ) {
        try {
          await get().setMode(sessionId, pending.modeId)
        } catch (err) {
          warnOptionFailure('mode', err)
        }
      }
    }
    const sessionAfterMode = live()
    const modelConfigOption = sessionAfterMode?.configOptions.find((o) => o.category === 'model')
    let modelConfigIdHandled: string | null = null
    if (pending.modelId) {
      // Already-current fast path, keyed on the DISPLAYED model
      // (`resolveModelOption` precedence: the model config option when one is
      // advertised, else the native models state). A config-option match is
      // authoritative for display, so a divergent `models` projection alone
      // doesn't re-trigger the wire call.
      const displayedModel = modelConfigOption
        ? modelConfigOption.currentValue
        : sessionAfterMode?.models?.currentModelId
      let applied = displayedModel === pending.modelId
      if (applied && modelConfigOption) modelConfigIdHandled = modelConfigOption.id
      if (!applied && sessionAfterMode && sessionAfterMode.status !== 'closed') {
        if (sessionAfterMode.models) {
          try {
            await get().setModel(sessionId, pending.modelId)
            applied = true
            // `models` can be a projection of the same config option. When so,
            // applying the model above already handled this launcher value.
            modelConfigIdHandled = modelConfigOption?.id ?? null
          } catch {
            // native setModel rejected; fall through to a model config option
          }
        }
        if (!applied && modelConfigOption) {
          try {
            await get().setConfigOption(sessionId, modelConfigOption.id, pending.modelId)
            applied = true
            modelConfigIdHandled = modelConfigOption.id
          } catch (err) {
            warnOptionFailure(modelConfigOption.id, err)
          }
        }
        if (!applied) {
          toast.error('Selected model is not available in this session', {
            description: `The model "${pending.modelId}" is not advertised by the agent and no model config option exists. Falling back to the agent's default model.`
          })
        }
      }
    }
    for (const [configId, valueId] of Object.entries(pending.configValues)) {
      if (configId === modelConfigIdHandled) continue
      const session = live()
      if (!session || session.status === 'closed') return
      const option = session.configOptions.find((o) => o.id === configId)
      // Skip ids the session doesn't advertise — stale/retired values in the
      // snapshot must not fire a doomed wire call on every launch.
      if (!option) {
        warnOptionFailure(configId, new Error('option is not advertised by this session'))
        continue
      }
      // Skip already-current values — picks that were flushed live to a warm
      // session earlier must not fire redundant wire calls on the claimed
      // session.
      if (option.currentValue === valueId) continue
      try {
        await get().setConfigOption(sessionId, configId, valueId)
      } catch (err) {
        warnOptionFailure(configId, err)
      }
    }
  },

  finalizeChatLaunch: async ({
    placeholderId,
    configId,
    cwd,
    projectId,
    mcpServers,
    pending,
    initialText,
    initialBlocks,
    adoptSession,
    worktreePath,
    worktreeBranch
  }) => {
    // Retained outside the try so a post-create failure (option application /
    // first-prompt send) still targets the real session after the merge has
    // already deleted the placeholder.
    let launchedSessionId: SessionId | null = null
    try {
      const sessionId = await get().startChat(configId, cwd, mcpServers, projectId, {
        worktreePath,
        worktreeBranch
      })
      launchedSessionId = sessionId
      // Cancellation tombstone: the failed chat was deleted from history
      // while startChat was in flight — the user revoked the launch. Tear
      // down the just-created session instead of merging the deleted
      // placeholder's transcript into it and sending its prompt (which would
      // resurrect a ghost chat the user explicitly discarded).
      if (cancelledChatLaunches.delete(placeholderId)) {
        void logFrontendError({
          level: 'warn',
          source: 'acp.finalizeChatLaunch.cancelled',
          message: `Chat launch for ${placeholderId} cancelled by deletion; tearing down late session ${sessionId}`
        })
        set((s) => ({
          launchingSessionIds: dropRecordKey(s.launchingSessionIds, placeholderId)
        }))
        await get().closeSession(sessionId)
        await get().deleteHistorySession(sessionId)
        throw new ChatLaunchCancelledError(placeholderId)
      }

      // Move optimistic UI onto the real session, then remap the tab before send
      // so the user stays on one chat (never a blank disconnected placeholder).
      const hadOptimisticUser = (get().messages[placeholderId] ?? []).some((m) => m.role === 'user')
      if (sessionId !== placeholderId) {
        set((s) => {
          const placeholder = s.sessions[placeholderId]
          const real = s.sessions[sessionId]
          if (!real) return s
          const placeholderMessages = s.messages[placeholderId] ?? []
          const realMessages = s.messages[sessionId] ?? []
          const messages = { ...s.messages }
          const sessions = { ...s.sessions }
          const launchingSessionIds = { ...s.launchingSessionIds }
          messages[sessionId] = realMessages.length > 0 ? realMessages : placeholderMessages
          if (placeholder) {
            sessions[sessionId] = {
              ...real,
              activeTurn: placeholder.activeTurn || real.activeTurn,
              openTurnId: real.openTurnId ?? placeholder.openTurnId,
              title: real.title ?? placeholder.title,
              modes: real.modes ?? placeholder.modes,
              models: real.models ?? placeholder.models,
              configOptions:
                real.configOptions.length > 0
                  ? real.configOptions
                  : (placeholder.configOptions ?? []),
              worktreePath: real.worktreePath ?? placeholder.worktreePath,
              worktreeBranch: real.worktreeBranch ?? placeholder.worktreeBranch,
              worktreeProgressId: real.worktreeProgressId ?? placeholder.worktreeProgressId
            }
          }
          delete sessions[placeholderId]
          delete messages[placeholderId]
          delete launchingSessionIds[placeholderId]
          return {
            sessions,
            messages,
            launchingSessionIds,
            activeSessionId: s.activeSessionId === placeholderId ? sessionId : s.activeSessionId,
            // Drop the placeholder's failed-launch index projection (if any) so
            // a successful (re)try never leaves a "Failed" row behind.
            sessionIndex: s.sessionIndex.some((e) => e.id === placeholderId)
              ? s.sessionIndex.filter((e) => e.id !== placeholderId)
              : s.sessionIndex
          }
        })
        adoptSession?.(placeholderId, sessionId)
      } else {
        set((s) => {
          if (!s.launchingSessionIds[placeholderId]) return s
          const launchingSessionIds = { ...s.launchingSessionIds }
          delete launchingSessionIds[placeholderId]
          return { launchingSessionIds }
        })
      }

      await get().applyPendingLauncherOptions(sessionId, pending)

      const blocks =
        initialBlocks && initialBlocks.length > 0
          ? initialBlocks
          : initialText && initialText.trim().length > 0
            ? ([{ type: 'text', text: initialText }] as ContentBlock[])
            : null
      if (blocks) {
        await runPromptTurn(
          set,
          get,
          sessionId,
          blocks,
          (session, turnId) => {
            const only = blocks.length === 1 ? blocks[0] : null
            if (only?.type === 'text' && typeof only.text === 'string') {
              return acpApi.sendPrompt(session.agentId, sessionId, only.text, turnId)
            }
            return acpApi.sendPromptBlocks(session.agentId, sessionId, blocks, turnId)
          },
          undefined,
          { skipUserAppend: hadOptimisticUser }
        )
      }
      return sessionId
    } catch (err) {
      // Cancellation bypasses failure stamping entirely: the user deleted the
      // chat mid-launch, so there is nothing to re-mark 'error'.
      if (err instanceof ChatLaunchCancelledError) throw err
      // Deleted mid-launch AND the create itself failed: skip resurrecting the
      // discarded chat as a failed index entry — report cancellation instead.
      if (cancelledChatLaunches.delete(placeholderId)) {
        set((s) => ({
          launchingSessionIds: dropRecordKey(s.launchingSessionIds, placeholderId)
        }))
        throw new ChatLaunchCancelledError(placeholderId)
      }
      // Create-phase failure (placeholder still alive): record the launch
      // config so Retry (`retryFailedLaunch`) can re-run prepare without the
      // launcher, and project the failed launch into the local session index
      // so the sidebar lists it (with a "Failed" badge) instead of "No chats
      // yet" while the dead tab is open. In-memory only — a failed create has
      // no host session, so there is nothing to persist durably (history stays
      // host-owned).
      //
      // Prompt-phase failure (startChat succeeded; the merge already replaced
      // the placeholder with the real host session): keep the pre-existing raw
      // lastError stamping and skip the launchConfigId + index projection —
      // the real session already has its index entry from createSession, and
      // its retry stays on the retryCrashedSession reopen path so no orphan
      // host session is created.
      const placeholderAlive = Boolean(get().sessions[placeholderId])
      // Actionable banner text: the additive `agent_auth_required` wire code /
      // `ACP_AUTH_REQUIRED` prefix classifies as auth (sign-in guidance); any
      // other failure keeps the generic setup classification (config-aware, so
      // ENOENT spawn failures produce command-specific guidance). Old servers
      // that send neither fall through to the same generic path as before.
      const classified = classifySetupError(
        err,
        get().agentConfigs.find((c) => c.id === configId)
      )
      // Target the placeholder while it still exists; after the merge it is
      // gone, so target the retained launched session instead. Never fall back
      // to activeSessionId — the user may have focused another chat mid-launch
      // and stamping it would mislabel an unrelated session. When neither id
      // is available (e.g. the user closed the tab before startChat settled),
      // skip the mutation entirely and only drop the launching flag.
      const failedId = placeholderAlive ? placeholderId : launchedSessionId
      set((s) => {
        const launchingSessionIds = dropRecordKey(s.launchingSessionIds, placeholderId)
        if (!failedId) return { launchingSessionIds }
        const target = s.sessions[failedId]
        if (!target) return { launchingSessionIds }
        return {
          sessions: {
            ...s.sessions,
            [failedId]: {
              ...target,
              status: 'error',
              activeTurn: false,
              openTurnId: null,
              lastError: placeholderAlive
                ? `${classified.label}: ${classified.detail}`
                : err instanceof Error
                  ? err.message
                  : String(err),
              ...(placeholderAlive
                ? { launchConfigId: configId, pendingLauncherOptions: pending ?? null }
                : {})
            }
          },
          launchingSessionIds: dropRecordKey(launchingSessionIds, failedId)
        }
      })
      if (placeholderAlive && failedId) {
        persistSession(get(), failedId, (entries) => set({ sessionIndex: entries }))
      }
      throw err
    }
  }
})
