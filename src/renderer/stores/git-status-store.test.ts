import type { GitCommitContext, GitStatusDetail } from '@shared/types/ipc.types'
import { platform } from '@tauri-apps/plugin-os'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gitApiModule from '@/lib/git-api'
import { resetProjectStore, resetTerminalStore } from '@/lib/test-utils/store'
import { mockTerminal } from '@/lib/test-utils/terminal'
import {
  countGitStatuses,
  deepestTrackedKey,
  diffKey,
  resetGitStatusStoreControlForTests,
  selectChangedFileCount,
  selectGitBranch,
  selectGitDiffStat,
  selectGitErrors,
  TRACKED_REFRESH_CONCURRENCY,
  TRACKED_REFRESH_TIMEOUT_MS,
  useGitStatusStore
} from './git-status-store'
import { useProjectStore } from './project-store'
import { useTerminalStore } from './terminal-store'

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn()
}))

vi.mock('@/lib/git-api', () => ({
  gitApi: {
    getStatus: vi.fn(),
    getDiff: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    stageHunk: vi.fn(),
    unstageHunk: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    getCommitContext: vi.fn(),
    getLog: vi.fn(),
    getDiffStat: vi.fn(),
    stashSave: vi.fn(),
    stashList: vi.fn(),
    stashApply: vi.fn(),
    stashPop: vi.fn(),
    stashDrop: vi.fn(),
    branchList: vi.fn(),
    branchSwitch: vi.fn(),
    createBranch: vi.fn()
  }
}))

const { mockLogFrontendError } = vi.hoisted(() => ({ mockLogFrontendError: vi.fn() }))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const { gitApi } = gitApiModule as unknown as {
  gitApi: {
    getStatus: ReturnType<typeof vi.fn>
    getDiff: ReturnType<typeof vi.fn>
    stage: ReturnType<typeof vi.fn>
    unstage: ReturnType<typeof vi.fn>
    discard: ReturnType<typeof vi.fn>
    commit: ReturnType<typeof vi.fn>
    push: ReturnType<typeof vi.fn>
    getCommitContext: ReturnType<typeof vi.fn>
    getLog: ReturnType<typeof vi.fn>
    getDiffStat: ReturnType<typeof vi.fn>
    stashSave: ReturnType<typeof vi.fn>
    stashList: ReturnType<typeof vi.fn>
    stashApply: ReturnType<typeof vi.fn>
    stashPop: ReturnType<typeof vi.fn>
    stashDrop: ReturnType<typeof vi.fn>
    branchList: ReturnType<typeof vi.fn>
    branchSwitch: ReturnType<typeof vi.fn>
    createBranch: ReturnType<typeof vi.fn>
  }
}

const CWD = '/repo'

const makeContext = (over: Partial<GitCommitContext> = {}): GitCommitContext => ({
  branch: 'main',
  hasUpstream: true,
  ahead: 0,
  behind: 0,
  stagedCount: 1,
  hasHead: true,
  lastSubject: 'last',
  lastBody: '',
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  gitApi.getLog.mockResolvedValue([{ hash: 'a'.repeat(40) }])
  resetGitStatusStoreControlForTests()
  useGitStatusStore.setState({
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
    statusFetchCount: 0
  })
  gitApi.getStatus.mockResolvedValue([] as GitStatusDetail[])
  gitApi.getCommitContext.mockResolvedValue(makeContext())
  gitApi.getDiffStat.mockResolvedValue({ added: 3, removed: 1 })
  gitApi.stashList.mockResolvedValue([])
  gitApi.branchList.mockResolvedValue([])
})

