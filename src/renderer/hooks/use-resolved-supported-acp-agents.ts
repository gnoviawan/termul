import { useCallback, useEffect, useState } from 'react'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  resolveAcpAgentCatalog,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { logFrontendError } from '@/lib/log-api'
import { onWindowFocus } from '@/lib/window-focus-api'

/** Waits before each re-fetch of a failed catalog; once spent, the hook reports `unavailable`. */
const CATALOG_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const

/**
 * - `loading`: no catalog yet (first fetch in flight, or a retry pending after a failure).
 * - `ready`: the host catalog resolved.
 * - `unavailable`: every retry failed; `retry()` or the window regaining focus tries again.
 *
 * While not `ready`, `entries` holds only persisted custom agents.
 */
export type AcpAgentCatalogStatus = 'loading' | 'ready' | 'unavailable'

export interface ResolvedSupportedAcpAgents {
  status: AcpAgentCatalogStatus
  entries: readonly SupportedAcpAgentEntry[]
  retry: () => void
}

type CatalogState = Omit<ResolvedSupportedAcpAgents, 'retry'>

const INITIAL_STATE: CatalogState = { status: 'loading', entries: [] }

/**
 * Resolve supported ACP agents from the host-resolved catalog (CAP-6 / Story 8).
 *
 * The host is the single source of truth for OS, arch, runtime availability,
 * and per-agent installability status — the renderer never probes
 * `@tauri-apps/plugin-os` or PATH locally. A failed catalog fetch is retried
 * with bounded backoff, so one transient error does not leave the list empty
 * for the session. Re-resolves when `persistedConfigs` changes (e.g. the user
 * saves a new agent config so it is projected as `ready`).
 */
export function useResolvedSupportedAcpAgentsState(
  persistedConfigs: readonly StoredAgentConfig[]
): ResolvedSupportedAcpAgents {
  const [state, setState] = useState<CatalogState>(INITIAL_STATE)
  const [generation, setGeneration] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` re-runs the resolution on retry().
  useEffect(() => {
    let cancelled = false
    let failures = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const fail = (entries: readonly SupportedAcpAgentEntry[], reason: string): void => {
      const delay = CATALOG_RETRY_DELAYS_MS[failures]
      failures += 1
      if (delay === undefined) {
        void logFrontendError({
          level: 'warn',
          source: 'use-resolved-supported-acp-agents',
          message: `ACP agent catalog unavailable after ${failures} attempts: ${reason}`
        })
        setState({ status: 'unavailable', entries })
        return
      }
      setState({ status: 'loading', entries })
      retryTimer = setTimeout(resolve, delay)
    }

    const resolve = (): void => {
      resolveAcpAgentCatalog(persistedConfigs).then(
        ({ entries, catalogAvailable }) => {
          if (cancelled) return
          if (catalogAvailable) setState({ status: 'ready', entries })
          else fail(entries, 'catalog fetch failed')
        },
        (error: unknown) => {
          if (!cancelled) fail([], error instanceof Error ? error.message : String(error))
        }
      )
    }

    resolve()
    const stopFocus = onWindowFocus(() => {
      if (failures <= CATALOG_RETRY_DELAYS_MS.length) return
      failures = 0
      setState((current) => ({ ...current, status: 'loading' }))
      resolve()
    })
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      stopFocus()
    }
  }, [persistedConfigs, generation])

  const retry = useCallback(() => {
    setState((current) => ({ ...current, status: 'loading' }))
    setGeneration((n) => n + 1)
  }, [])
  return { ...state, retry }
}

/** The resolved entries alone, for callers that have no loading or failure UI. */
export function useResolvedSupportedAcpAgents(
  persistedConfigs: readonly StoredAgentConfig[]
): readonly SupportedAcpAgentEntry[] {
  return useResolvedSupportedAcpAgentsState(persistedConfigs).entries
}
