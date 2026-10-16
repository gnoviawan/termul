import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage
} from '@shared/types/claude-accounts.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { claudeAccountsApi } from '@/lib/claude-accounts-api'

/** The host caches usage for 5 minutes, so polling faster gains nothing. */
export const CLAUDE_USAGE_POLL_MS = 5 * 60 * 1000

export interface ClaudeAccountsState {
  snapshot: ClaudeAccountsSnapshot | null
  /** Latest usage read per Account id. */
  usage: Record<string, ClaudeAccountUsage>
  loading: boolean
  /** Why the Account list could not be read. */
  error: string | null
  refreshingUsage: boolean
  reload: () => Promise<void>
  refreshUsage: (force?: boolean) => Promise<void>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The Claude Account list and its usage, read on mount and every 5 minutes
 * while mounted. `usage: false` skips the usage reads; `enabled: false` reads
 * nothing (a closed modal that stays mounted).
 */
export function useClaudeAccounts(
  options: { usage?: boolean; enabled?: boolean } = {}
): ClaudeAccountsState {
  const withUsage = options.usage ?? true
  const enabled = options.enabled ?? true
  const [snapshot, setSnapshot] = useState<ClaudeAccountsSnapshot | null>(null)
  const [usage, setUsage] = useState<Record<string, ClaudeAccountUsage>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshingUsage, setRefreshingUsage] = useState(false)
  const mounted = useRef(true)

  const reload = useCallback(async () => {
    try {
      const next = await claudeAccountsApi.list()
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
      const reads = await claudeAccountsApi.usage(force)
      if (!mounted.current) return
      setUsage(Object.fromEntries(reads.map((read) => [read.accountId, read])))
    } catch {
      // The facade logs the failure; the rows keep their last read.
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
    const timer = setInterval(() => void refreshUsage(false), CLAUDE_USAGE_POLL_MS)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [reload, refreshUsage, withUsage, enabled])

  return { snapshot, usage, loading, error, refreshingUsage, reload, refreshUsage }
}
