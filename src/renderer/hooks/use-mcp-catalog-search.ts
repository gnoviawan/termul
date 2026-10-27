/**
 * Paged MCP catalog search for the browse screen (spine AD-1). The host ranks
 * and pages; this hook holds only the pages the user has scrolled through, up
 * to {@link MCP_CATALOG_MAX_ROWS}, so no surface ever holds the full catalog.
 * Search is read-only on every transport, so shared-live viewers browse too.
 */

import {
  MCP_CATALOG_MAX_QUERY_TERMS,
  type McpCatalogPage,
  type McpCatalogRow
} from '@shared/types/mcp-catalog.types'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { mcpCatalogApi } from '@/lib/mcp-catalog-api'

export const MCP_CATALOG_PAGE_SIZE = 50
/** Past this many rows the list asks the user to narrow the search instead. */
export const MCP_CATALOG_MAX_ROWS = 500
export const MCP_CATALOG_SEARCH_DEBOUNCE_MS = 250

export interface McpCatalogResults {
  rows: McpCatalogRow[]
  total: number
  nextCursor: string | null
  snapshotFetchedAt: string | null
}

export type McpCatalogSearchState =
  /** `previous` keeps the last results on screen while a new query loads. */
  | { status: 'loading'; previous: McpCatalogResults | null }
  | { status: 'failed' }
  /** The host rejects the query, so it is never sent. */
  | { status: 'too-many-terms' }
  | { status: 'ready'; results: McpCatalogResults; more: 'idle' | 'loading' | 'failed' }

type Action =
  | { type: 'search' }
  | { type: 'searchFailed' }
  | { type: 'tooManyTerms' }
  | { type: 'loadMore' }
  | { type: 'loadMoreFailed' }
  | { type: 'page'; page: McpCatalogPage; append: boolean }

function reduce(state: McpCatalogSearchState, action: Action): McpCatalogSearchState {
  switch (action.type) {
    case 'search':
      return {
        status: 'loading',
        previous:
          state.status === 'ready'
            ? state.results
            : state.status === 'loading'
              ? state.previous
              : null
      }
    case 'searchFailed':
      return { status: 'failed' }
    case 'tooManyTerms':
      return { status: 'too-many-terms' }
    case 'loadMore':
    case 'loadMoreFailed':
      if (state.status !== 'ready') return state
      return { ...state, more: action.type === 'loadMore' ? 'loading' : 'failed' }
    case 'page': {
      const { page, append } = action
      const previous = append && state.status === 'ready' ? state.results.rows : []
      return {
        status: 'ready',
        more: 'idle',
        results: {
          rows: [...previous, ...page.items],
          total: page.total,
          nextCursor: page.nextCursor,
          snapshotFetchedAt: page.snapshotFetchedAt
        }
      }
    }
  }
}

function logSearchFailure(code: string, paging: boolean): void {
  void logFrontendError({
    level: 'warn',
    source: 'settings.McpCatalogBrowser',
    message: `MCP catalog ${paging ? 'next page' : 'search'} failed: ${code}`
  })
}

export interface McpCatalogSearch {
  state: McpCatalogSearchState
  /** Rows can still be fetched for this query without passing the row cap. */
  canLoadMore: boolean
  loadMore: () => void
  retry: () => void
}

/**
 * Searches once `active` first turns true (a hidden settings page fetches
 * nothing), then again whenever the trimmed query settles.
 */
export function useMcpCatalogSearch(query: string, active: boolean): McpCatalogSearch {
  const [state, dispatch] = useReducer(reduce, { status: 'loading', previous: null })
  const [activated, setActivated] = useState(active)
  if (active && !activated) setActivated(true)

  const trimmed = query.trim()
  const [settledQuery, setSettledQuery] = useState(trimmed)
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(trimmed), MCP_CATALOG_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trimmed])

  // Bumped per search; a response from an older search is dropped.
  const generation = useRef(0)
  const pageInFlight = useRef(false)
  const [retryCount, setRetryCount] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount re-runs the same search
  useEffect(() => {
    if (!activated) return
    const searchId = ++generation.current
    pageInFlight.current = false
    if (settledQuery.split(/\s+/).filter(Boolean).length > MCP_CATALOG_MAX_QUERY_TERMS) {
      dispatch({ type: 'tooManyTerms' })
      return
    }
    dispatch({ type: 'search' })
    void mcpCatalogApi
      .search({ query: settledQuery || undefined, limit: MCP_CATALOG_PAGE_SIZE })
      .then((result) => {
        if (searchId !== generation.current) return
        if (result.success) {
          dispatch({ type: 'page', page: result.data, append: false })
        } else {
          logSearchFailure(result.code, false)
          dispatch({ type: 'searchFailed' })
        }
      })
  }, [activated, settledQuery, retryCount])

  const cursor = state.status === 'ready' ? state.results.nextCursor : null
  const loadedRows = state.status === 'ready' ? state.results.rows.length : 0
  const canLoadMore = cursor !== null && loadedRows < MCP_CATALOG_MAX_ROWS

  const loadMore = useCallback(() => {
    if (!canLoadMore || cursor === null || pageInFlight.current) return
    const searchId = generation.current
    pageInFlight.current = true
    dispatch({ type: 'loadMore' })
    void mcpCatalogApi
      .search({ query: settledQuery || undefined, cursor, limit: MCP_CATALOG_PAGE_SIZE })
      .then((result) => {
        if (searchId !== generation.current) return
        pageInFlight.current = false
        if (result.success) {
          dispatch({ type: 'page', page: result.data, append: true })
        } else {
          logSearchFailure(result.code, true)
          dispatch({ type: 'loadMoreFailed' })
        }
      })
  }, [canLoadMore, cursor, settledQuery])

  const retry = useCallback(() => setRetryCount((count) => count + 1), [])

  return { state, canLoadMore, loadMore, retry }
}
