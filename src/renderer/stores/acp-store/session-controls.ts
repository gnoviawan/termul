import { alignSessionModelProjection } from '@/components/chat/chat-input-bar-config'
import type { SessionId } from '@/lib/acp-api'
import type { SessionPayload } from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import type { ReopenControlBaseline } from './types'

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
