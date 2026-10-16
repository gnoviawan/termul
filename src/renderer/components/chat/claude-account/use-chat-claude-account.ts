import type {
  ClaudeAccountUsage,
  ClaudeAccountView,
  ClaudeRateLimit,
  ClaudeUsageWindow
} from '@shared/types/claude-accounts.types'
import { type ClaudeAccountsState, useClaudeAccounts } from '@/hooks/use-claude-accounts'
import { primaryUsageWindow } from '@/lib/claude-usage-format'
import { useAcpStore } from '@/stores/acp-store'
import { isClaudeSession } from '@/stores/claude-account-switch'

export interface AccountChoice {
  account: ClaudeAccountView
  usage: ClaudeAccountUsage | undefined
  window: ClaudeUsageWindow | null
}

export interface ChatClaudeAccount {
  accounts: ClaudeAccountsState
  projectId: string
  /** The Account this chat's Project uses now. */
  current: AccountChoice
  defaultAccount: ClaudeAccountView | null
  /** `true` when the Project chose an Account (not "Follow default"). */
  explicit: boolean
  /** Live limit state from the running turn, when Claude sent one. */
  rateLimit: ClaudeRateLimit | null
  /** Signed-in Accounts with room left, least used first. */
  alternatives: AccountChoice[]
}

const choice = (
  account: ClaudeAccountView,
  usage: Record<string, ClaudeAccountUsage>
): AccountChoice => ({
  account,
  usage: usage[account.id],
  window: primaryUsageWindow(usage[account.id])
})

/** The Claude Account context of one chat; `null` for a chat that is not a managed Claude chat. */
export function useChatClaudeAccount(sessionId: string): ChatClaudeAccount | null {
  const isClaude = useAcpStore((s) => isClaudeSession(s, sessionId))
  const projectId = useAcpStore((s) => s.sessions?.[sessionId]?.projectId ?? '')
  const rateLimit = useAcpStore((s) => s.sessionUsage?.[sessionId]?.rateLimit ?? null)
  const accounts = useClaudeAccounts({ enabled: isClaude })
  const { snapshot, usage } = accounts
  if (!isClaude || !snapshot || !projectId) return null

  const defaultAccount = snapshot.accounts.find((a) => a.id === snapshot.defaultAccountId) ?? null
  const chosenId = snapshot.projectAccounts[projectId]
  const currentAccount = snapshot.accounts.find(
    (a) => a.id === (chosenId ?? snapshot.defaultAccountId)
  )
  if (!currentAccount) return null

  const alternatives = snapshot.accounts
    .filter((a) => a.id !== currentAccount.id && a.signedIn !== false)
    .map((a) => choice(a, usage))
    .filter((c) => c.usage?.status !== 'signed_out' && (c.window?.percent ?? 0) < 100)
    .sort((x, y) => (x.window?.percent ?? 0) - (y.window?.percent ?? 0))

  return {
    accounts,
    projectId,
    current: choice(currentAccount, usage),
    defaultAccount,
    explicit: Boolean(chosenId),
    rateLimit,
    alternatives
  }
}
