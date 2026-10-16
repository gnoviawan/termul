import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getLog, addDiffTab, acpState, gitState } = vi.hoisted(() => ({
  getLog: vi.fn(),
  addDiffTab: vi.fn(),
  acpState: {
    selectedAgentConfigId: 'cfg-1',
    agentConfigs: [{ id: 'cfg-1' }],
    generateCommitMessage: vi.fn()
  },
  gitState: {
    statuses: {
      '/work': [
        { path: 'src/staged.ts', staged: true, status: 'modified' },
        { path: 'src/one.ts', staged: false, status: 'modified' },
        { path: 'src/two.ts', staged: false, status: 'added' }
      ]
    } as Record<string, unknown[]>,
    diffs: {},
    selectedFile: null as string | null,
    setSelectedFile: vi.fn(),
    refreshStatus: vi.fn(),
    fetchDiff: vi.fn(),
    stageFiles: vi.fn(),
    unstageFiles: vi.fn(),
    discardFiles: vi.fn(),
    stageHunk: vi.fn(),
    unstageHunk: vi.fn(),
    commitContexts: {
      '/work': {
        stagedCount: 1,
        hasHead: true,
        lastSubject: '',
        lastBody: '',
        branch: 'dev',
        ahead: 1,
        behind: 0,
        hasUpstream: true
      }
    },
    fetchCommitContext: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    stashes: { '/work': [{ index: 0, name: 'stash@{0}', message: 'wip' }] },
    branches: { '/work': ['dev', 'main'] },
    fetchStashes: vi.fn(),
    fetchBranches: vi.fn(),
    stashSave: vi.fn(),
    stashApply: vi.fn(),
    stashPop: vi.fn(),
    stashDrop: vi.fn(),
    branchSwitch: vi.fn(),
    branchCreate: vi.fn()
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/git-api', () => ({ gitApi: { getDiff: vi.fn(), getLog } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: Record<string, unknown>) => unknown) => selector(acpState)
}))
vi.mock('@/stores/git-status-store', () => ({
  diffKey: (cwd: string, path: string, staged: boolean) => `${cwd}:${path}:${staged}`,
  useGitStatusStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState)
}))
vi.mock('@/stores/workspace-store/selectors', () => ({
  useWorkspaceActions: () => ({ addDiffTab })
}))

import { useGitHistoryStore } from '@/stores/git-history-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { ChangesPanel } from './ChangesPanel'