describe('git-status-store commit footer', () => {
  it('fetchCommitContext stores context per cwd', async () => {
    gitApi.getCommitContext.mockResolvedValue(makeContext({ ahead: 3 }))
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    expect(useGitStatusStore.getState().commitContexts[CWD].ahead).toBe(3)
  })

  it('fetchCommitContext returns the context, or null on failure (no throw)', async () => {
    await expect(useGitStatusStore.getState().fetchCommitContext(CWD)).resolves.toMatchObject({
      branch: 'main'
    })
    gitApi.getCommitContext.mockRejectedValue(new Error('boom'))
    await expect(useGitStatusStore.getState().fetchCommitContext(CWD)).resolves.toBeNull()
    expect(useGitStatusStore.getState().commitContexts[CWD]).toBeUndefined()
  })

  it('fetchCommitContext ignores a stale (out-of-order) response', async () => {
    // First call resolves slowly with stale data; second call resolves fast
    // with fresh data. The slow one must not overwrite the fresh result.
    let resolveSlow: (v: GitCommitContext) => void = () => {}
    const slow = new Promise<GitCommitContext>((r) => {
      resolveSlow = r
    })
    gitApi.getCommitContext.mockReturnValueOnce(slow)
    gitApi.getCommitContext.mockResolvedValueOnce(makeContext({ ahead: 9 }))

    const first = useGitStatusStore.getState().fetchCommitContext(CWD)
    const second = useGitStatusStore.getState().fetchCommitContext(CWD)
    await second
    // Now let the older request resolve with stale data.
    resolveSlow(makeContext({ ahead: 1 }))
    await first

    expect(useGitStatusStore.getState().commitContexts[CWD].ahead).toBe(9)
  })

  it('fetchCommitContext returns null for a superseded response', async () => {
    let resolveSlow: (v: GitCommitContext) => void = () => {}
    const slow = new Promise<GitCommitContext>((r) => {
      resolveSlow = r
    })
    gitApi.getCommitContext.mockReturnValueOnce(slow)
    gitApi.getCommitContext.mockResolvedValueOnce(makeContext({ branch: 'new' }))

    const first = useGitStatusStore.getState().fetchCommitContext(CWD)
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    resolveSlow(makeContext({ branch: 'old' }))

    await expect(first).resolves.toBeNull()
    expect(useGitStatusStore.getState().commitContexts[CWD].branch).toBe('new')
  })

  it('refreshStatus ignores a stale (out-of-order) response', async () => {
    let resolveSlow: (v: GitStatusDetail[]) => void = () => {}
    const slow = new Promise<GitStatusDetail[]>((r) => {
      resolveSlow = r
    })
    const fresh: GitStatusDetail[] = [{ path: 'new.ts', staged: true, status: 'modified' }]
    gitApi.getStatus.mockReturnValueOnce(slow)
    gitApi.getStatus.mockResolvedValueOnce(fresh)

    const first = useGitStatusStore.getState().refreshStatus(CWD)
    await useGitStatusStore.getState().refreshStatus(CWD)
    resolveSlow([{ path: 'old.ts', staged: false, status: 'modified' }])
    await first

    expect(useGitStatusStore.getState().statuses[CWD]).toEqual(fresh)
    expect(useGitStatusStore.getState().isFetchingStatus).toBe(false)
  })

  it('fetchCommitContext drops stale context when the fetch fails', async () => {
    // Seed a context, then make the next fetch fail.
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    expect(useGitStatusStore.getState().commitContexts[CWD]).toBeDefined()
    gitApi.getCommitContext.mockRejectedValue(new Error('locked'))
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    expect(useGitStatusStore.getState().commitContexts[CWD]).toBeUndefined()
  })

  it('commit invokes gitApi.commit then refreshes status and context', async () => {
    gitApi.getCommitContext.mockResolvedValue({ hasHead: false } as GitCommitContext)
    await useGitStatusStore.getState().commit(CWD, 'summary', 'body', false)
    expect(gitApi.commit).toHaveBeenCalledWith(CWD, 'summary', 'body', false, '')
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD)
    expect(gitApi.getCommitContext).toHaveBeenCalledWith(CWD)
  })

  it('commit sends the HEAD last shown by the commit context as expectedHead (unborn branch: empty)', async () => {
    gitApi.getCommitContext.mockResolvedValue({ hasHead: true } as GitCommitContext)
    gitApi.getLog.mockResolvedValue([{ hash: 'f'.repeat(40) }])
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    await useGitStatusStore.getState().commit(CWD, 'summary', 'body', false)
    expect(gitApi.getLog).toHaveBeenCalledWith(CWD, 1)
    expect(gitApi.commit).toHaveBeenLastCalledWith(CWD, 'summary', 'body', false, 'f'.repeat(40))

    gitApi.getCommitContext.mockResolvedValue({ hasHead: false } as GitCommitContext)
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    await useGitStatusStore.getState().commit(CWD, 'first', '', false)
    expect(gitApi.commit).toHaveBeenLastCalledWith(CWD, 'first', '', false, '')
  })

  it('a commit refused because HEAD moved refreshes the panel (new HEAD for the retry) and still throws', async () => {
    const { PRECONDITION_FAILED_CODE } = await import('@shared/types/ipc.types')
    const { AcpTransportError } = await import('@/lib/acp-transport/types')
    gitApi.getCommitContext.mockResolvedValue({ hasHead: true } as GitCommitContext)
    gitApi.getLog.mockResolvedValue([{ hash: '1'.repeat(40) }])
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    gitApi.commit.mockRejectedValueOnce(
      new AcpTransportError(PRECONDITION_FAILED_CODE, 'HEAD moved')
    )
    gitApi.getLog.mockResolvedValue([{ hash: '2'.repeat(40) }])

    await expect(useGitStatusStore.getState().commit(CWD, 's', '', false)).rejects.toMatchObject({
      code: PRECONDITION_FAILED_CODE
    })

    await useGitStatusStore.getState().commit(CWD, 's', '', false)
    expect(gitApi.commit).toHaveBeenLastCalledWith(CWD, 's', '', false, '2'.repeat(40))
  })

  it('a failed commit-context fetch forgets the HEAD: the next commit refetches it and is refused when that fails too', async () => {
    gitApi.getCommitContext.mockResolvedValueOnce({ hasHead: true } as GitCommitContext)
    gitApi.getLog.mockResolvedValue([{ hash: 'c'.repeat(40) }])
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    gitApi.getCommitContext.mockRejectedValue(new Error('locked'))
    await useGitStatusStore.getState().fetchCommitContext(CWD)

    await expect(useGitStatusStore.getState().commit(CWD, 's', '', false)).rejects.toThrow(
      'HEAD could not be read'
    )
    expect(gitApi.commit).not.toHaveBeenCalled()
  })

  it('a commit before any context fetch reads the HEAD first and sends it', async () => {
    gitApi.getCommitContext.mockResolvedValue({ hasHead: true } as GitCommitContext)
    gitApi.getLog.mockResolvedValue([{ hash: 'd'.repeat(40) }])

    await useGitStatusStore.getState().commit(CWD, 's', '', false)

    expect(gitApi.commit).toHaveBeenLastCalledWith(CWD, 's', '', false, 'd'.repeat(40))
  })

  it('a HEAD that cannot be read keeps the context but refuses a commit without a precondition', async () => {
    gitApi.getCommitContext.mockResolvedValue({ hasHead: true } as GitCommitContext)
    gitApi.getLog.mockRejectedValue(new Error('locked'))

    await useGitStatusStore.getState().fetchCommitContext(CWD)

    expect(useGitStatusStore.getState().commitContexts[CWD]).toMatchObject({ hasHead: true })
    await expect(useGitStatusStore.getState().commit(CWD, 's', '', false)).rejects.toThrow(
      'HEAD could not be read'
    )
    expect(gitApi.commit).not.toHaveBeenCalled()
  })

  it('a superseded commit-context fetch does not record its HEAD', async () => {
    let releaseSlow: (context: GitCommitContext) => void = () => {}
    gitApi.getCommitContext.mockReturnValueOnce(
      new Promise<GitCommitContext>((resolve) => {
        releaseSlow = resolve
      })
    )
    gitApi.getLog.mockResolvedValue([{ hash: 'old'.padEnd(40, '0') }])
    const slow = useGitStatusStore.getState().fetchCommitContext(CWD)
    gitApi.getCommitContext.mockResolvedValueOnce({ hasHead: false } as GitCommitContext)
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    releaseSlow({ hasHead: true } as GitCommitContext)
    await slow

    await useGitStatusStore.getState().commit(CWD, 's', '', false)
    expect(gitApi.commit).toHaveBeenLastCalledWith(CWD, 's', '', false, '')
  })

  it('commit passes amend flag through', async () => {
    gitApi.getCommitContext.mockResolvedValue({ hasHead: false } as GitCommitContext)
    await useGitStatusStore.getState().commit(CWD, 'reword', '', true)
    expect(gitApi.commit).toHaveBeenCalledWith(CWD, 'reword', '', true, '')
  })

  it('commit propagates errors to the caller', async () => {
    gitApi.commit.mockRejectedValue(new Error('commit failed'))
    await expect(useGitStatusStore.getState().commit(CWD, 'x', '', false)).rejects.toThrow(
      'commit failed'
    )
    // Status/context refresh should not run when the mutation failed.
    expect(gitApi.getStatus).not.toHaveBeenCalled()
  })

  it('commit still resolves when the post-commit refresh fails', async () => {
    // The commit itself succeeded; a transient refresh failure must not be
    // reported to the caller as a failed commit.
    gitApi.commit.mockResolvedValue(undefined)
    gitApi.getStatus.mockRejectedValue(new Error('transient lock'))
    await expect(
      useGitStatusStore.getState().commit(CWD, 'summary', '', false)
    ).resolves.toBeUndefined()
    expect(gitApi.commit).toHaveBeenCalledOnce()
  })

  it('push invokes gitApi.push then refreshes status and context', async () => {
    await useGitStatusStore.getState().push(CWD)
    expect(gitApi.push).toHaveBeenCalledWith(CWD)
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD)
    expect(gitApi.getCommitContext).toHaveBeenCalledWith(CWD)
  })

  it('push propagates errors to the caller', async () => {
    gitApi.push.mockRejectedValue(new Error('auth failed'))
    await expect(useGitStatusStore.getState().push(CWD)).rejects.toThrow('auth failed')
    expect(gitApi.getStatus).not.toHaveBeenCalled()
  })

  it('diffKey disambiguates staged vs unstaged rows', () => {
    expect(diffKey(CWD, 'a.txt', true)).not.toBe(diffKey(CWD, 'a.txt', false))
  })
})

