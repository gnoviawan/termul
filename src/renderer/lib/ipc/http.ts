/**
 * Shared fetch helpers for the web/remote (`web-*-api.ts`) IPC adapters.
 *
 * In web/remote mode the browser is served by `termul-server` itself, so the
 * same-origin HTTP routes mirror the desktop Tauri commands. Every helper
 * maps transport/parse failures to `IpcResult { success: false, code:
 * 'NETWORK_ERROR' }` so the renderer never sees a thrown exception from the
 * network layer. A non-2xx response carrying a valid `IpcBody` failure (e.g.
 * the web auth gate's 401 UNAUTHORIZED) keeps the server-provided
 * code/message.
 *
 * Ledgered mutations (AD-5/AD-6) are the one choke point here: {@link postJson}
 * sends the routes of {@link LEDGERED_ROUTES} through the command engine
 * (journal, `X-Command-Id`, same-id resend on an uncertain outcome, new id after
 * a definite rejection), so no caller can forget the id the host now requires.
 *
 * Wire verdicts map to the engine codes it classifies:
 *
 * | `IpcResult.code` / terminal reply                 | engine code           | class     |
 * |---------------------------------------------------|-----------------------|-----------|
 * | `NETWORK_ERROR` (lost reply, timeout, bad body)   | `closed`              | uncertain |
 * | `OUTCOME_UNKNOWN`                                 | `outcome_unknown`     | uncertain |
 * | `COMMAND_IN_PROGRESS` (`receipt: "in_progress"`)  | `command_in_progress` | uncertain |
 * | `COMMAND_CONFLICT` / `INVALID_COMMAND_ID`         | same, snake_case      | definite  |
 * | `PRECONDITION_FAILED`                             | `precondition_failed` | definite  |
 * | anything else                                     | the original code     | definite  |
 *
 * Never logs bodies or credentials (the engine logs kinds/ids only).
 */

import {
  COMMAND_ID_HEADER,
  COMMAND_RESULT_CODES,
  IN_PROGRESS_RECEIPT,
  type IpcResult,
  PRECONDITION_FAILED_CODE
} from '@shared/types/ipc.types'
import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { AcpTransportError, COMMAND_IN_PROGRESS_CODE } from '../acp-transport/types'
import { runCommand } from '../command-engine'

import { isTauriContext } from '../tauri-runtime'
import { authHeader } from '../web-auth-token'

/**
 * Same-origin base for the embedded server. In web/remote mode the browser is
 * served by `termul-server` itself, so `window.location.origin` is the
 * server. Returns the empty string under Tauri (desktop build) so a
 * misconfigured call fails fast rather than hitting a phantom origin.
 */
export function serverBase(): string {
  if (isTauriContext()) return ''
  if (typeof window === 'undefined' || !window.location) return ''
  return window.location.origin
}

/** Shape of the HTTP response body mirroring `IpcResult<T>`. */
export type IpcBody<T> =
  | { success: true; data: T }
  /** A resend while the first run of the `X-Command-Id` is still going (no `data`). */
  | { success: true; receipt: typeof IN_PROGRESS_RECEIPT; data?: undefined }
  | { success: false; error: string; code: string }

/**
 * Map a parsed `IpcBody` (or an NDJSON `result` frame) to an `IpcResult`.
 * `null` when it is not a recognizable body. The in-progress receipt becomes
 * the `COMMAND_IN_PROGRESS` failure: the command is neither accepted nor
 * rejected yet.
 */
export function bodyToResult<T>(body: unknown): IpcResult<T> | null {
  if (typeof body !== 'object' || body === null || !('success' in body)) return null
  if (body.success === false) {
    return 'error' in body &&
      typeof body.error === 'string' &&
      'code' in body &&
      typeof body.code === 'string'
      ? { success: false, error: body.error, code: body.code }
      : null
  }
  if (body.success !== true) return null
  if ('receipt' in body && body.receipt === IN_PROGRESS_RECEIPT) {
    return {
      success: false,
      error: 'The first run of this command is still going',
      code: COMMAND_RESULT_CODES.COMMAND_IN_PROGRESS
    }
  }
  // A unit reply (and a receipt-only replay) carries no `data`.
  const data: unknown = 'data' in body ? body.data : undefined
  return { success: true, data: data as T }
}

