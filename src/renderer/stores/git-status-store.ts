import {
  type GitCommitContext,
  type GitDiffStat,
  type GitStashInfo,
  type GitStatusDetail,
  PRECONDITION_FAILED_CODE
} from '@shared/types/ipc.types'
import { toast } from 'sonner'
import { create } from 'zustand'
import { AcpTransportError } from '@/lib/acp-transport/types'
import { isGitWriteBlocked } from '@/lib/active-working-copy'
import { gitApi } from '@/lib/git-api'
import { logFrontendError } from '@/lib/log-api'
import { platform } from '@/lib/tauri-os'
import { normalizePath } from '@/lib/working-copy'
import { useProjectStore } from './project-store'
import { useTerminalStore } from './terminal-store'

/**
 * Single git cache (shell revamp AD-17). Every per-working-copy map is keyed by
 * `normalizePath(path)` so `E:\p` and `e:/p/` share one entry; `paths[key]`
 * keeps the first display path seen (usable as a cwd) for refreshes. Callers
 * keep passing the raw `cwd` to actions and read through the same key.
 */

/** Build the staged-aware diff cache key so the staged and unstaged rows of the
 * same file (porcelain `MM`) do not collide. `cwd` is normalized. */
export const diffKey = (cwd: string, path: string, staged: boolean) =>
  `${normalizePath(cwd)}:${path}:${staged}`

/**
 * Changed files for `cwd`. A file that is both staged and unstaged has two
 * status entries but counts once, so every Git badge shows the same number.
 */
export const selectChangedFileCount =
  (cwd: string | null | undefined) =>
  (state: Pick<GitStatusState, 'statuses'>): number => {
    const statuses = cwd ? state.statuses[normalizePath(cwd)] : undefined
    if (!statuses || statuses.length === 0) return 0
    return new Set(statuses.map((status) => status.path)).size
  }

/** Per-state changed-file counts for the Status bar. */
export interface GitStatusCounts {
  modified: number
  staged: number
  untracked: number
  hasChanges: boolean
}

/**
 * Status bar counts from one working copy's cached status list: `modified` =
 * tracked entries that are not staged, `staged` = staged entries, `untracked`
 * = untracked entries. A file counts once per bucket (porcelain `MM` is one
 * staged plus one modified file, never two of either).
 */
export function countGitStatuses(
  statuses: ReadonlyArray<GitStatusDetail> | null | undefined
): GitStatusCounts {
  const modified = new Set<string>()
  const staged = new Set<string>()
  const untracked = new Set<string>()
  for (const entry of statuses ?? []) {
    if (entry.staged) staged.add(entry.path)
    if (entry.status === 'untracked') untracked.add(entry.path)
    else if (!entry.staged) modified.add(entry.path)
  }
  return {
    modified: modified.size,
    staged: staged.size,
    untracked: untracked.size,
    hasChanges: modified.size + staged.size + untracked.size > 0
  }
}

/** Current branch of the cached commit context (`null` on a detached HEAD or
 * when nothing is cached). There is no second branch cache. */
export const selectGitBranch =
  (cwd: string | null | undefined) =>
  (state: Pick<GitStatusState, 'commitContexts'>): string | null =>
    (cwd ? state.commitContexts[normalizePath(cwd)]?.branch : null) ?? null

export const selectGitDiffStat =
  (cwd: string | null | undefined) =>
  (state: Pick<GitStatusState, 'diffStats'>): GitDiffStat | null =>
    (cwd ? state.diffStats[normalizePath(cwd)] : null) ?? null

const NO_ERRORS: GitStatusErrors = Object.freeze({})

export const selectGitErrors =
  (cwd: string | null | undefined) =>
  (state: Pick<GitStatusState, 'errors'>): GitStatusErrors =>
    (cwd ? state.errors[normalizePath(cwd)] : undefined) ?? NO_ERRORS

/** The deepest tracked key containing `path` (segment-bounded prefix), or
 * `null` when no tracked working copy contains it. */
