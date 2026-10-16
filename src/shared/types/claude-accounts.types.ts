/**
 * Claude Accounts contract (ADR-0004). Mirrors the Rust
 * `acp::claude_accounts` serde shapes. No field holds a secret: logins stay in
 * Claude Code's own credential store on the host.
 */

/** Id of the built-in Account that uses the host's shared Claude config folder. */
export const BUILTIN_CLAUDE_ACCOUNT_ID = 'default'

/** One Claude subscription login. */
export interface ClaudeAccount {
  id: string
  name: string
  /** Unix epoch milliseconds; `0` for the built-in Account. */
  createdAt: number
}

export interface ClaudeAccountView {
  id: string
  name: string
  /** `true` for the Account that uses the host's shared Claude config folder. */
  builtin: boolean
  /** Claude CLI login state; `null` when the host could not read it. */
  signedIn: boolean | null
}

/** One usage window of an Account (5-hour session, weekly, per model). */
export interface ClaudeUsageWindow {
  /** SDK kind, e.g. `session`, `weekly_all`, `weekly_scoped`. */
  kind: string
  /** `session` or `weekly` when the SDK groups the kind. */
  group: string | null
  /** Model or feature name of a scoped window. */
  scope: string | null
  /** Percent used, 0–100. */
  percent: number
  /** ISO-8601 reset time; `null` while the window has not started. */
  resetsAt: string | null
  /** SDK severity, e.g. `normal`, `warning`, `critical`. */
  severity: string | null
}

export type ClaudeUsageStatus = 'ok' | 'unavailable' | 'signed_out' | 'error'

/** The usage of one Account at `checkedAt`. */
export interface ClaudeAccountUsage {
  accountId: string
  status: ClaudeUsageStatus
  /** `pro`, `max`, `team`, `enterprise` when known. */
  subscriptionType: string | null
  windows: ClaudeUsageWindow[]
  /** Unix epoch milliseconds of the read. */
  checkedAt: number
  /** Reason for `error` / `unavailable`; never holds login details. */
  message: string | null
}

/**
 * Live plan rate-limit state that the Claude ACP adapter attaches to a
 * `usage_update` (from the SDK `rate_limit_event`).
 */
export interface ClaudeRateLimit {
  /** `allowed`, `allowed_warning`, or `rejected`. */
  status: string
  /** Unix epoch seconds of the window reset. */
  resetsAt: number | null
  /** SDK window kind, e.g. `five_hour`, `seven_day`. */
  kind: string | null
  /** Percent used, 0–100. */
  percent: number | null
  /** Paid overage carries the turn, so a `rejected` window does not block. */
  overageInUse: boolean
}

export interface ClaudeAccountsSnapshot {
  accounts: ClaudeAccountView[]
  defaultAccountId: string
  /** Project id → Account id, only for Projects with an explicit choice. */
  projectAccounts: Record<string, string>
}