/** Map any transport/parse failure to a uniform `IpcResult` failure. */
export function networkError(detail: string): IpcResult<never> {
  return { success: false, error: detail, code: 'NETWORK_ERROR' }
}

/**
 * Parse the `IpcBody<T>` JSON body into `IpcResult<T>`. A non-2xx response can
 * still carry a structured failure body — the web auth gate answers 401 with
 * `{ success: false, code: 'UNAUTHORIZED' }` — so the body is parsed FIRST and
 * a valid server-provided code/message is preserved on any status;
 * NETWORK_ERROR remains the fallback for absent/invalid bodies (and for any
 * transport throw).
 */
export async function parseBody<T>(res: Response): Promise<IpcResult<T>> {
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    if (!res.ok) return networkError(`HTTP ${res.status} ${res.statusText}`)
    return networkError(err instanceof Error ? err.message : 'invalid JSON')
  }
  const result = bodyToResult<T>(body)
  // A failure body keeps its server-provided code/message on any status.
  if (result && !result.success) return result
  if (!res.ok) {
    return networkError(`HTTP ${res.status} ${res.statusText}`)
  }
  return result ?? networkError('invalid response body')
}

/** GET and return the typed `IpcResult` body (or NETWORK_ERROR). */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'GET',
      headers: authHeader(),
      signal
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/** POST once (no engine). A ledgered route sends `commandId` as `X-Command-Id`. */
export async function postJsonOnce<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  commandId?: string
): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeader(),
        ...(commandId ? { [COMMAND_ID_HEADER]: commandId } : {})
      },
      body: JSON.stringify(body),
      signal
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/** PUT JSON and return the typed `IpcResult` body (or NETWORK_ERROR). */
export async function putJson<T>(path: string, body: unknown): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify(body)
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

// --- Ledgered commands -------------------------------------------------------

type IpcFailure = Extract<IpcResult<unknown>, { success: false }>

/** carrier code → engine code. */
const TO_ENGINE_CODE: Readonly<Record<string, string>> = {
  NETWORK_ERROR: 'closed',
  [COMMAND_RESULT_CODES.OUTCOME_UNKNOWN]: WS_ERROR_CODES.OUTCOME_UNKNOWN,
  [COMMAND_RESULT_CODES.COMMAND_IN_PROGRESS]: COMMAND_IN_PROGRESS_CODE,
  [COMMAND_RESULT_CODES.COMMAND_CONFLICT]: WS_ERROR_CODES.COMMAND_CONFLICT,
  [COMMAND_RESULT_CODES.INVALID_COMMAND_ID]: WS_ERROR_CODES.INVALID_COMMAND_ID,
  [COMMAND_RESULT_CODES.PRECONDITION_FAILED]: PRECONDITION_FAILED_CODE
}

/** engine code → carrier code, for the codes a verdict error can carry. */
const TO_CARRIER_CODE: Readonly<Record<string, string>> = {
  [WS_ERROR_CODES.OUTCOME_UNKNOWN]: COMMAND_RESULT_CODES.OUTCOME_UNKNOWN,
  [COMMAND_IN_PROGRESS_CODE]: COMMAND_RESULT_CODES.COMMAND_IN_PROGRESS,
  [WS_ERROR_CODES.COMMAND_CONFLICT]: COMMAND_RESULT_CODES.COMMAND_CONFLICT,
  [WS_ERROR_CODES.INVALID_COMMAND_ID]: COMMAND_RESULT_CODES.INVALID_COMMAND_ID,
  [PRECONDITION_FAILED_CODE]: COMMAND_RESULT_CODES.PRECONDITION_FAILED
}

/** A failed `IpcResult` carried through the engine as a typed error. */
class IpcFailureError extends AcpTransportError {
  readonly failure: IpcFailure

  constructor(failure: IpcFailure) {
    super(TO_ENGINE_CODE[failure.code] ?? failure.code, failure.error)
    this.failure = failure
  }
}

