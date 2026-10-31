import type {
  GithubCheckLog,
  GithubChecksResult,
  GithubCommentResult,
  GithubCommentTarget,
  GithubContext,
  GithubItemDetail,
  GithubItemKind,
  GithubListFilter,
  GithubListResult,
  GithubMergeAction,
  GithubMergeResult,
  GithubRepoSlot
} from '@shared/types/github.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { create } from 'zustand'
import { githubApi } from '@/lib/github-api'

/**
 * One host read. `data` is the last good response: it stays while a refresh
 * is in flight or after one fails, so a rate-limited or offline refresh never
 * blanks what the user is reading.
 */
export interface GithubResource<T> {
  data: T | null
  status: 'idle' | 'loading' | 'error'
  /** `IpcResult` failure code of the last request (`GH_RATE_LIMITED`, ...). */
  errorCode: string | null
  error: string | null
}

const IDLE: GithubResource<never> = { data: null, status: 'idle', errorCode: null, error: null }

export const DEFAULT_GITHUB_FILTER: GithubListFilter = {
  repo: 'origin',
  kind: 'all',
  state: 'open',
  assignedToMe: false,
  reviewRequested: false
}

/** Errors that mean the cached context is stale: `gh` vanished, logged out, or the remote changed. */
const CONTEXT_ERROR_CODES = new Set(['GH_CLI_MISSING', 'GH_UNAUTHENTICATED', 'GH_NOT_GITHUB_REPO'])

/** What each resource slice holds, keyed per slice (see the key helpers below). */
interface GithubResourceData {
  contexts: GithubContext
  lists: GithubListResult
  items: GithubItemDetail
  checks: GithubChecksResult
  logs: GithubCheckLog
}

type ResourceSlice = keyof GithubResourceData

type GithubResources = {
  [S in ResourceSlice]: Record<string, GithubResource<GithubResourceData[S]>>
}

export interface GithubItemRef {
  cwd: string
  repo: GithubRepoSlot
  kind: GithubItemKind
  number: number
}

export interface GithubState extends GithubResources {
  /** The list filter per working copy; absent means {@link DEFAULT_GITHUB_FILTER}. */
  filters: Record<string, GithubListFilter>

  loadContext: (cwd: string) => Promise<void>
  setFilter: (cwd: string, patch: Partial<GithubListFilter>) => void
  loadList: (cwd: string, options?: { refresh?: boolean }) => Promise<void>
  loadItem: (ref: GithubItemRef, options?: { refresh?: boolean }) => Promise<void>
  loadChecks: (ref: GithubItemRef, options?: { refresh?: boolean }) => Promise<void>
  loadCheckLog: (cwd: string, repo: GithubRepoSlot, jobId: number) => Promise<void>
  /**
   * Run a merge action, then re-read the PR, its checks and the list past the
   * host cache. Resolves once the PR re-read lands, so the merge controls stay
   * busy until they show what GitHub now reports.
   */
  merge: (ref: GithubItemRef, action: GithubMergeAction) => Promise<IpcResult<GithubMergeResult>>
  /**
   * Post a comment (CAP-11) or a review-thread reply, show the comment GitHub
   * returns, then re-read the item past the host cache.
   */
  comment: (
    ref: GithubItemRef,
    target: GithubCommentTarget,
    body: string
  ) => Promise<IpcResult<GithubCommentResult>>
}

const SEP = '\u0000'

export function githubListKey(cwd: string, filter: GithubListFilter): string {
  return [
    cwd,
    filter.repo,
    filter.kind,
    filter.state,
    filter.assignedToMe ? 'me' : '',
    filter.reviewRequested ? 'review' : ''
  ].join(SEP)
}

export function githubItemKey(cwd: string, repo: GithubRepoSlot, number: number): string {
  return [cwd, repo, number].join(SEP)
}

export function githubLogKey(cwd: string, repo: GithubRepoSlot, jobId: number): string {
  return [cwd, repo, 'job', jobId].join(SEP)
}

export function selectGithubFilter(cwd: string) {
  return (state: GithubState): GithubListFilter => state.filters[cwd] ?? DEFAULT_GITHUB_FILTER
}

export function resourceOf<T>(resource: GithubResource<T> | undefined): GithubResource<T> {
  return resource ?? IDLE
}

/** Latest request token per slice and key: a slower, older response never overwrites a newer one. */
const requestVersions = new Map<string, number>()