function follows(a: HTMLElement, b: HTMLElement): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('ChangesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getLog.mockResolvedValue([])
    resetShellLayoutStoreForTests()
    useShellLayoutStore.setState({ status: 'ready' })
    useGitHistoryStore.setState({ commits: {}, loading: {}, error: {} })
    gitState.selectedFile = null
  })

  it('opens the Diff tab for the working copy, path and side of a plain click', () => {
    render(<ChangesPanel cwd="/work" isVisible />)

    fireEvent.click(screen.getByText('one.ts'))
    expect(addDiffTab).toHaveBeenCalledTimes(1)
    expect(addDiffTab).toHaveBeenLastCalledWith('/work', 'src/one.ts', false)
    // Selection still follows the click.
    expect(gitState.setSelectedFile).toHaveBeenCalledWith('src/one.ts')

    fireEvent.click(screen.getByText('staged.ts'))
    expect(addDiffTab).toHaveBeenCalledTimes(2)
    expect(addDiffTab).toHaveBeenLastCalledWith('/work', 'src/staged.ts', true)
  })

  it('selects without opening a Diff tab on shift, ctrl and meta clicks', () => {
    render(<ChangesPanel cwd="/work" isVisible />)

    fireEvent.click(screen.getByText('one.ts'), { shiftKey: true })
    fireEvent.click(screen.getByText('one.ts'), { ctrlKey: true })
    fireEvent.click(screen.getByText('two.ts'), { metaKey: true })

    expect(addDiffTab).not.toHaveBeenCalled()
    expect(gitState.setSelectedFile).toHaveBeenCalledWith('src/two.ts')
  })

  it('opens the Diff tab from the keyboard like a plain click', () => {
    render(<ChangesPanel cwd="/work" isVisible />)

    const row = screen.getByText('two.ts').closest('[role="option"]') as HTMLElement
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(addDiffTab).toHaveBeenCalledWith('/work', 'src/two.ts', false)
  })

  it('stacks branch + Stash, commit box with Push, filter, Change list, Stash list, then the History row', () => {
    render(<ChangesPanel cwd="/work" isVisible />)

    const order = [
      screen.getByRole('button', { name: 'Stash changes' }),
      screen.getByLabelText('Commit summary'),
      screen.getByRole('button', { name: /Push 1/ }),
      screen.getByPlaceholderText('Filter changes'),
      screen.getByText('Changes', { selector: '.label-panel' }),
      screen.getByText('Stashes', { selector: '.label-panel' }),
      screen.getByRole('button', { name: 'Open History in the main panel' })
    ]
    for (let i = 1; i < order.length; i++) {
      expect(follows(order[i - 1], order[i])).toBe(true)
    }
    // The Diff column of the Git tab and the docked graph are not mounted.
    expect(screen.queryByText('Select a file to see changes')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Git graph' })).toBeNull()
  })

  it('scrolls the upper region on its own, apart from the History row', () => {
    render(<ChangesPanel cwd="/work" isVisible />)

    const upper = screen.getByPlaceholderText('Filter changes').closest('.overflow-y-auto')
    expect(upper).not.toBeNull()
    const history = screen.getByRole('button', { name: 'Open History in the main panel' })
    expect(upper).not.toContainElement(history)
  })

  it('filters the Change list from the filter field', () => {
    render(<ChangesPanel cwd="/work" isVisible />)

    expect(screen.getByText('one.ts')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Filter changes'), {
      target: { value: 'two' }
    })
    expect(screen.queryByText('one.ts')).toBeNull()
    expect(screen.getByText('two.ts')).toBeInTheDocument()
  })

  it('fetches status, commit context, stashes, branches and history when visible', () => {
    render(<ChangesPanel cwd="/work" isVisible />)

    expect(gitState.refreshStatus).toHaveBeenCalledWith('/work')
    expect(gitState.fetchCommitContext).toHaveBeenCalledWith('/work')
    expect(gitState.fetchStashes).toHaveBeenCalledWith('/work')
    expect(gitState.fetchBranches).toHaveBeenCalledWith('/work')
    expect(getLog).toHaveBeenCalled()
  })

  it('fetches nothing while hidden', () => {
    render(<ChangesPanel cwd="/work" isVisible={false} />)

    expect(gitState.refreshStatus).not.toHaveBeenCalled()
    expect(gitState.fetchCommitContext).not.toHaveBeenCalled()
    expect(gitState.fetchStashes).not.toHaveBeenCalled()
    expect(gitState.fetchBranches).not.toHaveBeenCalled()
    expect(getLog).not.toHaveBeenCalled()
  })

  it('handles a failed status refresh (non-git folder or IPC failure) instead of leaving it unhandled', async () => {
    // A rejected promise whose handlers we can observe: the store records the
    // error and rethrows, so the caller must attach a rejection handler.
    const rejectionHandlerAttached = vi.fn()
    const failing = {
      // biome-ignore lint/suspicious/noThenProperty: observing that a rejection handler is attached
      then: (_resolve: unknown, reject: (reason: unknown) => void) => {
        rejectionHandlerAttached()
        reject(new Error('not a git repository'))
      }
    }
    gitState.refreshStatus.mockReturnValueOnce(failing)
    render(<ChangesPanel cwd="/work" isVisible />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(gitState.refreshStatus).toHaveBeenCalledWith('/work')
    expect(rejectionHandlerAttached).toHaveBeenCalledTimes(1)
    // The rest of the visibility fetches still run.
    expect(gitState.fetchCommitContext).toHaveBeenCalledWith('/work')
    expect(gitState.fetchBranches).toHaveBeenCalledWith('/work')
  })
})
