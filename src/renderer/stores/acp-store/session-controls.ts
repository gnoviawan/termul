import {
  optionsToPending,
  type PendingLauncherOptions
} from '@/components/agents/pending-launcher-options'
import {
  alignSessionModelProjection,
  flattenConfigOptionValues,
  MODEL_CATEGORY,
  sessionModelSnapshot
} from '@/components/chat/chat-input-bar-config'
import type { SessionId } from '@/lib/acp-api'
import type { SessionPayload } from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import { endRestoreUserPicks, reopenRestores, scopedValues } from './composer-options'
import type { AcpState, ReopenControlBaseline } from './types'

/**
 * The model, mode, and config controls a reopened session starts with. Each
 * control the client already holds wins: it is at least as new as the
 * payload. A control the client lacks (all of them after a page reload) comes
 * from the host payload, so a chat reattached mid-turn shows its models
 * instead of "no model choice" until an agent update arrives.
 */
export function resolveReopenControls(
  sessionId: SessionId,
  held: ReopenControlBaseline | null,
  payload: SessionPayload
): ReopenControlBaseline {
  const heldOptions = held?.configOptions ?? []
  const payloadModes = held?.modes ? null : (payload.modes ?? null)
  const payloadModels = held?.models ? null : (payload.models ?? null)
  const payloadOptions = heldOptions.length > 0 ? [] : (payload.configOptions ?? [])
  const controls: ReopenControlBaseline = {
    modes: held?.modes ?? payloadModes,
    models: held?.models ?? payloadModels,
    configOptions: payloadOptions.length > 0 ? payloadOptions : heldOptions
  }
  if (!payloadModes && !payloadModels && payloadOptions.length === 0) return controls
  void logFrontendError({
    level: 'info',
    source: 'acp.reopenControls',
    message: `Restored controls for session ${sessionId} from the history payload (seq ${payload.controlsSeq ?? 'unknown'}: ${payloadOptions.length} config options, ${payloadModels?.availableModels.length ?? 0} models, ${payloadModes?.availableModes.length ?? 0} modes)`
  })
  return alignSessionModelProjection(controls)
}

/**
 * The model and scoped option values a reopened chat last ran, or null when it
 * stored none. Mode is agent-level and not part of it.
 */
export function reopenedChatSelection(
  controls: ReopenControlBaseline
): PendingLauncherOptions | null {
  const { modelId, configValues } = optionsToPending({
    models: controls.models,
    modes: controls.modes,
    configOptions: controls.configOptions
  })
  const scoped = scopedValues(configValues, controls.configOptions)
  if (!modelId && Object.keys(scoped).length === 0) return null
  return { modelId, configValues: scoped }
}

/**
 * Put a reopened chat back on its own model, then its values, after the
 * agent's reopen reply (which may report the agent's defaults). A model the
 * agent no longer offers is skipped together with its values, and the chat
 * keeps the agent's model. A restore: the agent's saved record is left alone
 * and a user change made meanwhile wins. The chat is marked restored once its
 * model is back (or kept because it is gone).
 */
export async function restoreReopenedChatSelection(
  get: () => AcpState,
  sessionId: SessionId,
  selection: PendingLauncherOptions
): Promise<void> {
  const session = get().sessions[sessionId]
  if (session?.status !== 'active') return
  const { modelId } = selection
  if (modelId) {
    const modelOption = session.configOptions.find((o) => o.category === MODEL_CATEGORY)
    const offered = modelOption
      ? flattenConfigOptionValues(modelOption).some((v) => v.value === modelId)
      : (session.models?.availableModels.some((m) => m.modelId === modelId) ?? false)
    if (!offered) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.reopenSelection',
        message: `Session ${sessionId} reopened without its last model: the agent no longer offers it; kept the agent's model and values`
      })
      // Keep the agent's model: the agent-wide reapply must not move it either.
      reopenRestores.set(sessionId, 'restored')
      return
    }
  }
  reopenRestores.set(sessionId, 'restoring')
  let restored = false
  try {
    await get().applyPendingLauncherOptions(sessionId, selection, { restore: true })
    const live = get().sessions[sessionId]
    restored = live != null && (!modelId || sessionModelSnapshot(live)?.modelId === modelId)
  } finally {
    endRestoreUserPicks(sessionId)
    // A session removed meanwhile has dropped its mark; leave it dropped.
    if (reopenRestores.get(sessionId) === 'restoring') {
      if (restored) reopenRestores.set(sessionId, 'restored')
      else reopenRestores.delete(sessionId)
    }
  }
  if (!restored) return
  void logFrontendError({
    level: 'info',
    source: 'acp.reopenSelection',
    message: `Restored the last model and ${Object.keys(selection.configValues).length} option value(s) on reopened session ${sessionId}`
  })
}
