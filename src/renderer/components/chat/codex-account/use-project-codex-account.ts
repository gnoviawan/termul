import type {
  CodexAccountsSnapshot,
  CodexAccountUsage,
  CodexAccountView,
  CodexUsageWindow
} from '@shared/types/codex-accounts.types'
import { codexAccountReadiness } from '@/components/settings/provider/codex-account-status'
import { type CodexAccountsState, useCodexAccounts } from '@/hooks/use-codex-accounts'
import { primaryCodexWindow } from '@/lib/codex-usage-format'

export interface CodexAccountChoice {
  account: CodexAccountView
  usage: CodexAccountUsage | undefined
  window: CodexUsageWindow | null
}

export interface ProjectCodexAccount {
  accounts: CodexAccountsState
  projectId: string
  current: CodexAccountChoice
  defaultAccount: CodexAccountView | null
  /** `true` when the Project chose an Account (not "Follow default"). */
  explicit: boolean
  /** Signed-in Accounts with room left, least used first. */
  alternatives: CodexAccountChoice[]
}

const choice = (
  account: CodexAccountView,
  usage: Record<string, CodexAccountUsage>
): CodexAccountChoice => ({
  account,
  usage: usage[account.id],
  window: primaryCodexWindow(usage[account.id])
})

/** The Account a Project uses: its own choice, else the Default Account. */
export const projectCodexAccountId = (snapshot: CodexAccountsSnapshot, projectId: string): string =>
  snapshot.projectAccounts[projectId] ?? snapshot.defaultAccountId

/** Signed-in Accounts other than `currentId` with room left, least used first. */
export function rankCodexAlternatives(
  snapshot: CodexAccountsSnapshot,
  usage: Record<string, CodexAccountUsage>,
  currentId: string
): CodexAccountChoice[] {
  return snapshot.accounts
    .filter(
      (account) =>
        account.id !== currentId && codexAccountReadiness(account, usage[account.id]) === 'ready'
    )
    .map((account) => choice(account, usage))
    .filter((option) => (option.window?.percent ?? 0) < 100)
    .sort((left, right) => (left.window?.percent ?? 0) - (right.window?.percent ?? 0))
}

/**
 * The Codex Account context of one Project. `null` when there is no Project
 * or while the list loads.
 */
export function useProjectCodexAccount(projectId: string | null): ProjectCodexAccount | null {
  const accounts = useCodexAccounts({ enabled: Boolean(projectId), usage: true })
  const { snapshot, usage } = accounts
  if (!projectId || !snapshot) return null
  const defaultAccount =
    snapshot.accounts.find((account) => account.id === snapshot.defaultAccountId) ?? null
  const currentId = projectCodexAccountId(snapshot, projectId)
  const current = snapshot.accounts.find((account) => account.id === currentId)
  if (!current) return null
  return {
    accounts,
    projectId,
    current: choice(current, usage),
    defaultAccount,
    explicit: Boolean(snapshot.projectAccounts[projectId]),
    alternatives: rankCodexAlternatives(snapshot, usage, current.id)
  }
}

export function codexChoiceReady(account: CodexAccountView): boolean {
  return codexAccountReadiness(account) === 'ready'
}
