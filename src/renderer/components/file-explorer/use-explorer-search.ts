import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { filesystemApi } from '@/lib/api'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorer, useFileExplorerActions } from '@/stores/file-explorer-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { ExplorerSearchResultsProps } from './explorer-search'

export interface ExplorerSearch {
  /** Raw query as typed. */
  query: string
  setQuery: (value: string) => void
  clear: () => void
  /** A non-blank query is typed: the results list shows. */
  isActive: boolean
  /**
   * The tree stays visible under an active query while the query is too
   * short, or while the first results for a new query are loading.
   */
  showsTree: boolean
  results: Omit<ExplorerSearchResultsProps, 'rootPath'>
}

/**
 * Explorer search: debounced streaming search in the project root, stream
 * cancel on unmount, and opening a match at its line.
 */
export function useExplorerSearch(rootPath: string | null): ExplorerSearch {
  const {
    searchQuery,
    searchResults,
    searchFileNameMatches,
    searchLoading,
    searchError,
    searchTruncated,
    searchScannedFiles,
    searchFailedFiles,
    searchLastCompletedQuery
  } = useFileExplorer()
  const { selectPath, setSearchQuery, searchInRoot, resetSearch } = useFileExplorerActions()
  const searchDebounceRef = useRef<number | null>(null)
  const searchRequestIdRef = useRef(0)

  const query = searchQuery ?? ''
  const safeResults = searchResults ?? []
  const safeFileNameMatches = searchFileNameMatches ?? []
  const trimmedQuery = query.trim()
  const isActive = trimmedQuery.length > 0
  const isTooShort = isActive && trimmedQuery.length < 2
  const hasAnyResults = safeResults.length > 0 || safeFileNameMatches.length > 0
  const resultsAreCurrent = searchLastCompletedQuery === trimmedQuery
  const showEmptyState =
    trimmedQuery.length >= 2 &&
    resultsAreCurrent &&
    !searchLoading &&
    !searchError &&
    !hasAnyResults

  useEffect(() => {
    resetSearch()
  }, [resetSearch])

  useEffect(() => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current)
    }

    if (!rootPath) {
      return
    }

    searchDebounceRef.current = window.setTimeout(
      () => {
        searchRequestIdRef.current += 1
        void searchInRoot(query, searchRequestIdRef.current)
      },
      trimmedQuery.length >= 3 ? 90 : 180
    )

    return () => {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current)
      }
    }
  }, [rootPath, query, searchInRoot, trimmedQuery.length])

  // Cancel the stream this explorer started when it unmounts. The store is a
  // module-level singleton, so a search can still be walking when the panel
  // goes away. This effect runs once: an id captured at setup is still 0
  // after the user searches, and the rg child keeps running. The ref is the
  // id this hook issued. A newer id in the store belongs to another search
  // and is left alone.
  useEffect(() => {
    return () => {
      const id = searchRequestIdRef.current
      if (id > 0) {
        const sid = `search-${id}`
        // Surface silent IPC failures so a stuck rg process is at least
        // visible in the console; the cancel is still fire-and-forget
        // from the user's perspective.
        filesystemApi.searchFileNamesStreamCancel(sid).catch((e) => {
          console.warn(`[file-explorer] searchFileNamesStreamCancel(${sid}) failed:`, e)
        })
        filesystemApi.searchContentStreamCancel(sid).catch((e) => {
          console.warn(`[file-explorer] searchContentStreamCancel(${sid}) failed:`, e)
        })
      }
    }
  }, [])

  const openMatch = useCallback(
    async (filePath: string, lineNumber: number) => {
      const searchTerm = searchLastCompletedQuery.trim()
      selectPath(filePath)
      try {
        await useEditorStore.getState().openFile(filePath)
        useWorkspaceStore.getState().addEditorTab(filePath)
        const isMarkdown = /\.md$/i.test(filePath)
        if (isMarkdown) {
          useEditorStore.getState().setViewMode(filePath, 'code')
        }
        useEditorStore.getState().updateCursorPosition(filePath, lineNumber, 1)
        const revealDetail = { filePath, lineNumber, searchTerm }
        ;(
          window as unknown as { __termulPendingRevealLine?: typeof revealDetail }
        ).__termulPendingRevealLine = revealDetail
        window.dispatchEvent(
          new CustomEvent('termul:reveal-line', {
            detail: revealDetail
          })
        )
        requestAnimationFrame(() => {
          window.dispatchEvent(
            new CustomEvent('termul:reveal-line', {
              detail: revealDetail
            })
          )
        })
      } catch {
        toast.warning('File opened, but failed to focus target line')
      }
    },
    [searchLastCompletedQuery, selectPath]
  )

  return {
    query,
    setQuery: setSearchQuery,
    clear: resetSearch,
    isActive,
    showsTree: !isActive || isTooShort || (searchLoading && !resultsAreCurrent),
    results: {
      query,
      trimmedQuery,
      results: safeResults,
      fileNameMatches: safeFileNameMatches,
      fileNameMatchesPending: searchFileNameMatches === null,
      loading: searchLoading,
      error: searchError,
      isTooShort,
      showEmptyState,
      resultsAreCurrent,
      truncated: searchTruncated,
      scannedFiles: searchScannedFiles,
      failedFiles: searchFailedFiles,
      onOpenMatch: (filePath, lineNumber) => void openMatch(filePath, lineNumber)
    }
  }
}