/** The `IpcResult` failure a verdict error stands for. */
function failureOf(error: AcpTransportError): IpcFailure {
  if (error instanceof IpcFailureError) return error.failure
  return {
    success: false,
    error: error.message,
    code: TO_CARRIER_CODE[error.code] ?? error.code
  }
}

/** Whether `code` is one of the ledger verdict / precondition codes. */
export function isCommandResultCode(code: string): boolean {
  return code in TO_ENGINE_CODE && code !== 'NETWORK_ERROR'
}

/**
 * The error a throwing facade raises for a failed `IpcResult`: a typed
 * {@link AcpTransportError} for the ledger verdicts (`outcome_unknown`,
 * `command_conflict`, `invalid_command_id`, `precondition_failed`), a plain
 * `Error` carrying the host message for everything else.
 */
export function ipcFailureError(failure: { error: string; code: string }): Error {
  if (isCommandResultCode(failure.code)) {
    return new AcpTransportError(TO_ENGINE_CODE[failure.code], failure.error)
  }
  return new Error(failure.error)
}

export interface DomainCommandOptions {
  /** The command kind (the host's class-table name, e.g. `fs_write`). */
  kind: string
  /**
   * What the command acts on (identifiers only, never content): a retry of the
   * same intent finds its unresolved id by `kind` + `entityKey`.
   */
  entityKey: string
  /**
   * Never reuse an unresolved id from an earlier call. For commands whose
   * request carries content the key cannot name (file body, commit message,
   * hunk patch): a later call may be a different request.
   */
  fresh?: boolean
}

/**
 * Run a ledgered command whose carrier answers an `IpcResult` (HTTP routes,
 * terminal carriers, Tauri commands returning `IpcResult`). `send` receives the
 * `commandId` and resolves an `IpcResult`; it may also reject with an
 * {@link AcpTransportError} verdict (a Tauri error-prefix verdict), which is
 * converted back to the matching failure. Other rejections propagate.
 *
 * A lost reply (`NETWORK_ERROR`), `OUTCOME_UNKNOWN` or an in-progress receipt
 * is never a rejection: the id is resent (bounded ladder) and otherwise stays
 * unresolved in the journal; the failure then reaches the caller unchanged.
 */
export async function runIpcCommand<T>(
  options: DomainCommandOptions & {
    send: (commandId: string) => Promise<IpcResult<T>>
    /**
     * Called when the command was accepted: `resent` is true when the host may
     * have answered from its ledger or entity lookup (the id had been sent
     * before — an in-call resend, or an unresolved id from an earlier call).
     */
    onRun?: (run: { resent: boolean }) => void
    /**
     * The caller needs the reply data. When the host only knows the command ran
     * (its reply was too large to keep), report a failure instead of a success
     * with no data.
     */
    needsReply?: boolean
    /** Test seam: resend delays. */
    delaysMs?: readonly number[]
  }
): Promise<IpcResult<T>> {
  try {
    const run = await runCommand<IpcResult<T>>({
      kind: options.kind,
      entityKey: options.entityKey,
      ...(options.fresh ? { fresh: true } : {}),
      ...(options.delaysMs ? { delaysMs: options.delaysMs } : {}),
      send: async (call) => {
        const result = await options.send(call.commandId as string)
        if (result.success) return result
        throw new IpcFailureError(result)
      },
      // The command ran; its reply is not retained.
      ...(options.needsReply
        ? {}
        : { acceptedWithoutResult: () => ({ success: true as const, data: undefined as T }) })
    })
    options.onRun?.({ resent: run.resent })
    return run.result
  } catch (error) {
    if (error instanceof AcpTransportError) return failureOf(error)
    throw error
  }
}

/** The identity of a ledgered route's command (see {@link DomainCommandOptions}). */
interface LedgeredRoute extends Omit<DomainCommandOptions, 'entityKey'> {
  /** What the command acts on, from its request body (identifiers only). */
  entityKey: (body: object) => string
}