describe('git-status-store batch staging', () => {
  it('stageFile delegates to a single-path stage', async () => {
    await useGitStatusStore.getState().stageFile(CWD, 'a.txt')
    expect(gitApi.stage).toHaveBeenCalledWith(CWD, 'a.txt')
    expect(gitApi.stage).toHaveBeenCalledOnce()
  })

  it('stageFiles stages every path then refreshes once', async () => {
    await useGitStatusStore.getState().stageFiles(CWD, ['a.txt', 'b.txt', 'c.txt'])
    expect(gitApi.stage).toHaveBeenCalledTimes(3)
    expect(gitApi.stage).toHaveBeenNthCalledWith(1, CWD, 'a.txt')
    expect(gitApi.stage).toHaveBeenNthCalledWith(2, CWD, 'b.txt')
    expect(gitApi.stage).toHaveBeenNthCalledWith(3, CWD, 'c.txt')
    // Status + context refresh run exactly once for the whole batch.
    expect(gitApi.getStatus).toHaveBeenCalledOnce()
    expect(gitApi.getCommitContext).toHaveBeenCalledOnce()
  })

  it('unstageFiles unstages every path then refreshes once', async () => {
    await useGitStatusStore.getState().unstageFiles(CWD, ['a.txt', 'b.txt'])
    expect(gitApi.unstage).toHaveBeenCalledTimes(2)
    expect(gitApi.getStatus).toHaveBeenCalledOnce()
    expect(gitApi.getCommitContext).toHaveBeenCalledOnce()
  })

  it('discardFiles discards every path then refreshes once', async () => {
    await useGitStatusStore.getState().discardFiles(CWD, ['a.txt', 'b.txt'])
    expect(gitApi.discard).toHaveBeenCalledTimes(2)
    expect(gitApi.getStatus).toHaveBeenCalledOnce()
    expect(gitApi.getCommitContext).toHaveBeenCalledOnce()
  })

  it('empty batch is a no-op (no git calls, no refresh)', async () => {
    await useGitStatusStore.getState().stageFiles(CWD, [])
    expect(gitApi.stage).not.toHaveBeenCalled()
    expect(gitApi.getStatus).not.toHaveBeenCalled()
  })

  it('stageFiles still refreshes when a mid-batch stage fails', async () => {
    gitApi.stage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('add failed'))
    await expect(useGitStatusStore.getState().stageFiles(CWD, ['a.txt', 'b.txt'])).rejects.toThrow(
      'add failed'
    )
    // The second file aborts the loop, but a refresh still runs so the UI
    // reflects the first file that did stage.
    expect(gitApi.stage).toHaveBeenCalledTimes(2)
    expect(gitApi.getStatus).toHaveBeenCalledOnce()
  })
})