export function deepestTrackedKey(path: string, keys: Iterable<string>): string | null {
  const target = normalizePath(path)
  if (!target) return null
  let best: string | null = null
  for (const key of keys) {
    if (!key) continue
    const contains = target === key || target.startsWith(key.endsWith('/') ? key : `${key}/`)
    if (contains && (best === null || key.length > best.length)) best = key
  }
  return best
}

export interface FetchDiffOptions {
  /** Default `true`. `false` skips the empty sentinel and the toast. */
  notify?: boolean
}

/** Failure messages per facade call; set on failure, cleared on success. */
export interface GitStatusErrors {
  status?: string
  commitContext?: string
  diffStat?: string
}

export interface GitStatusState {
  // Keys below are `normalizePath(cwd)`.
  // paths[key] = first display path seen for the key (usable as a cwd)
  paths: Record<string, string>
  // statuses[key] = GitStatusDetail[]
  statuses: Record<string, GitStatusDetail[]>
  // diffs["key:path:staged"] = string
  diffs: Record<string, string>
  // diffErrors["key:path:staged"] = last `fetchDiff` failure message; cleared when
  // the fetch starts or succeeds and when the file's diffs are invalidated
  diffErrors: Record<string, string>
  // commitContexts[key] = GitCommitContext
  commitContexts: Record<string, GitCommitContext>
  // diffStats[key] = added/removed line totals (watched keys only)
  diffStats: Record<string, GitDiffStat>
  // errors[key] = last failure message per facade call
  errors: Record<string, GitStatusErrors>
  // stashes[key] = GitStashInfo[]
  stashes: Record<string, GitStashInfo[]>
  // branches[key] = string[]
  branches: Record<string, string[]>
  selectedFile: string | null
  isFetchingStatus: boolean
  statusFetchCount: number

  setSelectedFile: (path: string | null) => void
  refreshStatus: (cwd: string) => Promise<void>
  /** Fetches the diff stat of a watched key, at most once per 30 s; a throttled
   * request schedules one trailing refresh. No-op for unwatched keys. */
  refreshDiffStat: (cwd: string) => Promise<void>
  /** Ref-counted opt-in to diff-stat refreshes for `cwd`; returns the unwatch fn. */
  watchDiffStat: (cwd: string) => () => void
  /** Status + commit context + (if watched) diff stat for one working copy.
   * Never rejects; failures land in `errors`. */
  refreshWorkingCopy: (cwd: string) => Promise<void>
  /** `refreshWorkingCopy` for every tracked key, at most
   * `TRACKED_REFRESH_CONCURRENCY` at a time and each bounded by
   * `TRACKED_REFRESH_TIMEOUT_MS`. A call during a run shares one trailing run
   * and settles when it ends. Never rejects. */
  refreshTracked: () => Promise<void>
  /** Fetches one file side's diff. A failure always lands in `diffErrors`; by
   * default it also writes the empty sentinel and toasts (the Git panel's
   * behaviour). `{ notify: false }` keeps the cache empty and stays silent
   * (one warn log only) for surfaces that render their own failure state. */
  fetchDiff: (
    cwd: string,
    path: string,
    staged: boolean,
    options?: FetchDiffOptions
  ) => Promise<void>
  fetchCommitContext: (cwd: string) => Promise<GitCommitContext | null>
  fetchStashes: (cwd: string) => Promise<void>
  fetchBranches: (cwd: string) => Promise<void>
  stageFile: (cwd: string, path: string) => Promise<void>
  unstageFile: (cwd: string, path: string) => Promise<void>
  discardFile: (cwd: string, path: string) => Promise<void>
  stageFiles: (cwd: string, paths: string[]) => Promise<void>
  unstageFiles: (cwd: string, paths: string[]) => Promise<void>
  discardFiles: (cwd: string, paths: string[]) => Promise<void>
  stageHunk: (cwd: string, path: string, hunkPatch: string) => Promise<void>
  unstageHunk: (cwd: string, path: string, hunkPatch: string) => Promise<void>
  commit: (cwd: string, summary: string, description: string, amend: boolean) => Promise<void>
  push: (cwd: string) => Promise<void>
  stashSave: (cwd: string, message?: string, includeUntracked?: boolean) => Promise<void>
  stashApply: (cwd: string, index: number) => Promise<void>
  stashPop: (cwd: string, index: number) => Promise<void>
  stashDrop: (cwd: string, index: number) => Promise<void>
  branchSwitch: (cwd: string, name: string) => Promise<void>
  branchCreate: (cwd: string, name: string) => Promise<void>
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  paths: {},
  statuses: {},
  diffs: {},
  diffErrors: {},
  commitContexts: {},
  diffStats: {},
  errors: {},
  stashes: {},
  branches: {},
  selectedFile: null,
  isFetchingStatus: false,
  statusFetchCount: 0,