const part = (body: object, key: string): string => {
  const value: unknown = Reflect.get(body, key)
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}
/**
 * The key an intent is retried under: its identifying fields as one JSON array,
 * so two different field sets can never collapse into one key (a path can
 * contain any separator character).
 */
export const entityKeyOf = (
  ...fields: ReadonlyArray<string | number | boolean | null | undefined>
) => JSON.stringify(fields.map((field) => field ?? ''))

const pair = (a: string, b: string) => (body: object) => entityKeyOf(part(body, a), part(body, b))

/**
 * The HTTP routes the host ledgers (`X-Command-Id` required), by path. Mirrors
 * `DOMAIN_COMMAND_CLASSES` in `web/command_ledger/http.rs`; `fresh` marks the
 * routes whose body carries content the key cannot name. The ndjson worktree
 * create stream is sent by `web-server-api.ts` through {@link runIpcCommand}.
 */
const LEDGERED_ROUTES: Readonly<Record<string, LedgeredRoute>> = {
  '/fs/write': { kind: 'fs_write', fresh: true, entityKey: (b) => part(b, 'path') },
  '/fs/rename': { kind: 'fs_rename', entityKey: pair('from', 'to') },
  '/fs/copy': { kind: 'fs_copy', entityKey: pair('from', 'to') },
  '/git/stage-hunk': { kind: 'git_stage_hunk', fresh: true, entityKey: pair('cwd', 'path') },
  '/git/unstage-hunk': { kind: 'git_unstage_hunk', fresh: true, entityKey: pair('cwd', 'path') },
  '/git/discard': { kind: 'git_discard', entityKey: pair('cwd', 'path') },
  '/git/commit': { kind: 'git_commit', fresh: true, entityKey: (b) => part(b, 'cwd') },
  '/git/create-branch': {
    kind: 'git_create_branch',
    entityKey: (b) => entityKeyOf(part(b, 'cwd'), part(b, 'branch'), part(b, 'startRef'))
  },
  '/git/stash-save': { kind: 'git_stash_save', fresh: true, entityKey: (b) => part(b, 'cwd') },
  '/git/stash-apply': { kind: 'git_stash_apply', entityKey: pair('cwd', 'index') },
  '/git/stash-pop': { kind: 'git_stash_pop', entityKey: pair('cwd', 'index') },
  '/git/stash-drop': { kind: 'git_stash_drop', entityKey: pair('cwd', 'index') },
  '/worktree/create': { kind: 'worktree_create', entityKey: (b) => worktreeCreateKey(b) },
  '/worktree/rename-branch': {
    kind: 'worktree_rename_branch',
    entityKey: (b) =>
      entityKeyOf(part(b, 'worktreePath'), part(b, 'oldBranch'), part(b, 'newBranch'))
  },
  '/acp/install': { kind: 'install_acp_agent', entityKey: (b) => part(b, 'agentId') }
}

/** The key a worktree create is retried under: every field the host fingerprints. */
export function worktreeCreateKey(body: object): string {
  const flag: unknown = Reflect.get(body, 'isNewBranch')
  return entityKeyOf(
    part(body, 'projectPath'),
    part(body, 'branch'),
    part(body, 'name'),
    part(body, 'targetPath'),
    flag === true,
    part(body, 'startRef')
  )
}

function ledgeredRoute(path: string): LedgeredRoute | null {
  const route = LEDGERED_ROUTES[path]
  return route ?? null
}

/**
 * POST JSON and return the typed `IpcResult` body (or NETWORK_ERROR). A route
 * the host ledgers runs through the command engine: its `X-Command-Id` is
 * minted and journaled before the send and a lost reply is resent under the
 * same id.
 */
export function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<IpcResult<T>> {
  const route = ledgeredRoute(path)
  if (!route || typeof body !== 'object' || body === null) {
    return postJsonOnce<T>(path, body, signal)
  }
  return runIpcCommand<T>({
    kind: route.kind,
    entityKey: route.entityKey(body),
    ...(route.fresh ? { fresh: true } : {}),
    send: (commandId) => postJsonOnce<T>(path, body, signal, commandId)
  })
}
