/**
 * Codex Accounts facade.
 *
 * Every surface lists the Accounts, chooses the Default or a Project Account,
 * stores the automatic-switching flag, and adds, renames and removes an
 * Account through the ACP transport (`/ws`, over the Tauri Channel on desktop).
 *
 * Sign-in spawns the Codex agent with that Account's `CODEX_HOME`, then the
 * caller runs ACP `authenticate` with `chat-gpt` or `chat-gpt-device-code`.
 * The same path works on the desktop app and on a remote browser.
 */

import type {
  CodexAccount,
  CodexAccountsSnapshot,
  CodexAccountUsage
} from '@shared/types/codex-accounts.types'
import type { AgentConfig, SpawnAgentResult } from '@/lib/acp-api'
import { getAcpTransport } from './acp-transport'
import { runCommand } from './command-engine'
import { logFrontendError } from './log-api'

async function logged<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: `codexAccounts.${action}`,
      message: `Codex account ${action} failed: ${error instanceof Error ? error.message : String(error)}`
    })
    throw error
  }
}

export const codexAccountsApi = {
  list: (): Promise<CodexAccountsSnapshot> =>
    logged('list', () => getAcpTransport().listCodexAccounts()),

  /**
   * Plan windows of every Account. The host caches them for 5 minutes.
   * `force` still reuses a read younger than 60 seconds. A failed read keeps
   * the last good windows.
   */
  usage: (force = false): Promise<CodexAccountUsage[]> =>
    logged('usage', () => getAcpTransport().listCodexUsage(force)),

  setDefault: (accountId: string): Promise<void> =>
    logged('setDefault', () => getAcpTransport().setDefaultCodexAccount(accountId)),

  /**
   * `null` returns the Project to the Default Account. `expectedAccountId`
   * applies the choice only while the Project still uses that Account.
   */
  setProjectAccount: (
    projectId: string,
    accountId: string | null,
    options: { expectedAccountId?: string } = {}
  ): Promise<boolean> =>
    logged('setProjectAccount', () =>
      getAcpTransport().setProjectCodexAccount(projectId, accountId, options.expectedAccountId)
    ),

  /** A chat at its limit continues on the signed-in Account with the most room. */
  setAutoSwitch: (enabled: boolean): Promise<void> =>
    logged('setAutoSwitch', () => getAcpTransport().setCodexAutoSwitch(enabled)),

  /** A lost reply is resent with the same command id, so it never adds twice. */
  add: (name: string): Promise<CodexAccount> =>
    logged('add', async () => {
      const run = await runCommand({
        kind: 'add_codex_account',
        entityKey: name,
        send: (call) => getAcpTransport().addCodexAccount(name, call)
      })
      return run.result
    }),

  rename: (accountId: string, name: string): Promise<void> =>
    logged('rename', () => getAcpTransport().renameCodexAccount(accountId, name)),

  /** Resolves to the ids of the Projects that moved to the Default Account. */
  remove: (accountId: string): Promise<string[]> =>
    logged('remove', () => getAcpTransport().removeCodexAccount(accountId)),

  /**
   * Spawn the Codex agent with this Account's home. The caller authenticates
   * that agent, then stops it. The login stays in the home.
   */
  startLogin: (accountId: string, config: AgentConfig): Promise<SpawnAgentResult> =>
    logged('startLogin', async () => {
      const run = await runCommand({
        kind: 'start_codex_account_login',
        entityKey: accountId,
        send: (call) => getAcpTransport().startCodexAccountLogin(accountId, config, call)
      })
      return run.result
    })
}