describe('git-status-store stash and branch actions', () => {
  it('fetchStashes fetches and stores stashes', async () => {
    const mockStashes = [{ index: 0, name: 'stash@{0}', message: 'WIP' }]
    gitApi.stashList.mockResolvedValue(mockStashes)

    await useGitStatusStore.getState().fetchStashes(CWD)
    expect(gitApi.stashList).toHaveBeenCalledWith(CWD)
    expect(useGitStatusStore.getState().stashes[CWD]).toEqual(mockStashes)
  })

  it('fetchBranches fetches and stores branches', async () => {
    const mockBranches = ['main', 'feature/test']
    gitApi.branchList.mockResolvedValue(mockBranches)

    await useGitStatusStore.getState().fetchBranches(CWD)
    expect(gitApi.branchList).toHaveBeenCalledWith(CWD)
    expect(useGitStatusStore.getState().branches[CWD]).toEqual(mockBranches)
  })

  it('stashSave stashes changes and triggers refresh', async () => {
    await useGitStatusStore.getState().stashSave(CWD, 'my stash', true)
    expect(gitApi.stashSave).toHaveBeenCalledWith(CWD, 'my stash', true)
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD)
    expect(gitApi.stashList).toHaveBeenCalledWith(CWD)
    expect(gitApi.branchList).toHaveBeenCalledWith(CWD)
  })

  it('stashApply applies stash and triggers status/context refresh', async () => {
    await useGitStatusStore.getState().stashApply(CWD, 1)
    expect(gitApi.stashApply).toHaveBeenCalledWith(CWD, 1)
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD)
  })

  it('stashPop pops stash and triggers refresh', async () => {
    await useGitStatusStore.getState().stashPop(CWD, 0)
    expect(gitApi.stashPop).toHaveBeenCalledWith(CWD, 0)
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD)
    expect(gitApi.stashList).toHaveBeenCalledWith(CWD)
  })

  it('stashDrop drops stash and updates stash list', async () => {
    await useGitStatusStore.getState().stashDrop(CWD, 2)
    expect(gitApi.stashDrop).toHaveBeenCalledWith(CWD, 2)
    expect(gitApi.stashList).toHaveBeenCalledWith(CWD)
    expect(gitApi.getStatus).not.toHaveBeenCalled()
  })

  it('branchSwitch switches branch, resets selectedFile, and refreshes', async () => {
    useGitStatusStore.setState({ selectedFile: 'somefile.ts' })
    await useGitStatusStore.getState().branchSwitch(CWD, 'feature/cool')
    expect(gitApi.branchSwitch).toHaveBeenCalledWith(CWD, 'feature/cool')
    expect(useGitStatusStore.getState().selectedFile).toBeNull()
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD)
    expect(gitApi.branchList).toHaveBeenCalledWith(CWD)
  })

  it('branchCreate creates branch, resets selectedFile, and refreshes', async () => {
    useGitStatusStore.setState({ selectedFile: 'somefile.ts' })
    await useGitStatusStore.getState().branchCreate(CWD, 'feature/new')
    expect(gitApi.createBranch).toHaveBeenCalledWith(CWD, 'feature/new')
    expect(useGitStatusStore.getState().selectedFile).toBeNull()
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD)
    expect(gitApi.branchList).toHaveBeenCalledWith(CWD)
  })
})

describe('git-status-store branch sync cross-store', () => {
  afterEach(() => {
    vi.mocked(platform).mockReset()
    resetProjectStore()
    resetTerminalStore()
  })

  it('updates project and terminal branches case-insensitively on Windows', async () => {
    vi.mocked(platform).mockReturnValue('windows')

    useProjectStore.setState({
      projects: [
        { id: 'proj-1', path: 'C:\\\\Users\\\\Test\\\\Project', gitBranch: 'old-branch' } as any
      ]
    })

    useTerminalStore.setState({
      terminals: [
        mockTerminal({
          id: 'term-1',
          cwd: 'c:\\\\users\\\\test\\\\project',
          gitBranch: 'old-branch'
        })
      ]
    })

    await useGitStatusStore.getState().branchSwitch('C:\\\\Users\\\\Test\\\\Project', 'new-branch')

    expect(useProjectStore.getState().projects[0].gitBranch).toBe('new-branch')
    expect(useTerminalStore.getState().terminals[0].gitBranch).toBe('new-branch')
  })

  it('preserves case sensitivity on non-Windows platforms', async () => {
    vi.mocked(platform).mockReturnValue('linux')

    useProjectStore.setState({
      projects: [{ id: 'proj-1', path: '/Users/Test/Project', gitBranch: 'old-branch' } as any]
    })

    useTerminalStore.setState({
      terminals: [
        mockTerminal({ id: 'term-1', cwd: '/Users/Test/Project', gitBranch: 'old-branch' })
      ]
    })

    await useGitStatusStore.getState().branchSwitch('/users/test/project', 'new-branch')

    expect(useProjectStore.getState().projects[0].gitBranch).toBe('old-branch')
    expect(useTerminalStore.getState().terminals[0].gitBranch).toBe('old-branch')

    await useGitStatusStore.getState().branchSwitch('/Users/Test/Project', 'new-branch-exact')
    expect(useProjectStore.getState().projects[0].gitBranch).toBe('new-branch-exact')
    expect(useTerminalStore.getState().terminals[0].gitBranch).toBe('new-branch-exact')
  })
})

describe('selectChangedFileCount', () => {
  it('counts a staged + unstaged file once', () => {
    const repo: GitStatusDetail[] = [
      { path: 'a.ts', status: 'modified', staged: true },
      { path: 'a.ts', status: 'modified', staged: false },
      { path: 'b.ts', status: 'untracked', staged: false }
    ]
    const statuses = { '/repo': repo }
    expect(selectChangedFileCount('/repo')({ statuses })).toBe(2)
    expect(selectChangedFileCount('/repo/')({ statuses })).toBe(2)
    expect(selectChangedFileCount('/other')({ statuses })).toBe(0)
    expect(selectChangedFileCount(null)({ statuses })).toBe(0)
  })
})

