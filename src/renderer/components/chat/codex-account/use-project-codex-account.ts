import type { CodexAccountsSnapshot, CodexAccountView } from '@shared/types/codex-accounts.types'
import { codexAccountReadiness } from '@/components/settings/provider/codex-account-status'
import { type CodexAccountsState, useCodexAccounts } from '@/hooks/use-codex-accounts'

export interface ProjectCodexAccount {
  accounts: CodexAccountsState
  projectId: string
  current: CodexAccountView
  defaultAccount: CodexAccountView | null
  /** `true` when the Project chose an Account (not "Follow default"). */
  explicit: boolean
}

/** The Account a Project uses: its own choice, else the Default Account. */
export const projectCodexAccountId = (snapshot: CodexAccountsSnapshot, projectId: string): string =>
  snapshot.projectAccounts[projectId] ?? snapshot.defaultAccountId

/**
 * The Codex Account context of one Project. `null` when there is no Project
 * or while the list loads.
 */
export function useProjectCodexAccount(projectId: string | null): ProjectCodexAccount | null {
  const accounts = useCodexAccounts({ enabled: Boolean(projectId) })
  const { snapshot } = accounts
  if (!projectId || !snapshot) return null
  const defaultAccount = snapshot.accounts.find((a) => a.id === snapshot.defaultAccountId) ?? null
  const currentId = projectCodexAccountId(snapshot, projectId)
  const current = snapshot.accounts.find((a) => a.id === currentId)
  if (!current) return null
  return {
    accounts,
    projectId,
    current,
    defaultAccount,
    explicit: Boolean(snapshot.projectAccounts[projectId])
  }
}

export function codexChoiceReady(account: CodexAccountView): boolean {
  return codexAccountReadiness(account) === 'ready'
}