  setSelectedFile: (path) => set({ selectedFile: path }),

  refreshStatus: async (cwd) => {
    const key = trackPath(cwd)
    // Per-key request ordering: a slow earlier refresh (focus/poll started before
    // a git write) must not overwrite the newer status from the write's refresh.
    // biome-ignore lint/suspicious/noAssignInExpressions: deliberate request-token bump and capture
    const token = (statusRequests[key] = (statusRequests[key] ?? 0) + 1)
    const isCurrent = () => statusRequests[key] === token
    set((state) => ({
      statusFetchCount: state.statusFetchCount + 1,
      isFetchingStatus: true
    }))
    try {
      const status = await gitApi.getStatus(cwd)
      if (isCurrent()) {
        set((state) => ({
          statuses: { ...state.statuses, [key]: status }
        }))
        patchError(key, 'status', null)
      }
    } catch (error) {
      // Keep the previous status; record the failure and let the caller decide.
      if (isCurrent()) patchError(key, 'status', errorMessage(error))
      logFailure('status refresh', key, error)
      throw error
    } finally {
      set((state) => {
        const statusFetchCount = Math.max(0, state.statusFetchCount - 1)
        return {
          statusFetchCount,
          isFetchingStatus: statusFetchCount > 0
        }
      })
    }
  },

  refreshDiffStat: async (cwd) => {
    const key = normalizePath(cwd)
    if (!diffStatWatchers.has(key)) return
    const now = Date.now()
    const last = diffStatLastFetch.get(key)
    if (last !== undefined && now - last < DIFF_STAT_MIN_INTERVAL_MS) {
      // Throttled: coalesce into one trailing refresh at `last + 30 s`.
      if (!diffStatTrailing.has(key)) {
        diffStatTrailing.set(
          key,
          setTimeout(
            () => {
              diffStatTrailing.delete(key)
              void get().refreshDiffStat(cwd)
            },
            last + DIFF_STAT_MIN_INTERVAL_MS - now
          )
        )
      }
      return
    }
    diffStatLastFetch.set(key, now)
    trackPath(cwd)
    try {
      const stat = await gitApi.getDiffStat(cwd)
      set((state) => ({ diffStats: { ...state.diffStats, [key]: stat } }))
      patchError(key, 'diffStat', null)
    } catch (error) {
      patchError(key, 'diffStat', errorMessage(error))
      logFailure('diff stat refresh', key, error)
    }
  },

