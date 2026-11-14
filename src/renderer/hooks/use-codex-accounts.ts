import type { CodexAccountsSnapshot, CodexAccountUsage } from '@shared/types/codex-accounts.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { codexAccountsApi } from '@/lib/codex-accounts-api'

/** The host caches usage for 5 minutes, so polling faster gains nothing. */
export const CODEX_USAGE_POLL_MS = 5 * 60 * 1000

export interface CodexAccountsState {
  snapshot: CodexAccountsSnapshot | null
  /** Latest usage read per Account id. */
  usage: Record<string, CodexAccountUsage>
  loading: boolean
  /** Why the Account list could not be read. */
  error: string | null
  refreshingUsage: boolean
  reload: () => Promise<void>
  refreshUsage: (force?: boolean) => Promise<void>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The Codex Account list, read on mount. `usage: true` also reads plan windows
 * every 5 minutes. `enabled: false` reads nothing (a closed modal that stays
 * mounted, or a chat that is not a Codex chat).
 */
export function useCodexAccounts(
  options: { enabled?: boolean; usage?: boolean } = {}
): CodexAccountsState {
  const enabled = options.enabled ?? true
  const withUsage = options.usage ?? false
  const [snapshot, setSnapshot] = useState<CodexAccountsSnapshot | null>(null)
  const [usage, setUsage] = useState<Record<string, CodexAccountUsage>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshingUsage, setRefreshingUsage] = useState(false)
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

  const refreshUsage = useCallback(async (force = false) => {
    setRefreshingUsage(true)
    try {
      const reads = await codexAccountsApi.usage(force)
      if (!mounted.current) return
      setUsage(Object.fromEntries(reads.map((read) => [read.accountId, read])))
    } catch {
      // The facade logs the failure. Rows keep the last good read.
    } finally {
      if (mounted.current) setRefreshingUsage(false)
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
    if (!withUsage) {
      return () => {
        mounted.current = false
      }
    }
    void refreshUsage(false)
    const timer = setInterval(() => void refreshUsage(false), CODEX_USAGE_POLL_MS)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [reload, refreshUsage, withUsage, enabled])

  return { snapshot, usage, loading, error, refreshingUsage, reload, refreshUsage }
}
