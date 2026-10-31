/**
 * Where the host's MCP catalog comes from and its live registry sync (spine
 * AD-3), for the browse screen. Polls while the settings page is shown: fast
 * while a sync runs so its progress moves, slowly otherwise so a finished
 * background sync still shows up.
 */

import type { IpcResult } from '@shared/types/ipc.types'
import type { McpCatalogStatus } from '@shared/types/mcp-catalog.types'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { McpCatalogSearch } from '@/hooks/use-mcp-catalog-search'
import { logFrontendError } from '@/lib/log-api'
import { mcpCatalogApi } from '@/lib/mcp-catalog-api'

export const MCP_CATALOG_SYNCING_POLL_MS = 2_000
export const MCP_CATALOG_IDLE_POLL_MS = 60_000

export type McpCatalogStatusState =
  | { status: 'loading' }
  /** No status has loaded yet; the next poll tries again. */
  | { status: 'unavailable' }
  /** `requested` is the sync setting a toggle in flight asked for. */
  | { status: 'ready'; catalog: McpCatalogStatus; requested: boolean | null }

type Action =
  | { type: 'loaded'; catalog: McpCatalogStatus }
  | { type: 'loadFailed' }
  | { type: 'toggle'; enabled: boolean }
  | { type: 'toggled'; catalog: McpCatalogStatus | null }

function reduce(state: McpCatalogStatusState, action: Action): McpCatalogStatusState {
  switch (action.type) {
    case 'loaded':
      return {
        status: 'ready',
        catalog: action.catalog,
        requested: state.status === 'ready' ? state.requested : null
      }
    case 'loadFailed':
      return state.status === 'ready' ? state : { status: 'unavailable' }
    case 'toggle':
      return state.status === 'ready' ? { ...state, requested: action.enabled } : state
    case 'toggled':
      if (state.status !== 'ready') return state
      return { status: 'ready', catalog: action.catalog ?? state.catalog, requested: null }
  }
}

function logStatusFailure(message: string): void {
  void logFrontendError({ level: 'warn', source: 'settings.McpCatalogBrowser', message })
}

export interface McpCatalogStatusHandle {
  state: McpCatalogStatusState
  /** Turn live sync on or off; resolves the host's answer, a failure included. */
  setSync: (enabled: boolean) => Promise<IpcResult<McpCatalogStatus>>
}

export function useMcpCatalogStatus(visible: boolean): McpCatalogStatusHandle {
  const [state, dispatch] = useReducer(reduce, { status: 'loading' })
  // Requests are numbered so a poll sent before a toggle can't overwrite the
  // status the toggle answered.
  const sent = useRef(0)
  const applied = useRef(0)
  const toggling = useRef(false)

  const refresh = useCallback(() => {
    if (toggling.current) return
    const request = ++sent.current
    void mcpCatalogApi.status().then((result) => {
      if (request < applied.current) return
      applied.current = request
      if (result.success) {
        dispatch({ type: 'loaded', catalog: result.data })
      } else {
        logStatusFailure(`MCP catalog status failed: ${result.code}`)
        dispatch({ type: 'loadFailed' })
      }
    })
  }, [])

  const syncing = state.status === 'ready' && state.catalog.sync.state === 'syncing'
  const interval = syncing ? MCP_CATALOG_SYNCING_POLL_MS : MCP_CATALOG_IDLE_POLL_MS

  useEffect(() => {
    if (visible) refresh()
  }, [visible, refresh])

  useEffect(() => {
    if (!visible) return
    const timer = setInterval(refresh, interval)
    return () => clearInterval(timer)
  }, [visible, interval, refresh])

  const setSync = useCallback(async (enabled: boolean) => {
    toggling.current = true
    dispatch({ type: 'toggle', enabled })
    const request = ++sent.current
    const result = await mcpCatalogApi.setSync(enabled)
    toggling.current = false
    applied.current = Math.max(applied.current, request)
    if (result.success) {
      dispatch({ type: 'toggled', catalog: result.data })
    } else {
      logStatusFailure(`MCP catalog sync ${enabled ? 'on' : 'off'} failed: ${result.code}`)
      dispatch({ type: 'toggled', catalog: null })
    }
    return result
  }, [])

  return { state, setSync }
}

/**
 * Re-runs the search when the host's catalog no longer matches the one the
 * results came from (a sync replaced it), once per catalog change, so the list
 * and its count move without a reload.
 */
export function useSearchFollowsCatalog(
  catalog: McpCatalogStatus | null,
  search: McpCatalogSearch
): void {
  const { state, retry } = search
  const results = state.status === 'ready' ? state.results : null
  const retriedFor = useRef<string | null>(null)

  useEffect(() => {
    if (catalog === null || results === null) return
    const behind =
      catalog.updatedAt !== results.updatedAt ||
      catalog.sample !== results.sample ||
      (results.query === '' && catalog.servers !== results.total)
    if (!behind) return
    const key = `${catalog.updatedAt}|${catalog.sample}|${catalog.servers}`
    if (retriedFor.current === key) return
    retriedFor.current = key
    retry()
  }, [catalog, results, retry])
}
