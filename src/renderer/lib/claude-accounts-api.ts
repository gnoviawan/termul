/**
 * Claude Accounts facade (ADR-0004).
 *
 * Every surface lists the Accounts, chooses the Default or a Project Account,
 * turns automatic switching on or off, adds, renames and removes an Account and
 * stops a sign-in through the ACP transport (`/ws`, over the Tauri Channel on
 * desktop).
 *
 * Signing in differs by surface ({@link ClaudeSignInFlow}). The desktop app
 * runs on the host, so the Claude CLI opens the host's browser. A browser
 * client may be anywhere, so it gets the sign-in link and pastes back the code
 * the Claude page shows.
 */

import type {
  ClaudeAccount,
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage
} from '@shared/types/claude-accounts.types'
import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { invoke } from '@tauri-apps/api/core'
import { getAcpTransport } from './acp-transport'
import { runCommand } from './command-engine'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

/**
 * `browser`: the host's browser opens and the sign-in resolves on its own.
 * `link`: the user opens the sign-in link and pastes back the Claude code.
 */
export type ClaudeSignInFlow = 'browser' | 'link'

/** The host's error text for a sign-in the user cancelled. */
export const CLAUDE_LOGIN_CANCELLED = 'Sign-in was cancelled'

export function isClaudeLoginCancelled(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return text.includes(CLAUDE_LOGIN_CANCELLED)
}

/** The host still waits for the whole code: the pasted one was cut short. */
export function isClaudeLoginCodeIncomplete(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === WS_ERROR_CODES.CLAUDE_LOGIN_CODE_INCOMPLETE
  )
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
  signInFlow: (): ClaudeSignInFlow => (isTauriContext() ? 'browser' : 'link'),

  list: (): Promise<ClaudeAccountsSnapshot> =>
    logged('list', () => getAcpTransport().listClaudeAccounts()),

  /** Usage of every Account; host-cached 5 min, `force` reuses reads under 60 s. */
  usage: (force = false): Promise<ClaudeAccountUsage[]> =>
    logged('usage', () => getAcpTransport().listClaudeUsage(force)),

  setDefault: (accountId: string): Promise<void> =>
    logged('setDefault', () => getAcpTransport().setDefaultClaudeAccount(accountId)),

  /**
   * `null` returns the Project to the Default Account. `expectedAccountId`
   * applies the choice only while the Project still uses that Account, so
   * clients that react to the same limit converge on one switch. Resolves
   * whether the choice applied.
   */
  setProjectAccount: (
    projectId: string,
    accountId: string | null,
    options: { expectedAccountId?: string } = {}
  ): Promise<boolean> =>
    logged('setProjectAccount', () =>
      getAcpTransport().setProjectClaudeAccount(projectId, accountId, options.expectedAccountId)
    ),

  /** Host-wide: continue a chat at its Account's limit on the Account with the most room. */
  setAutoSwitch: (enabled: boolean): Promise<void> =>
    logged('setAutoSwitch', () => getAcpTransport().setClaudeAutoSwitch(enabled)),

  /** A lost reply is resent with the same command id, so it never adds twice. */
  add: (name: string): Promise<ClaudeAccount> =>
    logged('add', async () => {
      const run = await runCommand({
        kind: 'add_claude_account',
        entityKey: name,
        send: (call) => getAcpTransport().addClaudeAccount(name, call)
      })
      return run.result
    }),

  /** The `browser` flow: opens the host's browser; resolves when the login finishes. */
  login: (accountId: string): Promise<void> =>
    desktopOnly('login', 'Signing in to', () =>
      invoke<void>('claude_accounts_login', { accountId })
    ),

  /** The `link` flow: resolves the Claude sign-in link for the user to open. */
  startLinkLogin: (accountId: string): Promise<string> =>
    logged('startLinkLogin', () => getAcpTransport().startClaudeLinkLogin(accountId)),

  /**
   * Hand the code from the Claude page to the link sign-in. Check a rejection
   * with {@link isClaudeLoginCodeIncomplete}: the sign-in then still waits.
   */
  finishLinkLogin: (accountId: string, code: string): Promise<void> =>
    logged('finishLinkLogin', async () => {
      await runCommand({
        kind: 'finish_claude_link_login',
        entityKey: accountId,
        send: (call) => getAcpTransport().finishClaudeLinkLogin(accountId, code, call),
        // A retry carries another code, so it never reuses an earlier id.
        fresh: true,
        acceptedWithoutResult: () => undefined
      })
    }),

  /** Stop a browser or link sign-in; resolves `false` when none was running. */
  cancelLogin: (accountId: string): Promise<boolean> =>
    logged('cancelLogin', () => getAcpTransport().cancelClaudeLogin(accountId)),

  rename: (accountId: string, name: string): Promise<void> =>
    logged('rename', () => getAcpTransport().renameClaudeAccount(accountId, name)),

  /** Resolves to the ids of the Projects that moved to the Default Account. */
  remove: (accountId: string): Promise<string[]> =>
    logged('remove', () => getAcpTransport().removeClaudeAccount(accountId))
}