describe('git-status-store canonical keys', () => {
  it('shares one entry between two spellings of a Windows path', async () => {
    gitApi.getStatus.mockResolvedValue([{ path: 'a.ts', status: 'modified', staged: false }])

    await useGitStatusStore.getState().refreshStatus('E:\\Proj')
    await useGitStatusStore.getState().refreshStatus('e:/proj/')
    await useGitStatusStore.getState().fetchCommitContext('e:/proj/')

    const state = useGitStatusStore.getState()
    expect(Object.keys(state.statuses)).toEqual(['e:/proj'])
    expect(Object.keys(state.commitContexts)).toEqual(['e:/proj'])
    // The first display path stays usable as a cwd.
    expect(state.paths).toEqual({ 'e:/proj': 'E:\\Proj' })
    expect(selectChangedFileCount('E:\\Proj')(state)).toBe(1)
    expect(selectChangedFileCount('e:/proj/')(state)).toBe(1)
    expect(selectGitBranch('E:\\Proj')(state)).toBe('main')
  })

  it('keeps the diff cache key canonical', () => {
    expect(diffKey('E:\\Proj', 'a.txt', true)).toBe(diffKey('e:/proj/', 'a.txt', true))
  })

  it('stores branches under the canonical key', async () => {
    gitApi.branchList.mockResolvedValue(['main'])
    await useGitStatusStore.getState().fetchBranches('E:\\Proj')
    expect(useGitStatusStore.getState().branches['e:/proj']).toEqual(['main'])
  })

  it('selectGitBranch is null for a missing or detached context', async () => {
    expect(selectGitBranch('/repo')(useGitStatusStore.getState())).toBeNull()
    expect(selectGitBranch(null)(useGitStatusStore.getState())).toBeNull()
    gitApi.getCommitContext.mockResolvedValue(makeContext({ branch: null }))
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    expect(selectGitBranch(CWD)(useGitStatusStore.getState())).toBeNull()
  })

  it('deepestTrackedKey picks the deepest segment-bounded containing key', () => {
    const keys = ['c:/proj', 'c:/proj/.termul/worktrees/feat', 'c:/pro']
    expect(deepestTrackedKey('C:\\proj\\.termul\\worktrees\\feat\\src', keys)).toBe(
      'c:/proj/.termul/worktrees/feat'
    )
    expect(deepestTrackedKey('C:/proj/src/a.ts', keys)).toBe('c:/proj')
    expect(deepestTrackedKey('C:/project/a.ts', keys)).toBeNull()
    expect(deepestTrackedKey('D:/other', keys)).toBeNull()
  })
})

describe('git-status-store error states', () => {
  it('stores a status failure, keeps the previous status, rejects, and clears on success', async () => {
    const previous: GitStatusDetail[] = [{ path: 'a.ts', status: 'modified', staged: false }]
    gitApi.getStatus.mockResolvedValueOnce(previous)
    await useGitStatusStore.getState().refreshStatus(CWD)

    gitApi.getStatus.mockRejectedValueOnce(new Error('index locked'))
    await expect(useGitStatusStore.getState().refreshStatus(CWD)).rejects.toThrow('index locked')
    expect(useGitStatusStore.getState().errors[CWD]?.status).toBe('index locked')
    expect(useGitStatusStore.getState().statuses[CWD]).toEqual(previous)
    expect(selectGitErrors(CWD)(useGitStatusStore.getState()).status).toBe('index locked')
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    expect(mockLogFrontendError.mock.calls[0][0].message).toContain('[git-status]')

    await useGitStatusStore.getState().refreshStatus(CWD)
    expect(useGitStatusStore.getState().errors[CWD]).toBeUndefined()
    expect(selectGitErrors(CWD)(useGitStatusStore.getState())).toEqual({})
  })

  it('drops the context, stores the failure and returns null, then clears on success', async () => {
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    gitApi.getCommitContext.mockRejectedValueOnce(new Error('locked'))

    await expect(useGitStatusStore.getState().fetchCommitContext(CWD)).resolves.toBeNull()
    expect(useGitStatusStore.getState().commitContexts[CWD]).toBeUndefined()
    expect(useGitStatusStore.getState().errors[CWD]?.commitContext).toBe('locked')
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)

    await useGitStatusStore.getState().fetchCommitContext(CWD)
    expect(useGitStatusStore.getState().errors[CWD]).toBeUndefined()
  })

  it('does not log anything for a successful fetch', async () => {
    await useGitStatusStore.getState().fetchCommitContext(CWD)
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })
})