  watchDiffStat: (cwd) => {
    const key = trackPath(cwd)
    diffStatWatchers.set(key, (diffStatWatchers.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (diffStatWatchers.get(key) ?? 1) - 1
      if (remaining > 0) {
        diffStatWatchers.set(key, remaining)
        return
      }
      diffStatWatchers.delete(key)
      clearDiffStatTrailing(key)
    }
  },

  refreshWorkingCopy: async (cwd) => {
    await Promise.all([
      get()
        .refreshStatus(cwd)
        .catch(() => {
          // Stored in `errors` and logged by refreshStatus.
        }),
      get().fetchCommitContext(cwd),
      get().refreshDiffStat(cwd)
    ])
  },

  refreshTracked: () => {
    // Coalesce: while a run is in flight, every further call shares one trailing
    // run (which re-reads the tracked keys when it starts).
    const control = trackedRefresh
    if (control.trailing) return control.trailing
    if (control.inFlight) {
      const trailing: Promise<void> = control.inFlight
        .then(() => {
          if (control !== trackedRefresh) return
          control.trailing = null
          return startTrackedRun(get)
        })
        .catch((error: unknown) => {
          // Never wedge: a rejected chain must not stay the shared trailing run.
          if (control.trailing === trailing) control.trailing = null
          logFailure('tracked refresh', 'trailing run', error)
        })
      control.trailing = trailing
      return trailing
    }
    return startTrackedRun(get)
  },

  fetchCommitContext: async (cwd) => {
    const key = trackPath(cwd)
    // Guard against out-of-order responses: a slow earlier fetch must not
    // overwrite or delete a fresher result. Mirror the fetchDiff token pattern.
    // biome-ignore lint/suspicious/noAssignInExpressions: deliberate request-token bump and capture
    const token = (commitContextRequests[key] = (commitContextRequests[key] ?? 0) + 1)
    const isCurrent = () => commitContextRequests[key] === token
    try {
      const context = await gitApi.getCommitContext(cwd)
      const head = isCurrent() ? await readHead(cwd, context.hasHead) : undefined
      if (isCurrent() && head !== undefined) {
        knownHeads[key] = head
      }
      if (isCurrent()) {
        set((state) => ({
          commitContexts: { ...state.commitContexts, [key]: context }
        }))
        patchError(key, 'commitContext', null)
        return context
      }
      // Superseded by a newer fetch: never hand the caller an older context.
      return null
    } catch (error) {
      if (!isCurrent()) return null
      // The HEAD last shown is as stale as the context: no precondition is
      // better than a wrong one.
      delete knownHeads[key]
      // Drop any stale context so the footer disables its actions rather than
      // acting on out-of-date ahead/staged/HEAD data.
      set((state) => {
        if (!(key in state.commitContexts)) return {}
        const commitContexts = { ...state.commitContexts }
        delete commitContexts[key]
        return { commitContexts }
      })
      patchError(key, 'commitContext', errorMessage(error))
      logFailure('commit context fetch', key, error)
      return null
    }
  },

  fetchDiff: async (cwd, path, staged, options) => {
    const notify = options?.notify !== false
    const key = diffKey(cwd, path, staged)
    clearDiffError(key)
    // Capture the request token before awaiting so a mutation that invalidates
    // this key while the fetch is in flight causes the late response to be
    // discarded instead of overwriting the cache with a stale diff.
    const token = diffRequestVersions[key] ?? 0
    const isCurrent = () => (diffRequestVersions[key] ?? 0) === token
    try {
      const diff = await gitApi.getDiff(cwd, path, staged)
      if (!isCurrent()) return
      set((state) => ({
        diffs: { ...state.diffs, [key]: diff }
      }))
      clearDiffError(key)
    } catch (error) {
      if (!isCurrent()) return
      useGitStatusStore.setState((state) => ({
        diffErrors: { ...state.diffErrors, [key]: errorMessage(error) }
      }))
      if (!notify) {
        logFailure('diff fetch', normalizePath(cwd), error)
        return
      }
      console.error('Failed to fetch diff:', error)
      // Write an empty sentinel so the panel stops retrying on every render and
      // shows the "no diff available" state instead of an infinite spinner.
      set((state) => ({
        diffs: { ...state.diffs, [key]: '' }
      }))
      toast.error(`Failed to load diff: ${String(error)}`)
    }
  },

  // Single-file mutations delegate to the batch variants so the post-mutation
  // refresh logic lives in exactly one place. The commit footer's staged count
  // is refreshed afterwards so Commit enables/disables correctly.
  stageFile: async (cwd, path) => get().stageFiles(cwd, [path]),

  unstageFile: async (cwd, path) => get().unstageFiles(cwd, [path]),

  discardFile: async (cwd, path) => get().discardFiles(cwd, [path]),

  // Batch mutations apply the per-file git operation to every path, then
  // refresh status + commit context once at the end rather than after each
  // file. The first failing path aborts the run (subsequent files are left
  // untouched) but a refresh still runs so the UI reflects what did change.
  stageFiles: async (cwd, paths) => {
    assertWritable(cwd)
    if (paths.length === 0) return
    try {
      for (const path of paths) {
        await gitApi.stage(cwd, path)
        invalidateFileDiffs(set, cwd, path)
      }
    } finally {
      await refreshAfterWrite(get, cwd)
    }
  },

  unstageFiles: async (cwd, paths) => {
    assertWritable(cwd)
    if (paths.length === 0) return
    try {
      for (const path of paths) {
        await gitApi.unstage(cwd, path)
        invalidateFileDiffs(set, cwd, path)
      }
    } finally {
      await refreshAfterWrite(get, cwd)
    }
  },

  // Per-hunk stage/unstage (#257). Same refresh contract as the file-level
  // mutations above: invalidate the cached diff for the file, then refresh
  // status + commit context so the panel reflects the partial stage.
  stageHunk: async (cwd, path, hunkPatch) => {
    assertWritable(cwd)
    try {
      await gitApi.stageHunk(cwd, path, hunkPatch)
      invalidateFileDiffs(set, cwd, path)
    } finally {
      await refreshAfterWrite(get, cwd)
    }
  },

  unstageHunk: async (cwd, path, hunkPatch) => {
    assertWritable(cwd)
    try {
      await gitApi.unstageHunk(cwd, path, hunkPatch)
      invalidateFileDiffs(set, cwd, path)
    } finally {
      await refreshAfterWrite(get, cwd)
    }
  },

  discardFiles: async (cwd, paths) => {
    assertWritable(cwd)
    if (paths.length === 0) return
    try {
      for (const path of paths) {
        await gitApi.discard(cwd, path)
        invalidateFileDiffs(set, cwd, path)
      }
    } finally {
      await refreshAfterWrite(get, cwd)
    }
  },

  commit: async (cwd, summary, description, amend) => {
    assertWritable(cwd)
    try {
      // The commit lands on the HEAD the panel last showed: a HEAD moved by
      // another client or terminal refuses it (`precondition_failed`).
      const key = trackPath(cwd)
      if (knownHeads[key] === undefined) await get().fetchCommitContext(cwd)
      const expectedHead = knownHeads[key]
      // No commit without a known HEAD: the host could not refuse a moved one.
      if (expectedHead === undefined || expectedHead === null) {
        throw new Error('HEAD could not be read. Refresh and try again.')
      }
      await gitApi.commit(cwd, summary, description, amend, expectedHead)
    } catch (error) {
      if (isPreconditionFailed(error)) await refreshAfterWrite(get, cwd)
      throw error
    }
    // The mutation succeeded. Refresh status/context to reflect the new HEAD,
    // but never let a refresh failure surface as a commit failure (the commit
    // already happened) â€” swallow refresh errors here.
    await refreshAfterMutation(get, cwd)
  },

  push: async (cwd) => {
    assertWritable(cwd)
    await gitApi.push(cwd)
    await refreshAfterMutation(get, cwd)
  },

  fetchStashes: async (cwd) => {
    const key = trackPath(cwd)
    try {
      const stashes = await gitApi.stashList(cwd)
      set((state) => ({
        stashes: { ...state.stashes, [key]: stashes }
      }))
    } catch (error) {
      console.error('Failed to fetch stashes:', error)
    }
  },

  fetchBranches: async (cwd) => {
    const key = trackPath(cwd)
    try {
      const branches = await gitApi.branchList(cwd)
      set((state) => ({
        branches: { ...state.branches, [key]: branches }
      }))
    } catch (error) {
      console.error('Failed to fetch branches:', error)
    }
  },

  stashSave: async (cwd, message, includeUntracked) => {
    assertWritable(cwd)
    await gitApi.stashSave(cwd, message, includeUntracked)
    await refreshAfterMutation(get, cwd)
  },

  stashApply: async (cwd, index) => {
    assertWritable(cwd)
    await gitApi.stashApply(cwd, index)
    await refreshAfterMutation(get, cwd)
  },

  stashPop: async (cwd, index) => {
    assertWritable(cwd)
    await gitApi.stashPop(cwd, index)
    await refreshAfterMutation(get, cwd)
  },

  stashDrop: async (cwd, index) => {
    assertWritable(cwd)
    await gitApi.stashDrop(cwd, index)
    await get().fetchStashes(cwd)
  },

  branchSwitch: async (cwd, name) => {
    assertWritable(cwd)
    await gitApi.branchSwitch(cwd, name)
    set({ selectedFile: null })
    await refreshAfterMutation(get, cwd)
    await updateStoresWithBranch(cwd, name)
  },

  branchCreate: async (cwd, name) => {
    assertWritable(cwd)
    await gitApi.createBranch(cwd, name)
    set({ selectedFile: null })
    await refreshAfterMutation(get, cwd)
    await updateStoresWithBranch(cwd, name)
  }
}))

