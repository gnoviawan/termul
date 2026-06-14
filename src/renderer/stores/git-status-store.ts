import type { GitCommitContext, GitStashInfo, GitStatusDetail } from '@shared/types/ipc.types'
import { toast } from 'sonner'
import { create } from 'zustand'
import { gitApi } from '@/lib/git-api'

/** Build the staged-aware diff cache key so the staged and unstaged rows of the
 * same file (porcelain `MM`) do not collide. */
export const diffKey = (cwd: string, path: string, staged: boolean) => `${cwd}:${path}:${staged}`

export interface GitStatusState {
  // statuses[cwd] = GitStatusDetail[]
  statuses: Record<string, GitStatusDetail[]>
  // diffs["cwd:path:staged"] = string
  diffs: Record<string, string>
  // commitContexts[cwd] = GitCommitContext
  commitContexts: Record<string, GitCommitContext>
  // stashes[cwd] = GitStashInfo[]
  stashes: Record<string, GitStashInfo[]>
  // branches[cwd] = string[]
  branches: Record<string, string[]>
  selectedFile: string | null
  isFetchingStatus: boolean
  statusFetchCount: number

  setSelectedFile: (path: string | null) => void
  refreshStatus: (cwd: string) => Promise<void>
  fetchDiff: (cwd: string, path: string, staged: boolean) => Promise<void>
  fetchCommitContext: (cwd: string) => Promise<void>
  fetchStashes: (cwd: string) => Promise<void>
  fetchBranches: (cwd: string) => Promise<void>
  stageFile: (cwd: string, path: string) => Promise<void>
  unstageFile: (cwd: string, path: string) => Promise<void>
  discardFile: (cwd: string, path: string) => Promise<void>
  stageFiles: (cwd: string, paths: string[]) => Promise<void>
  unstageFiles: (cwd: string, paths: string[]) => Promise<void>
  discardFiles: (cwd: string, paths: string[]) => Promise<void>
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
  statuses: {},
  diffs: {},
  commitContexts: {},
  stashes: {},
  branches: {},
  selectedFile: null,
  isFetchingStatus: false,
  statusFetchCount: 0,

  setSelectedFile: (path) => set({ selectedFile: path }),

