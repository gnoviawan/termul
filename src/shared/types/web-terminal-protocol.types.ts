import type {
  GitStatus,
  RotatedClaim,
  SpawnedTerminal,
  TerminalAttachResult,
  TerminalSpawnOptions,
  TerminalStateSnapshot
} from './ipc.types'

export type WebTerminalRequestType =
  | 'authenticate'
  | 'spawn'
  | 'write'
  | 'resize'
  | 'kill'
  | 'attach'
  | 'detach'
  | 'rotate_claim'
  | 'revoke_claim'
  | 'get_cwd'
  | 'get_git_branch'
  | 'get_git_status'
  | 'get_exit_code'
  | 'add_renderer_ref'
  | 'remove_renderer_ref'
  | 'set_protected'
  | 'update_orphan_detection'
  | 'list_preserved'

/**
 * Machine codes the `/terminal/ws` handshake adds to the reply `code` string
 * (SCREAMING_SNAKE, unlike `/ws`'s snake_case `WS_ERROR_CODES`). Mirror the
 * Rust `terminal_ws` handshake refusals (AD-15, AD-4).
 */
export const WEB_TERMINAL_ERROR_CODES = {
  // Bad token on a gated host (unchanged generic refusal).
  UNAUTHORIZED: 'UNAUTHORIZED',
  // `authenticate` carried a missing or different `protocolVersion`.
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  // `authenticate` carried a missing, empty or oversized `deviceId` /
  // `clientInstanceId`.
  INVALID_CLIENT_IDENTITY: 'INVALID_CLIENT_IDENTITY',
  // The connection is view-only (shared-live deployment, or a non-loopback
  // peer without `--allow-remote-writes`) and the request mutates the host.
  // Per-request refusal: the connection stays open and keeps its reads.
  FORBIDDEN: 'FORBIDDEN',
  // A ledgered command (`spawn`, `write`, `kill`, `rotate_claim`,
  // `revoke_claim`) was resent but its outcome is no longer known (evicted
  // receipt, or a rotated claim whose credential was never kept). The host did
  // NOT run it again; recover via `list_preserved` / the terminal's state.
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  // The `commandId` was already used for a different request.
  COMMAND_CONFLICT: 'COMMAND_CONFLICT',
  // The `commandId` is not 1-128 characters of `[A-Za-z0-9_-]`.
  INVALID_COMMAND_ID: 'INVALID_COMMAND_ID'
} as const

export interface WebTerminalRequest {
  id: string
  type: WebTerminalRequestType
  payload: Record<string, unknown> | TerminalSpawnOptions
  /**
   * Client-minted command id (AD-5) of a ledgered request: `spawn`, `write`
   * (one per input chunk), `kill`, `rotate_claim`, `revoke_claim`. A resend with
   * the same id never runs twice. `spawn` may instead carry it as
   * `payload.commandId`. Absent = no replay protection (today's behavior).
   * `list_preserved` re-issues claims and is never replayed.
   */
  commandId?: string
}

export type WebTerminalReply<T = unknown> =
  | { id: string; success: true; data: T }
  | { id: string; success: false; error: string; code: string }

/** A single sequenced output chunk (live data frame). */
export interface WebTerminalDataFrame {
  type: 'data'
  terminalId: string
  seq: number
  data: number[]
}

/** Sequenced replay frame: unseen chunks sent on attach/reconnect. */
export interface WebTerminalReplayFrame {
  type: 'replay'
  terminalId: string
  chunks: Array<{ seq: number; data: number[] }>
  gap: boolean
  latestSeq: number
  snapshot: TerminalStateSnapshot
}

/** Gap marker frame: broadcast receiver lagged, some output was lost. */
export interface WebTerminalGapFrame {
  type: 'gap'
  terminalId: string
  lastSeq: number
}

export type WebTerminalEventPayload =
  | { type: 'exit'; terminal_id: string; exit_code: number | null; signal: number | null }
  | { type: 'cwd_changed'; terminal_id: string; cwd: string }
  | { type: 'git_branch_changed'; terminal_id: string; branch: string | null }
  | { type: 'git_status_changed'; terminal_id: string; status: GitStatus | null }
  | { type: 'exit_code_changed'; terminal_id: string; exit_code: number }

export interface WebTerminalEventFrame {
  type: 'event'
  payload: WebTerminalEventPayload
}

export type WebTerminalFrame<T = unknown> =
  | WebTerminalReply<T>
  | WebTerminalDataFrame
  | WebTerminalReplayFrame
  | WebTerminalGapFrame
  | WebTerminalEventFrame

/**
 * CAP-3: the spawn reply carries the issued claim credential (flattened
 * camelCase, same shape as the desktop `terminal_spawn` IpcResult data).
 */
export type WebTerminalSpawnReply = WebTerminalReply<SpawnedTerminal>

/** CAP-3: attach reply — shared TerminalAttachResult shape (never a claim). */
export type WebTerminalAttachReply = WebTerminalReply<TerminalAttachResult>

/** CAP-3: rotate reply — the fresh credential. */
export type WebTerminalRotateClaimReply = WebTerminalReply<RotatedClaim>