/** Refuses a git write in a path that is unresolved for a project (a managed
 * worktree directory no listed worktree contains): throws before any git call. */
function assertWritable(cwd: string): void {
  if (!isGitWriteBlocked(cwd, useProjectStore.getState().projects)) return
  const key = normalizePath(cwd)
  void logFrontendError({
    level: 'warn',
    message: `[git-status] write blocked for unresolved working copy ${key}`,
    source: 'git-status-store'
  })
  throw new Error(
    'This worktree is no longer available. Git changes are blocked until it resolves.'
  )
}

async function updateStoresWithBranch(cwd: string, branchName: string) {
  try {
    const slashPath = (p?: string) => (p ? p.replace(/\\/g, '/') : '')
    const normalizedCwd = slashPath(cwd)

    const isWindows = platform() === 'windows'
    const matchPath = (otherPath?: string) => {
      const normalizedOther = slashPath(otherPath)
      return isWindows
        ? normalizedOther.toLowerCase() === normalizedCwd.toLowerCase()
        : normalizedOther === normalizedCwd
    }

    const projectStore = useProjectStore.getState()
    const project = projectStore.projects.find((p) => matchPath(p.path))
    if (project) {
      projectStore.updateProject(project.id, { gitBranch: branchName })
    }

    const terminalStore = useTerminalStore.getState()
    for (const t of terminalStore.terminals) {
      if (matchPath(t.cwd)) {
        terminalStore.updateTerminalGitBranch(t.id, branchName)
      }
    }
  } catch (err) {
    console.error('Failed to sync branch name across stores:', err)
  }
}