describe('git-status-store diff stat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    resetGitStatusStoreControlForTests()
    vi.useRealTimers()
  })

  it('never fetches for an unwatched key', async () => {
    await useGitStatusStore.getState().refreshDiffStat(CWD)
    expect(gitApi.getDiffStat).not.toHaveBeenCalled()
    expect(selectGitDiffStat(CWD)(useGitStatusStore.getState())).toBeNull()
  })

  it('fetches a watched key and tracks it', async () => {
    const unwatch = useGitStatusStore.getState().watchDiffStat('E:\\Proj')
    await useGitStatusStore.getState().refreshDiffStat('e:/proj/')

    expect(gitApi.getDiffStat).toHaveBeenCalledTimes(1)
    expect(selectGitDiffStat('E:\\Proj')(useGitStatusStore.getState())).toEqual({
      added: 3,
      removed: 1
    })
    expect(useGitStatusStore.getState().paths['e:/proj']).toBe('E:\\Proj')
    unwatch()
  })

  it('throttles to once per 30 s with one trailing refresh', async () => {
    const unwatch = useGitStatusStore.getState().watchDiffStat(CWD)
    await useGitStatusStore.getState().refreshDiffStat(CWD)
    await vi.advanceTimersByTimeAsync(5_000)
    await useGitStatusStore.getState().refreshDiffStat(CWD)
    await useGitStatusStore.getState().refreshDiffStat(CWD)
    expect(gitApi.getDiffStat).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(24_999)
    expect(gitApi.getDiffStat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(gitApi.getDiffStat).toHaveBeenCalledTimes(2)
    unwatch()
  })

  it('ref-counts watchers and cancels the trailing refresh with the last one', async () => {
    const unwatchA = useGitStatusStore.getState().watchDiffStat(CWD)
    const unwatchB = useGitStatusStore.getState().watchDiffStat(CWD)
    await useGitStatusStore.getState().refreshDiffStat(CWD)
    await useGitStatusStore.getState().refreshDiffStat(CWD)

    unwatchA()
    unwatchA() // idempotent: must not release B's watch
    await vi.advanceTimersByTimeAsync(30_000)
    expect(gitApi.getDiffStat).toHaveBeenCalledTimes(2)

    await useGitStatusStore.getState().refreshDiffStat(CWD) // throttled: trailing scheduled
    unwatchB()
    await vi.advanceTimersByTimeAsync(60_000)
    await useGitStatusStore.getState().refreshDiffStat(CWD) // unwatched: no-op
    expect(gitApi.getDiffStat).toHaveBeenCalledTimes(2)
  })

  it('stores a diff stat failure and clears it on the next success', async () => {
    const unwatch = useGitStatusStore.getState().watchDiffStat(CWD)
    gitApi.getDiffStat.mockRejectedValueOnce(new Error('bad repo'))

    await expect(useGitStatusStore.getState().refreshDiffStat(CWD)).resolves.toBeUndefined()
    expect(useGitStatusStore.getState().errors[CWD]?.diffStat).toBe('bad repo')
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    await useGitStatusStore.getState().refreshDiffStat(CWD)
    expect(useGitStatusStore.getState().errors[CWD]).toBeUndefined()
    unwatch()
  })

  it('an own write refreshes status, context and the watched diff stat', async () => {
    const unwatch = useGitStatusStore.getState().watchDiffStat(CWD)
    await useGitStatusStore.getState().stageFiles(CWD, ['a.txt'])

    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD)
    expect(gitApi.getCommitContext).toHaveBeenCalledWith(CWD)
    expect(gitApi.getDiffStat).toHaveBeenCalledWith(CWD)
    unwatch()
  })

  it('an own write propagates its error and stores the refresh failure', async () => {
    gitApi.stage.mockRejectedValue(new Error('add failed'))
    gitApi.getStatus.mockRejectedValue(new Error('status failed'))

    await expect(useGitStatusStore.getState().stageFiles(CWD, ['a.txt'])).rejects.toThrow(
      'add failed'
    )
    expect(useGitStatusStore.getState().errors[CWD]?.status).toBe('status failed')
  })
})

