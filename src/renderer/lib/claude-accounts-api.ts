/**
 * Claude Accounts facade (ADR-0004).
 *
 * Every surface can list the Accounts and choose the Default or a Project
 * Account, through the ACP transport (Tauri `invoke` on desktop, `/ws` on
 * web). Adding, signing in, renaming and removing an Account run a browser
 * login or delete login state on the host. The desktop runs them through its
 * Tauri commands; a web client runs them over `/ws` only when the host
 * reports the connection `hostLocal` (a client on the host itself holding
 * the server token, such as the GPUIX desktop client). Other web clients
 * manage Accounts with `termul-server claude account` on the host.
 */

import type {
  ClaudeAccount,
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage
} from '@shared/types/claude-accounts.types'
import { invoke } from '@tauri-apps/api/core'
import { getAcpTransport } from './acp-transport'
import type { AcpTransport } from './acp-transport/types'
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

/** The web transport when the host lets this connection manage Accounts. */
function hostManagedTransport(): AcpTransport | null {
  const transport = getAcpTransport()
  return transport.connectionCapabilities?.()?.hostLocal === true ? transport : null
}

/**
 * Desktop: the Tauri command. Web: the `/ws` request when the host admits
 * management for this connection, else `ClaudeAccountsUnsupportedError`
 * without a request.
 */
function managed<T>(
  action: string,
  label: string,
  desktop: () => Promise<T>,
  web: (transport: AcpTransport) => Promise<T> | undefined
): Promise<T> {
  if (isTauriContext()) return logged(action, desktop)
  const transport = hostManagedTransport()
  const request = transport ? web(transport) : undefined
  if (!request) return Promise.reject(new ClaudeAccountsUnsupportedError(label))
  return logged(action, () => request)
}

export const claudeAccountsApi = {
  /** Whether this surface can add, sign in, rename and remove Accounts. */
  canManageAccounts: (): boolean => isTauriContext() || hostManagedTransport() !== null,

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
    managed(
      'add',
      'Adding',
      () => invoke<ClaudeAccount>('claude_accounts_add', { name }),
      (t) => t.addClaudeAccount?.(name)
    ),

  /** Opens the browser for the Claude login; resolves when the login finishes. */
  login: (accountId: string): Promise<void> =>
    managed(
      'login',
      'Signing in to',
      () => invoke<void>('claude_accounts_login', { accountId }),
      (t) => t.loginClaudeAccount?.(accountId)
    ),

  /** Stop a running sign-in; resolves `false` when none was running. */
  cancelLogin: (accountId: string): Promise<boolean> =>
    managed(
      'cancelLogin',
      'Cancelling the sign-in of',
      () => invoke<boolean>('claude_accounts_login_cancel', { accountId }),
      (t) => t.cancelClaudeAccountLogin?.(accountId)
    ),

  rename: (accountId: string, name: string): Promise<void> =>
    managed(
      'rename',
      'Renaming',
      () => invoke<void>('claude_accounts_rename', { accountId, name }),
      (t) => t.renameClaudeAccount?.(accountId, name)
    ),

  /** Resolves to the ids of the Projects that moved to the Default Account. */
  remove: (accountId: string): Promise<string[]> =>
    managed(
      'remove',
      'Removing',
      () => invoke<string[]>('claude_accounts_remove', { accountId }),
      (t) => t.removeClaudeAccount?.(accountId)
    )
}