/** Refresh status, commit context and (if watched) diff stat after an own write.
 * Never rejects: refresh failures are stored in `errors` (and logged), so a
 * transient read failure neither masks the write's own error nor gets reported
 * as a failed commit/push that actually succeeded. */
async function refreshAfterWrite(get: () => GitStatusState, cwd: string): Promise<void> {
  try {
    await get().refreshStatus(cwd)
  } catch {
    // Stored in `errors` and logged by refreshStatus.
  }
  await get().fetchCommitContext(cwd)
  await get().refreshDiffStat(cwd)
}

/** `refreshAfterWrite` plus stash and branch lists, for writes that move them. */
async function refreshAfterMutation(get: () => GitStatusState, cwd: string): Promise<void> {
  await refreshAfterWrite(get, cwd)
  await get()
    .fetchStashes(cwd)
    .catch(() => {})
  await get()
    .fetchBranches(cwd)
    .catch(() => {})
}

/** Monotonic request token per diff key. Bumped whenever a key is invalidated
 * so an in-flight `fetchDiff` can detect it has been superseded. Kept outside
 * React state because it is control metadata, not render data. */
const diffRequestVersions: Record<string, number> = {}

/** Monotonic request token per key for `fetchCommitContext`. Lets a late
 * response detect it has been superseded by a newer fetch, so out-of-order
 * responses cannot overwrite or delete fresher context. Control metadata, not
 * render data, so it lives outside React state (same rationale as above). */
const commitContextRequests: Record<string, number> = {}

/** Full sha of HEAD (`''`: unborn branch) as of the last commit-context fetch,
 * per tracked path: the `expectedHead` of the next commit. `null`: HEAD could not
 * be read. Absent before the first fetch and after a failed one. A commit needs a
 * known value (it fetches one when absent). Control metadata. */
const knownHeads: Record<string, string | null> = {}