export const useGithubStore = create<GithubState>((set, get) => {
  async function track<S extends ResourceSlice>(
    slice: S,
    key: string,
    request: () => Promise<IpcResult<GithubResourceData[S]>>
  ): Promise<IpcResult<GithubResourceData[S]> | null> {
    type Data = GithubResourceData[S]
    const versionKey = `${slice}${SEP}${key}`
    const token = (requestVersions.get(versionKey) ?? 0) + 1
    requestVersions.set(versionKey, token)
    const patch = (fn: (prev: GithubResource<Data>) => GithubResource<Data>): void =>
      set((state) => {
        const records: GithubResources[S] = state[slice]
        const next = { [slice]: { ...records, [key]: fn(resourceOf(records[key])) } }
        return next as Pick<GithubResources, S>
      })

    patch((prev) => ({ ...prev, status: 'loading' }))
    const result = await request()
    if (requestVersions.get(versionKey) !== token) return null
    if (result.success) {
      patch(() => ({ data: result.data, status: 'idle', errorCode: null, error: null }))
    } else {
      patch((prev) => ({ ...prev, status: 'error', errorCode: result.code, error: result.error }))
    }
    return result
  }

  /** A read failed because `gh` or its login changed: re-read the status so the panel shows it. */
  function recheckContext(cwd: string, result: IpcResult<unknown> | null): void {
    if (result && !result.success && CONTEXT_ERROR_CODES.has(result.code)) {
      void get().loadContext(cwd)
    }
  }

  return {
    contexts: {},
    lists: {},
    items: {},
    checks: {},
    logs: {},
    filters: {},

    loadContext: async (cwd) => {
      await track('contexts', cwd, () => githubApi.getContext(cwd))
    },

    setFilter: (cwd, patch) => {
      set((state) => ({
        filters: { ...state.filters, [cwd]: { ...selectGithubFilter(cwd)(state), ...patch } }
      }))
      void get().loadList(cwd)
    },

    loadList: async (cwd, options) => {
      const filter = selectGithubFilter(cwd)(get())
      const result = await track('lists', githubListKey(cwd, filter), () =>
        githubApi.listItems({ cwd, filter, refresh: options?.refresh })
      )
      recheckContext(cwd, result)
    },

    loadItem: async (ref, options) => {
      const result = await track('items', githubItemKey(ref.cwd, ref.repo, ref.number), () =>
        githubApi.getItem({ ...ref, refresh: options?.refresh })
      )
      recheckContext(ref.cwd, result)
    },

    loadChecks: async (ref, options) => {
      await track('checks', githubItemKey(ref.cwd, ref.repo, ref.number), () =>
        githubApi.getChecks({
          cwd: ref.cwd,
          repo: ref.repo,
          number: ref.number,
          refresh: options?.refresh
        })
      )
    },

    loadCheckLog: async (cwd, repo, jobId) => {
      await track('logs', githubLogKey(cwd, repo, jobId), () =>
        githubApi.getCheckLog({ cwd, repo, jobId })
      )
    },

    merge: async (ref, action) => {
      const result = await githubApi.merge({
        cwd: ref.cwd,
        repo: ref.repo,
        number: ref.number,
        action
      })
      // A refused merge can still mean GitHub's state moved (someone else merged,
      // a check finished), so re-read either way; the pane shows what GitHub reports.
      void get().loadChecks(ref, { refresh: true })
      void get().loadList(ref.cwd, { refresh: true })
      await get().loadItem(ref, { refresh: true })
      return result
    },

    comment: async (ref, target, body) => {
      const result = await githubApi.comment({
        cwd: ref.cwd,
        repo: ref.repo,
        kind: ref.kind,
        number: ref.number,
        target,
        body
      })
      if (!result.success) return result
      const { comment } = result.data
      const key = githubItemKey(ref.cwd, ref.repo, ref.number)
      set((state) => {
        const resource = state.items[key]
        const detail = resource?.data
        if (!detail) return {}
        const next: GithubItemDetail =
          target.kind === 'conversation'
            ? { ...detail, comments: [...detail.comments, comment] }
            : detail.pr
              ? {
                  ...detail,
                  pr: {
                    ...detail.pr,
                    reviewThreads: detail.pr.reviewThreads.map((thread) =>
                      thread.id === target.threadId
                        ? { ...thread, comments: [...thread.comments, comment] }
                        : thread
                    )
                  }
                }
              : detail
        return { items: { ...state.items, [key]: { ...resource, data: next } } }
      })
      void get().loadItem(ref, { refresh: true })
      return result
    }
  }
})
