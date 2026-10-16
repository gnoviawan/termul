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
 * - `precondition_failed:` → `precondition_failed` (definite: a stale
 *   `expectedHead`; nothing changed)
 * - `ACP_AGENT_UNAVAILABLE:` / `ACP_INVALID_AGENT_CONFIG:` → `agent_unavailable`
 *   / `invalid_agent_config` (definite spawn rejections, never auto-retried)
 *
 * - `ACP_PROVIDER_QUOTA_EXCEEDED:` / `ACP_PROVIDER_SESSION_LIMIT:` /
 *   `ACP_PROVIDER_REQUEST_REJECTED:` → `provider_quota_exceeded` /
 *   `provider_session_limit` / `provider_request_rejected` (the upstream
 *   provider refused the call)
 *
 * The prefix is stripped from the message the user reads. Anything else is
 * returned untouched.
 */

import { type IpcResult, PRECONDITION_FAILED_CODE } from '@shared/types/ipc.types'
import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { runCommand } from '../command-engine'
import { type DomainCommandOptions, runIpcCommand } from '../ipc/http'
import { AcpTransportError, COMMAND_ACCEPTED_CODE, COMMAND_IN_PROGRESS_CODE } from './types'

/**
 * The deterministic spawn rejections (`/ws` code, desktop message prefix).
 * The single table both this mapper and `agents/acp-spawn-errors.ts` read.
 */
export const DEFINITE_SPAWN_REJECTIONS: ReadonlyArray<readonly [code: string, prefix: string]> = [
  [WS_ERROR_CODES.AGENT_UNAVAILABLE, 'ACP_AGENT_UNAVAILABLE'],
  [WS_ERROR_CODES.INVALID_AGENT_CONFIG, 'ACP_INVALID_AGENT_CONFIG']
]

/** Provider failures (`/ws` code, desktop message prefix). */
export const PROVIDER_ERROR_PREFIXES: ReadonlyArray<readonly [code: string, prefix: string]> = [
  [WS_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, 'ACP_PROVIDER_QUOTA_EXCEEDED'],
  [WS_ERROR_CODES.PROVIDER_SESSION_LIMIT, 'ACP_PROVIDER_SESSION_LIMIT'],
  [WS_ERROR_CODES.PROVIDER_REQUEST_REJECTED, 'ACP_PROVIDER_REQUEST_REJECTED']
]

const VERDICT_PREFIXES: ReadonlyArray<readonly [prefix: string, code: string]> = [
  ['outcome_unknown', WS_ERROR_CODES.OUTCOME_UNKNOWN],
  ['command_conflict', WS_ERROR_CODES.COMMAND_CONFLICT],
  ['command_in_progress', COMMAND_IN_PROGRESS_CODE],
  ['invalid_command_id', WS_ERROR_CODES.INVALID_COMMAND_ID],
  ['command_accepted', COMMAND_ACCEPTED_CODE],
  ['precondition_failed', PRECONDITION_FAILED_CODE],
  ...DEFINITE_SPAWN_REJECTIONS.map(([code, prefix]) => [prefix, code] as const),
  ...PROVIDER_ERROR_PREFIXES.map(([code, prefix]) => [prefix, code] as const)
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

// --- Desktop domain commands through the command engine -----------------------

/**
 * Run a ledgered command whose Tauri `invoke` resolves a bare `T` and rejects
 * with an error STRING on failure (git commands). Ledger verdict prefixes
 * (`outcome_unknown:`, `command_conflict:`, `invalid_command_id:`,
 * `precondition_failed:`) become typed {@link AcpTransportError}s; any other
 * rejection is rethrown untouched.
 */
export async function runInvokeCommand<T>(
  options: DomainCommandOptions & {
    send: (commandId: string) => Promise<T>
    delaysMs?: readonly number[]
  }
): Promise<T> {
  const run = await runCommand<T>({
    kind: options.kind,
    entityKey: options.entityKey,
    ...(options.fresh ? { fresh: true } : {}),
    ...(options.delaysMs ? { delaysMs: options.delaysMs } : {}),
    send: async (call) => {
      try {
        return await options.send(call.commandId as string)
      } catch (error) {
        throw mapTauriVerdict(error)
      }
    },
    acceptedWithoutResult: () => undefined as T
  })
  return run.result
}

/**
 * Invoke a Tauri command that returns `IpcResult<T>` (worktree, workspace,
 * terminal, install) through the engine: `commandId` rides in the args, ledger
 * verdict prefixes become the matching failures. A rejection that is not a
 * verdict (IPC failure) becomes `{ code: 'INVOKE_ERROR' }` (like `invokeIpc`)
 * unless `invokeFailure: 'throw'` keeps the raw rejection.
 */
export function invokeIpcCommand<T>(
  command: string,
  /** The args, or a builder when the `commandId` does not ride at the top level (spawn: `options.commandId`). */
  args: Record<string, unknown> | ((commandId: string) => Record<string, unknown>),
  options: DomainCommandOptions & {
    invokeFailure?: 'result' | 'throw'
    needsReply?: boolean
    onRun?: (run: { resent: boolean }) => void
  }
): Promise<IpcResult<T>> {
  return runIpcCommand<T>({
    ...options,
    send: async (commandId) => {
      try {
        const callArgs = typeof args === 'function' ? args(commandId) : { ...args, commandId }
        return await invoke<IpcResult<T>>(command, callArgs as InvokeArgs)
      } catch (error) {
        const verdict = mapTauriVerdict(error)
        if (verdict instanceof AcpTransportError || options.invokeFailure === 'throw') throw verdict
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'INVOKE_ERROR'
        }
      }
    }
  })
}