/** HEAD's full sha (`''` on an unborn branch); `null` when it cannot be read. */
async function readHead(cwd: string, hasHead: boolean): Promise<string | null> {
  if (!hasHead) return ''
  try {
    const [head] = await gitApi.getLog(cwd, 1)
    return head?.hash ?? null
  } catch {
    return null
  }
}

function isPreconditionFailed(error: unknown): boolean {
  return error instanceof AcpTransportError && error.code === PRECONDITION_FAILED_CODE
}

/** Monotonic request token per working-copy key for 
efreshStatus (same idea). */
const statusRequests: Record<string, number> = {}

const DIFF_STAT_MIN_INTERVAL_MS = 30_000

/** Watcher ref-counts, last fetch time and the pending trailing refresh per key
 * for `refreshDiffStat`. Control metadata, kept outside React state. */
const diffStatWatchers = new Map<string, number>()
const diffStatLastFetch = new Map<string, number>()
const diffStatTrailing = new Map<string, ReturnType<typeof setTimeout>>()

function clearDiffStatTrailing(key: string) {
  const timer = diffStatTrailing.get(key)
  if (timer === undefined) return
  clearTimeout(timer)
  diffStatTrailing.delete(key)
}

/** Max `refreshWorkingCopy` calls one all-repo refresh keeps in flight; each
 * spawns several git processes, so an unbounded fan-out over ~20 repos starves
 * the host under memory pressure. */
export const TRACKED_REFRESH_CONCURRENCY = 3

/** A tracked key still refreshing after this long frees its pool slot (and is
 * logged) so one stuck working copy cannot wedge every later all-repo refresh. */
export const TRACKED_REFRESH_TIMEOUT_MS = 60_000

interface TrackedRefreshControl {
  inFlight: Promise<void> | null
  trailing: Promise<void> | null
  /** Keys whose timed-out refresh has not settled yet; skipped, not re-called.
   * The value records whether this stuck episode's skip was already logged. */
  stuck: Map<string, boolean>
}

/** The running all-repo refresh, the one trailing run queued behind it and the
 * still-pending timed-out keys. Replaced (not mutated) on test reset so a stale
 * callback is inert. */
let trackedRefresh: TrackedRefreshControl = newTrackedRefreshControl()

function newTrackedRefreshControl(): TrackedRefreshControl {
  return { inFlight: null, trailing: null, stuck: new Map() }
}

function startTrackedRun(get: () => GitStatusState): Promise<void> {
  const control = trackedRefresh
  const run: Promise<void> = refreshPathsBounded(get, control)
    .catch((error: unknown) => logFailure('tracked refresh', 'run', error))
    .finally(() => {
      if (control.inFlight === run) control.inFlight = null
    })
  control.inFlight = run
  return run
}

/** `refreshWorkingCopy` for every tracked path through a pool of
 * `TRACKED_REFRESH_CONCURRENCY` workers. Never rejects. */
async function refreshPathsBounded(
  get: () => GitStatusState,
  control: TrackedRefreshControl
): Promise<void> {
  const paths = Object.values(get().paths)
  let next = 0
  const worker = async () => {
    while (next < paths.length) {
      await refreshTrackedPath(get, control, paths[next++])
    }
  }
  const workers = Math.min(TRACKED_REFRESH_CONCURRENCY, paths.length)
  await Promise.all(Array.from({ length: workers }, worker))
}

/** One tracked key, raced against `TRACKED_REFRESH_TIMEOUT_MS`. Never rejects;
 * a failure, timeout or skip is logged. A timed-out refresh keeps running in
 * the background (its request tokens still order its writes); until it
 * settles the key is skipped instead of piling up another refresh. */
