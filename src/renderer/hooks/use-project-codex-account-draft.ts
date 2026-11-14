import { useCallback, useEffect, useState } from 'react'
import { type CodexAccountsState, useCodexAccounts } from '@/hooks/use-codex-accounts'
import { codexAccountsApi } from '@/lib/codex-accounts-api'

export interface ProjectCodexAccountDraft {
  accounts: CodexAccountsState
  /** Account id, or `null` for the Default Account. */
  value: string | null
  dirty: boolean
  setValue: (accountId: string | null) => void
  /** Write the choice to the host; resolves `true` when it changed something. */
  save: () => Promise<boolean>
  reset: () => void
}

/**
 * The Project Account choice as a draft, so Project Settings saves it with its
 * footer Save. `enabled: false` (a closed modal) reads nothing.
 */
export function useProjectCodexAccountDraft(
  projectId: string | undefined,
  options: { enabled?: boolean } = {}
): ProjectCodexAccountDraft {
  const accounts = useCodexAccounts({ enabled: options.enabled ?? true })
  const saved = projectId ? (accounts.snapshot?.projectAccounts[projectId] ?? null) : null
  const [value, setValue] = useState<string | null>(saved)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!dirty) setValue(saved)
  }, [saved, dirty])

  const save = useCallback(async () => {
    if (!projectId || !dirty) return false
    await codexAccountsApi.setProjectAccount(projectId, value)
    setDirty(false)
    await accounts.reload()
    return true
  }, [projectId, dirty, value, accounts])

  return {
    accounts,
    value,
    dirty,
    setValue: (next) => {
      setValue(next)
      setDirty(next !== saved)
    },
    save,
    reset: () => {
      setValue(saved)
      setDirty(false)
    }
  }
}
