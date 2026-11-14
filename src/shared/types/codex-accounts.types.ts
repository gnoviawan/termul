/**
 * Codex Accounts contract. Mirrors the Rust `acp::codex_accounts` serde shapes.
 * No field holds a secret: ChatGPT logins stay in Codex's own credential store.
 */

/** Id of the built-in Account that uses the host's shared Codex home. */
export const BUILTIN_CODEX_ACCOUNT_ID = 'default'

/** Catalog id of the managed Codex ACP agent. */
export const CODEX_AGENT_CONFIG_ID = 'acp-registry:codex-acp'

/** ACP authenticate method ids. ChatGPT only; never `api-key`. */
export const CODEX_CHATGPT_METHOD = 'chat-gpt'
export const CODEX_DEVICE_CODE_METHOD = 'chat-gpt-device-code'

/** One ChatGPT login for Codex. */
export interface CodexAccount {
  id: string
  name: string
  /** Unix epoch milliseconds; `0` for the built-in Account. */
  createdAt: number
}

export interface CodexAccountView {
  id: string
  name: string
  /** `true` for the Account that uses the host's shared Codex home. */
  builtin: boolean
  /** Codex CLI login state; `null` when the host could not read it. */
  signedIn: boolean | null
}

export interface CodexAccountsSnapshot {
  accounts: CodexAccountView[]
  defaultAccountId: string
  /** Project id → Account id, only for Projects with an explicit choice. */
  projectAccounts: Record<string, string>
  /** A chat at its Account's limit continues on the signed-in Account with the most room. */
  autoSwitch: boolean
}

/** One usage window of an Account (about 5 hours, or weekly). */
export interface CodexUsageWindow {
  /** `session` (about 5 hours) or `weekly`. */
  kind: 'session' | 'weekly'
  /** Percent used, 0–100. */
  percent: number
  /** ISO-8601 reset time; `null` when Codex did not send one. */
  resetsAt: string | null
  /** Window length in minutes, when Codex sent it. */
  windowDurationMins: number | null
}

export type CodexUsageStatus = 'ok' | 'unavailable' | 'signed_out' | 'error'

/** The usage of one Account at `checkedAt`. */
export interface CodexAccountUsage {
  accountId: string
  status: CodexUsageStatus
  /** Plan name when Codex sent one (`plus`, `pro`, …). Never an email. */
  planType: string | null
  windows: CodexUsageWindow[]
  /** Unix epoch milliseconds of the read. */
  checkedAt: number
  /** Reason for `error` or `unavailable`. Never holds login details. */
  message: string | null
}