async function refreshTrackedPath(
  get: () => GitStatusState,
  control: TrackedRefreshControl,
  path: string
): Promise<void> {
  const key = normalizePath(path)
  const skipLogged = control.stuck.get(key)
  if (skipLogged !== undefined) {
    if (!skipLogged) {
      // Once per stuck episode; later skips stay silent until it settles.
      control.stuck.set(key, true)
      void logFrontendError({
        level: 'warn',
        message: `[git-status] tracked refresh skipped for ${key}: previous refresh still pending`,
        source: 'git-status-store'
      })
    }
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), TRACKED_REFRESH_TIMEOUT_MS)
  })
  try {
    const refresh = get().refreshWorkingCopy(path)
    const refreshed = refresh.then(() => false as const)
    if (await Promise.race([refreshed, timedOut])) {
      control.stuck.set(key, false)
      const release = () => control.stuck.delete(key)
      refresh.then(release, release)
      logFailure(
        'tracked refresh',
        key,
        new Error(`timed out after ${TRACKED_REFRESH_TIMEOUT_MS} ms`)
      )
    }
  } catch (error) {
    logFailure('tracked refresh', key, error)
  } finally {
    clearTimeout(timer)
  }
}

/** Test-only: drop watcher/throttle/token metadata and any pending timer. */
export function resetGitStatusStoreControlForTests(): void {
  trackedRefresh = newTrackedRefreshControl()
  for (const key of [...diffStatTrailing.keys()]) clearDiffStatTrailing(key)
  diffStatWatchers.clear()
  diffStatLastFetch.clear()
  for (const key of Object.keys(commitContextRequests)) delete commitContextRequests[key]
  for (const key of Object.keys(knownHeads)) delete knownHeads[key]
  for (const key of Object.keys(statusRequests)) delete statusRequests[key]
}

/** Canonical key for `cwd`; records the first display path seen for it so
 * refreshes have a usable cwd. */
function trackPath(cwd: string): string {
  const key = normalizePath(cwd)
  if (useGitStatusStore.getState().paths[key] === undefined) {
    useGitStatusStore.setState((state) =>
      state.paths[key] === undefined ? { paths: { ...state.paths, [key]: cwd } } : {}
    )
  }
  return key
}

/** Set (`message`) or clear (`null`) one failure slot of `errors[key]`. */
function patchError(key: string, field: keyof GitStatusErrors, message: string | null) {
  const current = useGitStatusStore.getState().errors[key]
  if (message === null ? current?.[field] === undefined : current?.[field] === message) return
  useGitStatusStore.setState((state) => {
    const next = { ...state.errors[key] }
    if (message === null) delete next[field]
    else next[field] = message
    const errors = { ...state.errors }
    if (Object.keys(next).length === 0) delete errors[key]
    else errors[key] = next
    return { errors }
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One backend record per failed outcome. Never include branch names. */
function logFailure(outcome: string, key: string, error: unknown) {
  void logFrontendError({
    level: 'warn',
    message: `[git-status] ${outcome} failed for ${key}: ${errorMessage(error)}`,
    source: 'git-status-store'
  })
}

function bumpDiffVersion(key: string) {
  diffRequestVersions[key] = (diffRequestVersions[key] ?? 0) + 1
}

/** Drop cached staged and unstaged diffs for a file after it mutates so the
 * panel refetches the now-current diff instead of showing a stale one. Also
 * bumps each key's request token to discard any in-flight fetch. */
function invalidateFileDiffs(
  set: (fn: (state: GitStatusState) => Partial<GitStatusState>) => void,
  cwd: string,
  path: string
) {
  const stagedKey = diffKey(cwd, path, true)
  const unstagedKey = diffKey(cwd, path, false)
  bumpDiffVersion(stagedKey)
  bumpDiffVersion(unstagedKey)
  set((state) => {
    const diffs = { ...state.diffs }
    delete diffs[stagedKey]
    delete diffs[unstagedKey]
    if (!(stagedKey in state.diffErrors) && !(unstagedKey in state.diffErrors)) return { diffs }
    const diffErrors = { ...state.diffErrors }
    delete diffErrors[stagedKey]
    delete diffErrors[unstagedKey]
    return { diffs, diffErrors }
  })
}

/** Drop one diff key's recorded failure (no-op when none). */
function clearDiffError(key: string) {
  if (!(key in useGitStatusStore.getState().diffErrors)) return
  useGitStatusStore.setState((state) => {
    const diffErrors = { ...state.diffErrors }
    delete diffErrors[key]
    return { diffErrors }
  })
}
