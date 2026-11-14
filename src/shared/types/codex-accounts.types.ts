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
  /**
   * Stored preference. Automatic switching itself waits until a usage probe
   * exists. The toggle only saves this flag.
   */
  autoSwitch: boolean
}
