import type { GitStatusDetail } from '@shared/types/ipc.types'
import { useEffect, useMemo, useState } from 'react'
import { normalizePath } from '@/lib/working-copy'
import { useGitStatusStore } from '@/stores/git-status-store'

interface UseGitPanelModelOptions {
  cwd: string
  isVisible: boolean
}

/**
 * Store wiring shared by the Git panels (`GitPanel` and the shell
 * `ChangesPanel`): the status / commit-context / stash / branch refresh while
 * visible, the working copy's branches and stashes, the "Filter changes"
 * query and the filtered staged / unstaged lists.
 */
export function useGitPanelModel({ cwd, isVisible }: UseGitPanelModelOptions) {
  const statuses = useGitStatusStore((state) => state.statuses)
  const selectedFile = useGitStatusStore((state) => state.selectedFile)
  const refreshStatus = useGitStatusStore((state) => state.refreshStatus)
  const fetchCommitContext = useGitStatusStore((state) => state.fetchCommitContext)

  const stashesState = useGitStatusStore((state) => state.stashes)
  const branchesState = useGitStatusStore((state) => state.branches)
  const fetchStashes = useGitStatusStore((state) => state.fetchStashes)
  const fetchBranches = useGitStatusStore((state) => state.fetchBranches)

  // The store keys every working copy by its canonical path.
  const key = normalizePath(cwd)
  const stashes = stashesState[key] ?? []
  const branches = branchesState[key] ?? []

  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (isVisible) {
      // `refreshStatus` records the failure in the store and rethrows; a non-git
      // folder or an IPC failure must not surface as an unhandled rejection.
      Promise.resolve(refreshStatus(cwd)).catch(() => {
        // Stored in the store's `errors` and logged by `refreshStatus`.
      })
      fetchCommitContext(cwd)
      fetchStashes(cwd)
      fetchBranches(cwd)
    }
  }, [isVisible, cwd, refreshStatus, fetchCommitContext, fetchStashes, fetchBranches])

  const filteredStatuses = useMemo(() => {
    const currentStatuses = statuses[key] || []
    if (!searchQuery) return currentStatuses
    return currentStatuses.filter((s: GitStatusDetail) =>
      s.path.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [statuses, key, searchQuery])

  const { stagedFiles, unstagedFiles } = useMemo(() => {
    const staged = filteredStatuses.filter((s: GitStatusDetail) => s.staged)
    const unstaged = filteredStatuses.filter((s: GitStatusDetail) => !s.staged)
    return { stagedFiles: staged, unstagedFiles: unstaged }
  }, [filteredStatuses])

  return {
    selectedFile,
    stashes,
    branches,
    searchQuery,
    setSearchQuery,
    stagedFiles,
    unstagedFiles
  }
}