describe('git-status-store refreshTracked', () => {
  afterEach(() => {
    resetGitStatusStoreControlForTests()
  })

  it('refreshes status and context of every tracked key, and watched diff stats only', async () => {
    await useGitStatusStore.getState().refreshStatus('/a')
    await useGitStatusStore.getState().refreshStatus('/b')
    const unwatch = useGitStatusStore.getState().watchDiffStat('/a')
    gitApi.getStatus.mockClear()
    gitApi.getCommitContext.mockClear()

    await useGitStatusStore.getState().refreshTracked()

    expect(gitApi.getStatus).toHaveBeenCalledTimes(2)
    expect(gitApi.getCommitContext).toHaveBeenCalledTimes(2)
    expect(gitApi.getDiffStat).toHaveBeenCalledTimes(1)
    expect(gitApi.getDiffStat).toHaveBeenCalledWith('/a')
    unwatch()
  })

  it('never rejects when a facade fails', async () => {
    await useGitStatusStore.getState().refreshStatus('/a')
    gitApi.getStatus.mockRejectedValue(new Error('boom'))
    await expect(useGitStatusStore.getState().refreshTracked()).resolves.toBeUndefined()
    expect(useGitStatusStore.getState().errors['/a']?.status).toBe('boom')
  })

  const trackKeys = (keys: string[]) =>
    useGitStatusStore.setState({ paths: Object.fromEntries(keys.map((k) => [k, k])) })

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  /** Holds every `getStatus` call open until released; records the peak. */
  function holdStatusCalls() {
    const pending: Array<() => void> = []
    const probe = { inFlight: 0, peak: 0, calls: [] as string[] }
    gitApi.getStatus.mockImplementation(
      (cwd: string) =>
        new Promise<GitStatusDetail[]>((resolve) => {
          probe.calls.push(cwd)
          probe.inFlight += 1
          probe.peak = Math.max(probe.peak, probe.inFlight)
          pending.push(() => {
            probe.inFlight -= 1
            resolve([])
          })
        })
    )
    /** Settles held calls until none are left (new ones start as others end);
     * throws instead of hanging if they never drain. */
    const drain = async () => {
      for (let i = 0; i < 200; i++) {
        await tick()
        if (pending.length === 0 && probe.inFlight === 0) return
        for (const release of pending.splice(0)) release()
      }
      throw new Error(`drain: ${probe.inFlight} getStatus calls still held`)
    }
    return { probe, drain }
  }

  it('keeps the pool bound in flight and refreshes every tracked key', async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `/k${String(i).padStart(2, '0')}`)
    trackKeys(keys)
    const { probe, drain } = holdStatusCalls()

    const done = useGitStatusStore.getState().refreshTracked()
    await drain()
    await done

    expect(probe.peak).toBe(TRACKED_REFRESH_CONCURRENCY)
    expect([...probe.calls].sort()).toEqual(keys)
  })

  it('coalesces overlapping calls into the running refresh plus one trailing run', async () => {
    trackKeys(['/a', '/b'])
    const { probe, drain } = holdStatusCalls()

    const first = useGitStatusStore.getState().refreshTracked()
    const second = useGitStatusStore.getState().refreshTracked()
    const third = useGitStatusStore.getState().refreshTracked()
    const fourth = useGitStatusStore.getState().refreshTracked()
    expect(third).toBe(second)
    expect(fourth).toBe(second)
    await tick()
    // No second fan-out while the first run is in flight.
    expect(probe.calls).toEqual(['/a', '/b'])

    await drain()
    await Promise.all([first, second, third, fourth])

    expect(probe.calls).toEqual(['/a', '/b', '/a', '/b'])
    expect(probe.peak).toBe(2)
  })

  it('a trailing run picks up a key tracked while the first run was in flight', async () => {
    trackKeys(['/a', '/b'])
    const { probe, drain } = holdStatusCalls()

    const first = useGitStatusStore.getState().refreshTracked()
    await tick()
    trackKeys(['/a', '/b', '/new'])
    const trailing = useGitStatusStore.getState().refreshTracked()

    await drain()
    await Promise.all([first, trailing])

    expect(probe.calls.slice(0, 2)).toEqual(['/a', '/b'])
    expect(probe.calls.slice(2)).toContain('/new')
  })

  it('keeps refreshing the other keys when one working copy rejects', async () => {
    trackKeys(['/a', '/b', '/c', '/d'])
    const original = useGitStatusStore.getState().refreshWorkingCopy
    const refreshed: string[] = []
    useGitStatusStore.setState({
      refreshWorkingCopy: async (cwd: string) => {
        refreshed.push(cwd)
        if (cwd === '/b') throw new Error('exploded')
      }
    })
    try {
      await expect(useGitStatusStore.getState().refreshTracked()).resolves.toBeUndefined()
      expect(refreshed.sort()).toEqual(['/a', '/b', '/c', '/d'])
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('tracked refresh failed for /b: exploded')
        })
      )
      // The next call is a fresh run that still includes the failing key.
      refreshed.length = 0
      await expect(useGitStatusStore.getState().refreshTracked()).resolves.toBeUndefined()
      expect(refreshed.sort()).toEqual(['/a', '/b', '/c', '/d'])
    } finally {
      useGitStatusStore.setState({ refreshWorkingCopy: original })
    }
  })

  it('frees a stuck key after the timeout and skips it until its refresh settles', async () => {
    vi.useFakeTimers()
    const original = useGitStatusStore.getState().refreshWorkingCopy
    try {
      const keys = Array.from({ length: TRACKED_REFRESH_CONCURRENCY + 2 }, (_, i) => `/k${i}`)
      trackKeys(keys)
      const refreshed: string[] = []
      let releaseStuck: (() => void) | undefined
      useGitStatusStore.setState({
        refreshWorkingCopy: (cwd: string) => {
          refreshed.push(cwd)
          if (cwd !== '/k0') return Promise.resolve()
          return new Promise<void>((resolve) => {
            releaseStuck = resolve
          })
        }
      })
      /** Starts `refreshTracked`; reports whether it has settled. */
      const startRun = () => {
        let settled = false
        void useGitStatusStore
          .getState()
          .refreshTracked()
          .then(() => {
            settled = true
          })
        return { isSettled: () => settled }
      }

      const first = startRun()
      await vi.advanceTimersByTimeAsync(0)
      // Every other key is refreshed while /k0 holds its slot.
      expect([...refreshed].sort()).toEqual(keys)
      expect(first.isSettled()).toBe(false)

      await vi.advanceTimersByTimeAsync(TRACKED_REFRESH_TIMEOUT_MS)
      expect(first.isSettled()).toBe(true)
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('tracked refresh failed for /k0: timed out')
        })
      )

      // The next call is not wedged, and the still-pending key is skipped.
      refreshed.length = 0
      const second = startRun()
      await vi.advanceTimersByTimeAsync(0)
      expect(second.isSettled()).toBe(true)
      expect([...refreshed].sort()).toEqual(keys.filter((k) => k !== '/k0'))
      const skipLogs = () =>
        mockLogFrontendError.mock.calls.filter(
          ([entry]) =>
            entry.message ===
            '[git-status] tracked refresh skipped for /k0: previous refresh still pending'
        ).length
      expect(skipLogs()).toBe(1)

      // Still pending: skipped again, but the episode is logged only once.
      refreshed.length = 0
      const again = startRun()
      await vi.advanceTimersByTimeAsync(0)
      expect(again.isSettled()).toBe(true)
      expect([...refreshed].sort()).toEqual(keys.filter((k) => k !== '/k0'))
      expect(skipLogs()).toBe(1)

      // Once the stuck refresh settles, the key is refreshed again.
      releaseStuck?.()
      await vi.advanceTimersByTimeAsync(0)
      refreshed.length = 0
      useGitStatusStore.setState({
        refreshWorkingCopy: (cwd: string) => {
          refreshed.push(cwd)
          return Promise.resolve()
        }
      })
      const third = startRun()
      await vi.advanceTimersByTimeAsync(0)
      expect(third.isSettled()).toBe(true)
      expect([...refreshed].sort()).toEqual(keys)
    } finally {
      useGitStatusStore.setState({ refreshWorkingCopy: original })
      vi.useRealTimers()
    }
  })
})

describe('countGitStatuses', () => {
  it('buckets modified, staged and untracked, counting a file once per bucket', () => {
    const counts = countGitStatuses([
      { path: 'a.ts', status: 'modified', staged: true },
      { path: 'a.ts', status: 'modified', staged: false },
      { path: 'a.ts', status: 'modified', staged: false },
      { path: 'b.ts', status: 'added', staged: true },
      { path: 'c.ts', status: 'deleted', staged: false },
      { path: 'u.ts', status: 'untracked', staged: false }
    ])
    expect(counts).toEqual({ modified: 2, staged: 2, untracked: 1, hasChanges: true })
  })

  it('has no changes for an empty or missing list', () => {
    expect(countGitStatuses([])).toEqual({
      modified: 0,
      staged: 0,
      untracked: 0,
      hasChanges: false
    })
    expect(countGitStatuses(undefined).hasChanges).toBe(false)
  })
})

