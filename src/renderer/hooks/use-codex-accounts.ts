import type { CodexAccountsSnapshot } from '@shared/types/codex-accounts.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { codexAccountsApi } from '@/lib/codex-accounts-api'

export interface CodexAccountsState {
  snapshot: CodexAccountsSnapshot | null
  loading: boolean
  /** Why the Account list could not be read. */
  error: string | null
  reload: () => Promise<void>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The Codex Account list, read on mount. `enabled: false` reads nothing (a
 * closed modal that stays mounted, or a chat that is not a Codex chat).
 */
export function useCodexAccounts(options: { enabled?: boolean } = {}): CodexAccountsState {
  const enabled = options.enabled ?? true
  const [snapshot, setSnapshot] = useState<CodexAccountsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const reload = useCallback(async () => {
    try {
      const next = await codexAccountsApi.list()
      if (!mounted.current) return
      setSnapshot(next)
      setError(null)
    } catch (err) {
      if (mounted.current) setError(message(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    if (!enabled) {
      return () => {
        mounted.current = false
      }
    }
    void reload()
    return () => {
      mounted.current = false
    }
  }, [reload, enabled])

  return { snapshot, loading, error, reload }
}
