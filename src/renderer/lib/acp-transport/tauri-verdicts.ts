/**
 * Desktop command verdicts (AD-5). A Tauri `acp_*` command cannot return a
 * receipt, so the host reports a ledger verdict as an ERROR STRING with a
 * stable prefix. This maps those strings to the same typed
 * {@link AcpTransportError} codes the `/ws` carrier uses, so the command
 * engine classifies both carriers identically:
 *
 * - `outcome_unknown:`     → `outcome_unknown` (uncertain: never rejected)
 * - `command_in_progress:` → `command_in_progress` (uncertain: still running)
 * - `command_conflict:`    → `command_conflict` (definite)
 * - `invalid_command_id:`  → `invalid_command_id` (definite)
 * - `command_accepted:`    → `command_accepted` (the command ran; no payload)
 * - `ACP_AGENT_UNAVAILABLE:` / `ACP_INVALID_AGENT_CONFIG:` → `agent_unavailable`
 *   / `invalid_agent_config` (definite spawn rejections, never auto-retried)
 *
 * The prefix is stripped from the message the user reads. Anything else is
 * returned untouched.
 */

import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { AcpTransportError, COMMAND_ACCEPTED_CODE, COMMAND_IN_PROGRESS_CODE } from './types'

/**
 * The deterministic spawn rejections (`/ws` code, desktop message prefix).
 * The single table both this mapper and `agents/acp-spawn-errors.ts` read.
 */
export const DEFINITE_SPAWN_REJECTIONS: ReadonlyArray<readonly [code: string, prefix: string]> = [
  [WS_ERROR_CODES.AGENT_UNAVAILABLE, 'ACP_AGENT_UNAVAILABLE'],
  [WS_ERROR_CODES.INVALID_AGENT_CONFIG, 'ACP_INVALID_AGENT_CONFIG']
]

const VERDICT_PREFIXES: ReadonlyArray<readonly [prefix: string, code: string]> = [
  ['outcome_unknown', WS_ERROR_CODES.OUTCOME_UNKNOWN],
  ['command_conflict', WS_ERROR_CODES.COMMAND_CONFLICT],
  ['command_in_progress', COMMAND_IN_PROGRESS_CODE],
  ['invalid_command_id', WS_ERROR_CODES.INVALID_COMMAND_ID],
  ['command_accepted', COMMAND_ACCEPTED_CODE],
  ...DEFINITE_SPAWN_REJECTIONS.map(([code, prefix]) => [prefix, code] as const)
]

/** Map a rejected Tauri `invoke` value to a typed error when it is a ledger verdict. */
export function mapTauriVerdict(error: unknown): unknown {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (message === null) return error
  for (const [prefix, code] of VERDICT_PREFIXES) {
    if (message.startsWith(`${prefix}:`)) {
      const text = message.slice(prefix.length + 1).trim()
      return new AcpTransportError(code, text || code)
    }
  }
  return error
}
