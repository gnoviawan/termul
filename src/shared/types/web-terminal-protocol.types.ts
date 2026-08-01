import type { GitStatus, TerminalInfo, TerminalSpawnOptions } from './ipc.types'

export type WebTerminalRequestType =
  | 'spawn'
  | 'write'
  | 'resize'
  | 'kill'
  | 'attach'
  | 'detach'
  | 'get_cwd'
  | 'get_git_branch'
  | 'get_git_status'
  | 'get_exit_code'
  | 'add_renderer_ref'
  | 'remove_renderer_ref'
  | 'set_protected'
  | 'update_orphan_detection'

export interface WebTerminalRequest {
  id: string
  type: WebTerminalRequestType
  payload: Record<string, unknown> | TerminalSpawnOptions
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
  snapshot: WebTerminalStateSnapshot
}

/** Gap marker frame: broadcast receiver lagged, some output was lost. */
export interface WebTerminalGapFrame {
  type: 'gap'
  terminalId: string
  lastSeq: number
}

/** Latest lifecycle/metadata state (sent with replay). */
export interface WebTerminalStateSnapshot {
  cwd: string | null
  gitBranch: string | null
  gitStatus: GitStatus | null
  exitCode: number | null
  exited: boolean
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

export type WebTerminalSpawnReply = WebTerminalReply<TerminalInfo>
