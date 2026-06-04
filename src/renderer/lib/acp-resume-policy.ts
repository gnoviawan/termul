/**
 * Pure decision for how to reopen a persisted chat session (ADR-003.7).
 *
 * - 'load'   → agent connected and advertises `loadSession`: call session/load,
 *              the agent replays history via session/update.
 * - 'resume' → agent connected and advertises sessionCapabilities.resume.
 * - 'local'  → no connected agent or no capability: show the locally persisted
 *              transcript (read-only history).
 *
 * A gated command (load/resume) MUST NOT be attempted unless its capability is
 * present, so the decision encodes the capability check.
 */
import type { AgentCapabilities } from '@/lib/acp-api'

export type ResumeStrategy = 'load' | 'resume' | 'local'

export interface ResumeInput {
  connected: boolean
  capabilities: AgentCapabilities | null
}

export function decideResume({ connected, capabilities }: ResumeInput): ResumeStrategy {
  if (!connected || !capabilities) return 'local'
  if (capabilities.loadSession === true) return 'load'
  const resume = capabilities.sessionCapabilities?.resume
  if (resume !== undefined && resume !== null) return 'resume'
  return 'local'
}