describe('git-status-store write block for unresolved working copies', () => {
  const GONE = '/proj/.termul/worktrees/gone'

  beforeEach(() => {
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'P', color: 'blue', path: '/proj', worktrees: [] } as any],
      activeProjectId: 'p1'
    })
  })

  afterEach(() => {
    resetProjectStore()
  })

  it.each([
    ['stageFile', (s: any) => s.stageFile(GONE, 'a.ts'), 'stage'],
    ['unstageFile', (s: any) => s.unstageFile(GONE, 'a.ts'), 'unstage'],
    ['discardFile', (s: any) => s.discardFile(GONE, 'a.ts'), 'discard'],
    ['stageFiles', (s: any) => s.stageFiles(GONE, ['a.ts']), 'stage'],
    ['unstageFiles', (s: any) => s.unstageFiles(GONE, ['a.ts']), 'unstage'],
    ['discardFiles', (s: any) => s.discardFiles(GONE, ['a.ts']), 'discard'],
    ['stageHunk', (s: any) => s.stageHunk(GONE, 'a.ts', 'patch'), 'stageHunk'],
    ['unstageHunk', (s: any) => s.unstageHunk(GONE, 'a.ts', 'patch'), 'unstageHunk'],
    ['commit', (s: any) => s.commit(GONE, 'msg', '', false), 'commit'],
    ['push', (s: any) => s.push(GONE), 'push'],
    ['stashSave', (s: any) => s.stashSave(GONE, 'm'), 'stashSave'],
    ['stashApply', (s: any) => s.stashApply(GONE, 0), 'stashApply'],
    ['stashPop', (s: any) => s.stashPop(GONE, 0), 'stashPop'],
    ['stashDrop', (s: any) => s.stashDrop(GONE, 0), 'stashDrop'],
    ['branchSwitch', (s: any) => s.branchSwitch(GONE, 'x'), 'branchSwitch'],
    ['branchCreate', (s: any) => s.branchCreate(GONE, 'x'), 'createBranch']
  ])('%s throws and makes no git call', async (_name, run, apiCall) => {
    await expect(run(useGitStatusStore.getState())).rejects.toThrow(/no longer available/)
    expect((gitApi as Record<string, ReturnType<typeof vi.fn>>)[apiCall]).not.toHaveBeenCalled()
    expect(gitApi.getStatus).not.toHaveBeenCalled()
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('write blocked') })
    )
  })

  it('still writes in the project folder and in explicit paths', async () => {
    gitApi.stage.mockResolvedValue(undefined)
    await useGitStatusStore.getState().stageFiles('/proj', ['a.ts'])
    await useGitStatusStore.getState().stageFiles('/somewhere/else', ['b.ts'])
    expect(gitApi.stage).toHaveBeenCalledTimes(2)
  })

  it('stops blocking once the worktree is listed', async () => {
    gitApi.stage.mockResolvedValue(undefined)
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'P',
          color: 'blue',
          path: '/proj',
          worktrees: [{ id: 'w', name: 'gone', branch: 'b', path: GONE, createdAt: '' }]
        } as any
      ]
    })
    await useGitStatusStore.getState().stageFiles(GONE, ['a.ts'])
    expect(gitApi.stage).toHaveBeenCalledWith(GONE, 'a.ts')
  })
})

describe('git-status-store diffErrors', () => {
  const key = diffKey(CWD, 'a.ts', false)

  it('records a failed fetch and keeps the legacy sentinel and toast by default', async () => {
    gitApi.getDiff.mockRejectedValue(new Error('boom'))
    await useGitStatusStore.getState().fetchDiff(CWD, 'a.ts', false)
    const state = useGitStatusStore.getState()
    expect(state.diffErrors[key]).toBe('boom')
    expect(state.diffs[key]).toBe('')
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('notify:false keeps the cache empty, skips the toast and logs one warn', async () => {
    gitApi.getDiff.mockRejectedValue(new Error('boom'))
    await useGitStatusStore.getState().fetchDiff(CWD, 'a.ts', false, { notify: false })
    const state = useGitStatusStore.getState()
    expect(state.diffErrors[key]).toBe('boom')
    expect(key in state.diffs).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'git-status-store' })
    )
  })

  it('clears the error when a later fetch succeeds', async () => {
    gitApi.getDiff.mockRejectedValueOnce(new Error('boom'))
    await useGitStatusStore.getState().fetchDiff(CWD, 'a.ts', false, { notify: false })
    expect(useGitStatusStore.getState().diffErrors[key]).toBe('boom')

    gitApi.getDiff.mockResolvedValueOnce('diff --git a/a.ts b/a.ts')
    await useGitStatusStore.getState().fetchDiff(CWD, 'a.ts', false, { notify: false })
    const state = useGitStatusStore.getState()
    expect(state.diffErrors[key]).toBeUndefined()
    expect(state.diffs[key]).toBe('diff --git a/a.ts b/a.ts')
  })

  it('clears a file error when its diffs are invalidated by a hunk write', async () => {
    gitApi.getDiff.mockRejectedValue(new Error('boom'))
    await useGitStatusStore.getState().fetchDiff(CWD, 'a.ts', false, { notify: false })
    gitApi.stageHunk.mockResolvedValue(undefined)
    await useGitStatusStore.getState().stageHunk(CWD, 'a.ts', 'patch')
    expect(useGitStatusStore.getState().diffErrors[key]).toBeUndefined()
  })
})
