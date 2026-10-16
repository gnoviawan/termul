import type { GitCommit } from '@shared/types/ipc.types'
import { useCallback, useEffect, useMemo } from 'react'
import { computeGraphLayout, type GraphLayout } from '@/lib/git-graph-layout'
import { useGitHistoryStore } from '@/stores/git-history-store'
import { matchesCommitQuery } from './commit-filter'
import { rowIndexByHash } from './lane-graph'

const NO_COMMITS: GitCommit[] = []

interface CommitHistoryFilter {
  /** Free text matched against subject, author, hash and refs. Trimmed here. */
  query?: string
  /** Exact author name. */
  author?: string | null
}

interface CommitHistory {
  /** Every loaded commit, newest first. */
  commits: GitCommit[]
  /** Whether a read has settled (so an empty `commits` means no commits). */
  hasLoaded: boolean
  /** Lane layout of the full list; a filter hides the graph, it never changes it. */
  layout: GraphLayout
  rowByHash: Map<string, number>
  /** The rows to show: graph order, or the filtered commits. */
  visible: GitCommit[]
  isFiltering: boolean
  isLoading: boolean
  error: string | null
  refresh: () => void
}

/**
 * The commit history of one working copy for both shells (desktop table and
 * phone list): the store reads, the fetch on first reveal, the lane layout
 * and the filtered rows. The lane graph reflects true topology, so it is
 * computed from the full list.
 */
export function useCommitHistory(
  cwd: string,
  isVisible: boolean,
  { query = '', author = null }: CommitHistoryFilter = {}
): CommitHistory {
  const stored = useGitHistoryStore((state) => state.commits[cwd])
  const isLoading = useGitHistoryStore((state) => state.loading[cwd] ?? false)
  const error = useGitHistoryStore((state) => state.error[cwd] ?? null)
  const refreshLog = useGitHistoryStore((state) => state.refreshLog)

  useEffect(() => {
    if (isVisible && stored === undefined) void refreshLog(cwd)
  }, [isVisible, cwd, stored, refreshLog])

  const commits = stored ?? NO_COMMITS
  const layout = useMemo(() => computeGraphLayout(commits), [commits])
  const rowByHash = useMemo(() => rowIndexByHash(layout), [layout])
  const q = query.trim().toLowerCase()
  const isFiltering = q.length > 0 || author !== null
  const visible = useMemo(
    () =>
      isFiltering
        ? commits.filter(
            (c) => (!author || c.author === author) && (!q || matchesCommitQuery(c, q))
          )
        : layout.rows.map((r) => r.commit),
    [commits, layout, isFiltering, author, q]
  )
  const refresh = useCallback(() => void refreshLog(cwd), [refreshLog, cwd])

  return {
    commits,
    hasLoaded: stored !== undefined,
    layout,
    rowByHash,
    visible,
    isFiltering,
    isLoading,
    error,
    refresh
  }
}
