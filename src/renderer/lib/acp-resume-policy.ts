/**
 * Pure decision for how to reopen a persisted chat session (ADR-003.7).
 *
 * - 'resume' → agent connected and advertises `sessionCapabilities.resume`.
 *              Local history is already stored, so resume reconnects without
 *              a full replay. `loadSession` does not override this.
 * - 'load'   → resume is absent and the agent advertises `loadSession`.
 * - 'local'  → no connected agent or no capability: show the locally persisted
 *              transcript (read-only history).
 *
 * A gated command (load/resume) MUST NOT be attempted unless its capability is
 * present, so the decision encodes the capability check.
 */
import type { AgentCapabilities } from '@/lib/acp-api'
import { AcpTransportError } from '@/lib/acp-transport/types'

export type ResumeStrategy = 'load' | 'resume' | 'local'

export interface ResumeInput {
  connected: boolean
  capabilities: AgentCapabilities | null
}

export function decideResume({ connected, capabilities }: ResumeInput): ResumeStrategy {
  if (!connected || !capabilities) return 'local'
  const resume = capabilities.sessionCapabilities?.resume
  if (resume !== undefined && resume !== null) return 'resume'
  if (capabilities.loadSession === true) return 'load'
  return 'local'
}

/**
 * True when `session/resume` failed because the agent has no such session.
 * Auth failures, turn conflicts, and timeouts are not a missing session.
 */
export function resumeMissesSession(error: unknown): boolean {
  if (error instanceof AcpTransportError) {
    const code = error.code.toLowerCase()
    if (code === 'timeout' || code === 'closed' || code === 'agent_crashed') return false
    if (code.includes('auth') || code.includes('turn_active')) return false
    if (code === 'not_found' || code === 'session_not_found') return true
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes('acp_auth_required')) return false
  if (message.includes('acp_reopen_turn_active')) return false
  if (message.includes('timed out') || message.includes('timeout')) return false
  return (
    message.includes('session not found') ||
    message.includes('no such session') ||
    message.includes('unknown session') ||
    message.includes('session does not exist') ||
    message.includes('session_not_found')
  )
}
