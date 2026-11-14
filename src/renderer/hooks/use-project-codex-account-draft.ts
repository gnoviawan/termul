import { useCallback, useEffect, useRef, useState } from 'react'
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
  const projectRef = useRef(projectId)
  const revision = useRef(0)

  useEffect(() => {
    if (projectRef.current !== projectId) {
      projectRef.current = projectId
      revision.current += 1
      setValue(saved)
      setDirty(false)
      return
    }
    if (!dirty) setValue(saved)
  }, [projectId, saved, dirty])

  const save = useCallback(async () => {
    if (!projectId || !dirty) return false
    const submitted = { projectId, revision: revision.current, value }
    await codexAccountsApi.setProjectAccount(submitted.projectId, submitted.value)
    if (projectRef.current === submitted.projectId && revision.current === submitted.revision) {
      setDirty(false)
    }
    await accounts.reload()
    return true
  }, [projectId, dirty, value, accounts])

  return {
    accounts,
    value,
    dirty,
    setValue: (next) => {
      revision.current += 1
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