  refreshStatus: async (cwd) => {
    set((state) => ({
      statusFetchCount: state.statusFetchCount + 1,
      isFetchingStatus: true
    }))
    try {
      const status = await gitApi.getStatus(cwd)
      set((state) => ({
        statuses: { ...state.statuses, [cwd]: status }
      }))
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

  fetchCommitContext: async (cwd) => {
    // Guard against out-of-order responses: a slow earlier fetch must not
    // overwrite or delete a fresher result. Mirror the fetchDiff token pattern.
    // biome-ignore lint/suspicious/noAssignInExpressions: deliberate request-token bump and capture
    const token = (commitContextRequests[cwd] = (commitContextRequests[cwd] ?? 0) + 1)
    const isCurrent = () => commitContextRequests[cwd] === token
    try {
      const context = await gitApi.getCommitContext(cwd)
      if (!isCurrent()) return
      set((state) => ({
        commitContexts: { ...state.commitContexts, [cwd]: context }
      }))
    } catch (error) {
      console.error('Failed to fetch commit context:', error)
      if (!isCurrent()) return
      // Drop any stale context so the footer disables its actions rather than
      // acting on out-of-date ahead/staged/HEAD data.
      set((state) => {
        if (!(cwd in state.commitContexts)) return {}
        const commitContexts = { ...state.commitContexts }
        delete commitContexts[cwd]
        return { commitContexts }
      })
    }
  },

  fetchDiff: async (cwd, path, staged) => {
    const key = diffKey(cwd, path, staged)
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
    } catch (error) {
      console.error('Failed to fetch diff:', error)
      if (!isCurrent()) return
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
    if (paths.length === 0) return
    try {
      for (const path of paths) {
        await gitApi.stage(cwd, path)
        invalidateFileDiffs(set, cwd, path)
      }
    } finally {
      await get().refreshStatus(cwd)
      await get().fetchCommitContext(cwd)
    }
  },

  unstageFiles: async (cwd, paths) => {
    if (paths.length === 0) return
    try {
      for (const path of paths) {
        await gitApi.unstage(cwd, path)
        invalidateFileDiffs(set, cwd, path)
      }
    } finally {
      await get().refreshStatus(cwd)
      await get().fetchCommitContext(cwd)
    }
  },

  discardFiles: async (cwd, paths) => {
    if (paths.length === 0) return
    try {
      for (const path of paths) {
        await gitApi.discard(cwd, path)
        invalidateFileDiffs(set, cwd, path)
      }
    } finally {
      await get().refreshStatus(cwd)
      await get().fetchCommitContext(cwd)
    }
  },

  commit: async (cwd, summary, description, amend) => {
    await gitApi.commit(cwd, summary, description, amend)
    // The mutation succeeded. Refresh status/context to reflect the new HEAD,
    // but never let a refresh failure surface as a commit failure (the commit
    // already happened) — swallow refresh errors here.
    await refreshAfterMutation(get, cwd)
  },

  push: async (cwd) => {
    await gitApi.push(cwd)
    await refreshAfterMutation(get, cwd)
  },

  fetchStashes: async (cwd) => {
    try {
      const stashes = await gitApi.stashList(cwd)
      set((state) => ({
        stashes: { ...state.stashes, [cwd]: stashes }
      }))
    } catch (error) {
      console.error('Failed to fetch stashes:', error)
    }
  },

  fetchBranches: async (cwd) => {
    try {
      const branches = await gitApi.branchList(cwd)
      set((state) => ({
        branches: { ...state.branches, [cwd]: branches }
      }))
    } catch (error) {
      console.error('Failed to fetch branches:', error)
    }
  },

  stashSave: async (cwd, message, includeUntracked) => {
    await gitApi.stashSave(cwd, message, includeUntracked)
    await refreshAfterMutation(get, cwd)
  },

  stashApply: async (cwd, index) => {
    await gitApi.stashApply(cwd, index)
    await refreshAfterMutation(get, cwd)
  },

  stashPop: async (cwd, index) => {
    await gitApi.stashPop(cwd, index)
    await refreshAfterMutation(get, cwd)
  },

  stashDrop: async (cwd, index) => {
    await gitApi.stashDrop(cwd, index)
    await get().fetchStashes(cwd)
  },

  branchSwitch: async (cwd, name) => {
    await gitApi.branchSwitch(cwd, name)
    set({ selectedFile: null })
    await refreshAfterMutation(get, cwd)
    await updateStoresWithBranch(cwd, name)
  },

  branchCreate: async (cwd, name) => {
    await gitApi.branchCreate(cwd, name)
    set({ selectedFile: null })
    await refreshAfterMutation(get, cwd)
    await updateStoresWithBranch(cwd, name)
  }
}))

async function updateStoresWithBranch(cwd: string, branchName: string) {
  try {
    const { useProjectStore } = await import('./project-store')
    const { useTerminalStore } = await import('./terminal-store')

    const normalizePath = (p?: string) => (p ? p.replace(/\\/g, '/') : '')
    const normalizedCwd = normalizePath(cwd)

    const isWindows =
      typeof process !== 'undefined'
        ? process.platform === 'win32'
        : navigator.platform.toLowerCase().includes('win')
    const matchPath = (otherPath?: string) => {
      const normalizedOther = normalizePath(otherPath)
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

/** Refresh status + commit context after a successful mutation. Errors here are
 * logged but never rethrown, so a transient read failure does not get reported
 * to the user as a failed commit/push that actually succeeded. */
async function refreshAfterMutation(get: () => GitStatusState, cwd: string): Promise<void> {
  try {
    await get().refreshStatus(cwd)
  } catch (error) {
    console.error('Post-mutation status refresh failed:', error)
  }
  await get().fetchCommitContext(cwd)
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

/** Monotonic request token per cwd for `fetchCommitContext`. Lets a late
 * response detect it has been superseded by a newer fetch, so out-of-order
 * responses cannot overwrite or delete fresher context. Control metadata, not
 * render data, so it lives outside React state (same rationale as above). */
const commitContextRequests: Record<string, number> = {}

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
    return { diffs }
  })
}
