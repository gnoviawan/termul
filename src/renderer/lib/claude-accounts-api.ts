/**
 * Claude Accounts facade (ADR-0004).
 *
 * Every surface can list the Accounts and choose the Default or a Project
 * Account, through the ACP transport (Tauri `invoke` on desktop, `/ws` on
 * web). Adding, signing in, renaming and removing an Account run a browser
 * login or delete login state on the host, so they are desktop-only; the web
 * client manages Accounts with `termul-server claude account` on the host.
 */

import type {
  ClaudeAccount,
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage
} from '@shared/types/claude-accounts.types'
import { invoke } from '@tauri-apps/api/core'
import { getAcpTransport } from './acp-transport'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

/** The host's error text for a sign-in the user cancelled. */
export const CLAUDE_LOGIN_CANCELLED = 'Sign-in was cancelled'

export function isClaudeLoginCancelled(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return text.includes(CLAUDE_LOGIN_CANCELLED)
}

export class ClaudeAccountsUnsupportedError extends Error {
  constructor(action: string) {
    super(`${action} a Claude account is available only in the desktop app.`)
    this.name = 'ClaudeAccountsUnsupportedError'
  }
}

async function logged<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: `claudeAccounts.${action}`,
      message: `Claude account ${action} failed: ${error instanceof Error ? error.message : String(error)}`
    })
    throw error
  }
}

function desktopOnly<T>(action: string, label: string, run: () => Promise<T>): Promise<T> {
  if (!isTauriContext()) return Promise.reject(new ClaudeAccountsUnsupportedError(label))
  return logged(action, run)
}

export const claudeAccountsApi = {
  /** Whether this surface can add, sign in, rename and remove Accounts. */
  canManageAccounts: (): boolean => isTauriContext(),

  list: (): Promise<ClaudeAccountsSnapshot> =>
    logged('list', () => getAcpTransport().listClaudeAccounts()),

  /** Usage of every Account; host-cached 5 min, `force` reuses reads under 60 s. */
  usage: (force = false): Promise<ClaudeAccountUsage[]> =>
    logged('usage', () => getAcpTransport().listClaudeUsage(force)),

  setDefault: (accountId: string): Promise<void> =>
    logged('setDefault', () => getAcpTransport().setDefaultClaudeAccount(accountId)),

  /** `null` returns the Project to the Default Account. */
  setProjectAccount: (projectId: string, accountId: string | null): Promise<void> =>
    logged('setProjectAccount', () =>
      getAcpTransport().setProjectClaudeAccount(projectId, accountId)
    ),

  add: (name: string): Promise<ClaudeAccount> =>
    desktopOnly('add', 'Adding', () => invoke<ClaudeAccount>('claude_accounts_add', { name })),

  /** Opens the browser for the Claude login; resolves when the login finishes. */
  login: (accountId: string): Promise<void> =>
    desktopOnly('login', 'Signing in to', () =>
      invoke<void>('claude_accounts_login', { accountId })
    ),

  /** Stop a running sign-in; resolves `false` when none was running. */
  cancelLogin: (accountId: string): Promise<boolean> =>
    desktopOnly('cancelLogin', 'Cancelling the sign-in of', () =>
      invoke<boolean>('claude_accounts_login_cancel', { accountId })
    ),

  rename: (accountId: string, name: string): Promise<void> =>
    desktopOnly('rename', 'Renaming', () =>
      invoke<void>('claude_accounts_rename', { accountId, name })
    ),

  /** Resolves to the ids of the Projects that moved to the Default Account. */
  remove: (accountId: string): Promise<string[]> =>
    desktopOnly('remove', 'Removing', () =>
      invoke<string[]>('claude_accounts_remove', { accountId })
    )
}
