import type { GitCommit, GitCommitDetail } from '@shared/types/ipc.types'
import { toast } from 'sonner'
import { create } from 'zustand'
import { gitApi } from '@/lib/git-api'
import { logFrontendError } from '@/lib/log-api'

/** Which refs the history walks: every branch, tag and remote, or `HEAD` only. */
export type GitHistoryScope = 'all' | 'head'

/** Commits one history read returns. The host default for `git_get_log`, passed
 * explicitly so the renderer owns the number it shows (`200+` in the History row). */
export const GIT_LOG_LIMIT = 200

/** Commit details kept per session; the least recently used entry leaves first. */
const MAX_CACHED_DETAILS = 50

/** The HEAD commit and the length of the HEAD-scoped history (up to {@link GIT_LOG_LIMIT}). */
export interface HeadSummary {
  last: GitCommit | null
  count: number
}

/** One commit's detail request, keyed by working copy and full hash. */
export interface CommitDetailEntry {
  detail: GitCommitDetail | null
  loading: boolean
  error: string | null
}

export interface GitHistoryState {
  // commits[cwd] = GitCommit[] (newest first)
  commits: Record<string, GitCommit[]>
  // loading[cwd] = boolean
  loading: Record<string, boolean>
  // error[cwd] = string | null
  error: Record<string, string | null>
  // scope[cwd]; absent = 'all'
  scope: Record<string, GitHistoryScope>
  // details[commitDetailKey(cwd, hash)], least recently used first
  details: Record<string, CommitDetailEntry>
  // headSummary[cwd]: always read from HEAD, whatever the History tab's scope
  headSummary: Record<string, HeadSummary>

  refreshLog: (cwd: string, limit?: number) => Promise<void>
  /** Read the HEAD commit and the HEAD-scoped count; leaves `commits`, `scope`
   * and the History tab's loading state alone. Failures are logged, not toasted. */
  refreshHeadSummary: (cwd: string) => Promise<void>
  /** Change the refs the history walks, then reload it. */
  setScope: (cwd: string, scope: GitHistoryScope) => void
  /** Load one commit's detail once; a loaded or in-flight entry is reused. */
  loadCommitDetail: (cwd: string, hash: string) => Promise<void>
}

export function commitDetailKey(cwd: string, hash: string): string {
  return `${cwd}\u0000${hash}`
}

/** `details` with `entry` stored as the most recently used, oldest entries evicted. */
function withDetail(
  details: Record<string, CommitDetailEntry>,
  key: string,
  entry: CommitDetailEntry
): Record<string, CommitDetailEntry> {
  const next = { ...details }
  delete next[key]
  next[key] = entry
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_DETAILS))) {
    delete next[stale]
  }
  return next
}

export const useGitHistoryStore = create<GitHistoryState>((set, get) => ({
  commits: {},
  loading: {},
  error: {},
  scope: {},
  details: {},
  headSummary: {},

  refreshLog: async (cwd, limit = GIT_LOG_LIMIT) => {
    // Capture a per-cwd request token before awaiting so a later refresh that
    // resolves first cannot be overwritten by an earlier, slower response.
    const token = (logRequestVersions[cwd] ?? 0) + 1
    logRequestVersions[cwd] = token
    const isCurrent = () => logRequestVersions[cwd] === token
    const all = (get().scope[cwd] ?? 'all') === 'all'

    set((state) => ({
      loading: { ...state.loading, [cwd]: true },
      error: { ...state.error, [cwd]: null }
    }))

    try {
      const commits = await gitApi.getLog(cwd, limit, all)
      if (!isCurrent()) return
      set((state) => ({
        commits: { ...state.commits, [cwd]: commits },
        loading: { ...state.loading, [cwd]: false }
      }))
    } catch (err) {
      if (!isCurrent()) return
      const message = String(err)
      set((state) => ({
        // Keep any previously-loaded commits so a transient refresh failure
        // does not wipe the displayed history; only surface the error.
        loading: { ...state.loading, [cwd]: false },
        error: { ...state.error, [cwd]: message }
      }))
      toast.error(`Failed to load git history: ${message}`)
    }
  },

  refreshHeadSummary: async (cwd) => {
    const token = (headRequestVersions[cwd] ?? 0) + 1
    headRequestVersions[cwd] = token
    try {
      const commits = await gitApi.getLog(cwd, GIT_LOG_LIMIT, false)
      if (headRequestVersions[cwd] !== token) return
      set((state) => ({
        headSummary: {
          ...state.headSummary,
          [cwd]: { last: commits[0] ?? null, count: commits.length }
        }
      }))
    } catch (err) {
      if (headRequestVersions[cwd] !== token) return
      void logFrontendError({
        level: 'warn',
        source: 'git-history',
        message: `HEAD summary failed: ${err instanceof Error ? err.message : String(err)}`
      })
      // A non-git folder or a failed read settles to "no commits" instead of a
      // spinner; a previous summary stays.
      set((state) => ({
        headSummary: { [cwd]: { last: null, count: 0 }, ...state.headSummary }
      }))
    }
  },

  setScope: (cwd, scope) => {
    if ((get().scope[cwd] ?? 'all') === scope) return
    set((state) => ({ scope: { ...state.scope, [cwd]: scope } }))
    void get().refreshLog(cwd)
  },

  loadCommitDetail: async (cwd, hash) => {
    const key = commitDetailKey(cwd, hash)
    const existing = get().details[key]
    if (existing && (existing.loading || existing.detail)) {
      // A hit: move it to the most recently used end.
      if (Object.keys(get().details).at(-1) !== key) {
        set((state) => ({ details: withDetail(state.details, key, existing) }))
      }
      return
    }

    set((state) => ({
      details: withDetail(state.details, key, { detail: null, loading: true, error: null })
    }))
    try {
      const detail = await gitApi.getCommitDetail(cwd, hash)
      set((state) => ({
        details: withDetail(state.details, key, { detail, loading: false, error: null })
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void logFrontendError({
        level: 'warn',
        source: 'git-history',
        message: `commit detail failed for ${hash.slice(0, 12)}: ${message}`
      })
      set((state) => ({
        details: withDetail(state.details, key, { detail: null, loading: false, error: message })
      }))
    }
  }
}))

/** Monotonic request token per cwd, kept outside React state because it is
 * control metadata for discarding superseded in-flight fetches. */
const logRequestVersions: Record<string, number> = {}
const headRequestVersions: Record<string, number> = {}
