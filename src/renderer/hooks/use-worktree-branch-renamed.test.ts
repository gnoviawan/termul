import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, acpState, projectState } = vi.hoisted(() => {
  const projectState: { projects: unknown[]; activeProjectId: string } = {
    projects: [],
    activeProjectId: ''
  }
  const loadSessionIndex = vi.fn().mockResolvedValue(undefined)
  const acpState: {
    sessions: Record<string, { worktreePath?: string; worktreeBranch?: string; agentId: string }>
    loadSessionIndex: typeof loadSessionIndex
  } = { sessions: {}, loadSessionIndex }
  return {
    acpState,
    projectState,
    mocks: {
      loadSessionIndex,
      reconcile: vi.fn().mockResolvedValue('updated'),
      logFrontendError: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn(),
      onEvent: vi.fn(),
      watchSubscribe: vi.fn(),
      transport: { watchesEnabled: false }
    }
  }
})

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: Object.assign((selector: (s: typeof acpState) => unknown) => selector(acpState), {
    getState: () => acpState,
    setState: (
      update: (s: typeof acpState) => Partial<typeof acpState> | typeof acpState
    ): void => {
      Object.assign(acpState, update(acpState))
    }
  })
}))

vi.mock('@/lib/acp-transport', async () => {
  const actual = await vi.importActual<typeof import('@/lib/acp-transport')>('@/lib/acp-transport')
  return {
    ...actual,
    getAcpTransport: () => ({
      onEvent: mocks.onEvent,
      ...(mocks.transport.watchesEnabled ? { watches: { subscribe: mocks.watchSubscribe } } : {})
    })
  }
})

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => projectState,
    setState: (update: Partial<typeof projectState>): void => {
      Object.assign(projectState, update)
    }
  }
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.logFrontendError }))

vi.mock('@/lib/worktree-reconciler', async () => {
  const actual = await vi.importActual<typeof import('@/lib/worktree-reconciler')>(
    '@/lib/worktree-reconciler'
  )
  return { ...actual, reconcileProjectWorktrees: mocks.reconcile }
})

import type { Project } from '@/types/project'
import {
  handleWorktreeBranchRenamed,
  useWorktreeBranchRenamed
} from './use-worktree-branch-renamed'

function project(id: string, path: string, worktreePaths: string[] = []): Project {
  return {
    id,
    name: id,
    color: 'blue',
    path,
    worktrees: worktreePaths.map((p, i) => ({
      id: `wt-${id}-${i}`,
      name: `wt${i}`,
      path: p,
      branch: 'chat/ab12cd34'
    }))
  } as unknown as Project
}

const WT = 'E:/proj-a/.termul/worktrees/ab12cd34'

describe('useWorktreeBranchRenamed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transport.watchesEnabled = false
    acpState.sessions = {}
    projectState.projects = []
    mocks.onEvent.mockReturnValue(mocks.unsubscribe)
    mocks.reconcile.mockResolvedValue('updated')
    mocks.loadSessionIndex.mockResolvedValue(undefined)
  })

  it('subscribes to acp:worktree_branch_renamed and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useWorktreeBranchRenamed())
    expect(mocks.onEvent).toHaveBeenCalledWith('acp:worktree_branch_renamed', expect.any(Function))
    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('on web the rename is a chat_history watch delta: the hook watches, not onEvent', () => {
    mocks.transport.watchesEnabled = true
    mocks.watchSubscribe.mockReturnValue(mocks.unsubscribe)
    acpState.sessions = {
      a: { agentId: 'x', worktreePath: WT, worktreeBranch: 'chat/ab12cd34' }
    }
    const { unmount } = renderHook(() => useWorktreeBranchRenamed())
    expect(mocks.onEvent).not.toHaveBeenCalled()
    expect(mocks.watchSubscribe).toHaveBeenCalledWith('chat_history', expect.any(Object))
    const handlers = mocks.watchSubscribe.mock.calls[0][1] as {
      onDelta: (delta: unknown) => void
    }

    // A plain index delta is not a rename.
    handlers.onDelta({ changed: ['s-1'] })
    expect(acpState.sessions.a.worktreeBranch).toBe('chat/ab12cd34')

    handlers.onDelta({
      changed: [],
      event: 'worktree_branch_renamed',
      payload: { worktreePath: WT, oldBranch: 'chat/ab12cd34', newBranch: 'chat/fix-login' }
    })
    expect(acpState.sessions.a.worktreeBranch).toBe('chat/fix-login')
    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('applies the new branch to live sessions on that worktree (path-key match)', () => {
    acpState.sessions = {
      a: {
        agentId: 'x',
        worktreePath: 'e:\\Proj-A\\.termul\\worktrees\\ab12cd34\\',
        worktreeBranch: 'chat/ab12cd34'
      },
      b: { agentId: 'x', worktreePath: WT, worktreeBranch: 'chat/ab12cd34' },
      other: {
        agentId: 'x',
        worktreePath: 'E:/proj-a/.termul/worktrees/zz',
        worktreeBranch: 'chat/zz'
      },
      bare: { agentId: 'x' }
    }
    handleWorktreeBranchRenamed({
      worktreePath: WT,
      oldBranch: 'chat/ab12cd34',
      newBranch: 'chat/fix-login'
    })
    expect(acpState.sessions.a.worktreeBranch).toBe('chat/fix-login')
    expect(acpState.sessions.b.worktreeBranch).toBe('chat/fix-login')
    expect(acpState.sessions.other.worktreeBranch).toBe('chat/zz')
    expect(acpState.sessions.bare.worktreeBranch).toBeUndefined()
  })

  it('reconciles every project that lists or contains the worktree, and only those', () => {
    projectState.projects = [
      project('lists', 'E:/elsewhere', [WT]),
      project('contains', 'E:/proj-a'),
      project('unrelated', 'E:/proj-b', ['E:/proj-b/.termul/worktrees/x'])
    ]
    handleWorktreeBranchRenamed({
      worktreePath: WT,
      oldBranch: 'chat/ab12cd34',
      newBranch: 'chat/fix-login'
    })
    const reconciled = mocks.reconcile.mock.calls.map((c) => c[0]).sort()
    expect(reconciled).toEqual(['contains', 'lists'])
  })

  it('refreshes the session index', () => {
    handleWorktreeBranchRenamed({
      worktreePath: WT,
      oldBranch: 'chat/ab12cd34',
      newBranch: 'chat/fix-login'
    })
    expect(mocks.loadSessionIndex).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed payloads', () => {
    handleWorktreeBranchRenamed(null)
    handleWorktreeBranchRenamed({ worktreePath: '', newBranch: 'x' })
    handleWorktreeBranchRenamed({ worktreePath: WT })
    expect(mocks.loadSessionIndex).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  it('logs a warning without branch names when the index refresh or reconcile fails', async () => {
    projectState.projects = [project('lists', 'E:/proj-a', [WT])]
    mocks.loadSessionIndex.mockRejectedValue(new Error('index boom'))
    mocks.reconcile.mockRejectedValue(new Error('reconcile boom'))
    handleWorktreeBranchRenamed({
      worktreePath: WT,
      oldBranch: 'chat/secret-old',
      newBranch: 'chat/secret-new'
    })
    await vi.waitFor(() => expect(mocks.logFrontendError).toHaveBeenCalledTimes(2))
    for (const [entry] of mocks.logFrontendError.mock.calls) {
      expect(entry.level).toBe('warn')
      expect(JSON.stringify(entry)).not.toContain('secret')
    }
  })
})
