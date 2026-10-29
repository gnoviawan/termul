import type { GitDiffStat, GitStatusDetail } from '@shared/types/ipc.types'
import { useEffect, useMemo, useRef } from 'react'
import type { GitDisplayStatus } from '@/lib/git-status-display'
import { logFrontendError } from '@/lib/log-api'
import { normalizePath } from '@/lib/working-copy'
import { selectGitDiffStat, useGitStatusStore } from '@/stores/git-status-store'

export const GIT_CHANGES_REFRESH_DEBOUNCE_MS = 500

/** One uncommitted file of the checkout. `path` is repository-root relative. */
export interface GitChangedFile {
  path: string
  status: GitDisplayStatus
  added: number
  removed: number
}

/**
 * `loading`: the status or the diff stat (which carries the repository root)
 * for the cwd has not been read yet. `unavailable`: the cwd is empty or git
 * status failed before any success (not a repository). `root`: the base of the
 * file paths — the repository root, or the cwd when the diff stat failed or
 * the host does not report the root.
 */
export type GitChangedFiles =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; root: string; files: GitChangedFile[] }

/** The working-tree state wins; a staged add, rename or delete shows over a
 * later unstaged edit. */
function displayStatus(entries: GitStatusDetail[]): GitDisplayStatus {
  const staged = entries.find((entry) => entry.staged)?.status
  const unstaged = entries.find((entry) => !entry.staged)?.status
  if (unstaged && unstaged !== 'modified' && unstaged !== 'staged') return unstaged
  if (staged && staged !== 'modified' && staged !== 'staged') return staged
  return 'modified'
}

/** One row per path of the status list (porcelain order), with the line
 * counts of the diff stat. A path the stat does not list yet counts 0. */
export function gitChangedFiles(
  statuses: readonly GitStatusDetail[],
  stat: GitDiffStat | null
): GitChangedFile[] {
  const byPath = new Map<string, GitStatusDetail[]>()
  for (const entry of statuses) {
    const entries = byPath.get(entry.path)
    if (entries) entries.push(entry)
    else byPath.set(entry.path, [entry])
  }
  const counts = new Map((stat?.files ?? []).map((file) => [file.path, file]))
  return Array.from(byPath, ([path, entries]) => ({
    path,
    status: displayStatus(entries),
    added: counts.get(path)?.added ?? 0,
    removed: counts.get(path)?.removed ?? 0
  }))
}

const LOADING: GitChangedFiles = { state: 'loading' }
const UNAVAILABLE: GitChangedFiles = { state: 'unavailable' }

/**
 * Live uncommitted files of the checkout at `cwd`, read from the git status
 * store. Refreshes on mount, and debounced when the agent's tool calls change
 * or its turn ends: an agent's own `git commit` or file delete touches no file
 * the watcher reports. Focus, the poll, terminal git events, file changes and
 * own git writes refresh the same store entries.
 */
export function useGitChangedFiles(
  cwd: string,
  toolCalls: unknown,
  turnActive: boolean
): GitChangedFiles {
  const key = cwd ? normalizePath(cwd) : ''
  const statuses = useGitStatusStore((state) => (key ? state.statuses[key] : undefined))
  const statusError = useGitStatusStore((state) => (key ? state.errors[key]?.status : undefined))
  const diffStatError = useGitStatusStore((state) =>
    key ? state.errors[key]?.diffStat : undefined
  )
  const stat = useGitStatusStore(selectGitDiffStat(cwd))

  // Declared before the refresh effect: an unwatched key skips the diff stat.
  useEffect(() => {
    if (!cwd) return
    return useGitStatusStore.getState().watchDiffStat(cwd)
  }, [cwd])

  const refreshedCwd = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: toolCalls and turnActive are refresh triggers only
  useEffect(() => {
    if (!cwd) return
    const refresh = () => {
      const store = useGitStatusStore.getState()
      // Failures are stored in `errors` and logged by the store.
      void store.refreshStatus(cwd).catch(() => {})
      void store.refreshDiffStat(cwd)
    }
    if (refreshedCwd.current !== cwd) {
      refreshedCwd.current = cwd
      refresh()
      return
    }
    const timer = setTimeout(refresh, GIT_CHANGES_REFRESH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [cwd, toolCalls, turnActive])

  const result = useMemo<GitChangedFiles>(() => {
    if (!key) return UNAVAILABLE
    if (!statuses) return statusError === undefined ? LOADING : UNAVAILABLE
    if (!stat && diffStatError === undefined) return LOADING
    const root = stat?.root || cwd
    return { state: 'ready', root, files: gitChangedFiles(statuses, stat) }
  }, [key, cwd, statuses, stat, statusError, diffStatError])

  const loggedUnavailableFor = useRef<string | null>(null)
  useEffect(() => {
    if (result.state !== 'unavailable' || !cwd || loggedUnavailableFor.current === cwd) return
    loggedUnavailableFor.current = cwd
    void logFrontendError({
      level: 'info',
      message: `ChatChangedFilesPanel: git status unavailable for ${cwd}; showing agent tool-call edits`,
      source: 'ChatChangedFilesPanel'
    })
  }, [result.state, cwd])

  return result
}
