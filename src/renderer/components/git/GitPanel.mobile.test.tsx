import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDiff, generateCommitMessage, commit, toastError, acpState, gitState, mobileRef } =
  vi.hoisted(() => {
    const getDiff = vi.fn()
    const generateCommitMessage = vi.fn()
    const commit = vi.fn()
    const toastError = vi.fn()
    return {
      getDiff,
      generateCommitMessage,
      commit,
      toastError,
      acpState: {
        selectedAgentConfigId: 'cfg-1',
        agentConfigs: [{ id: 'cfg-1' }],
        generateCommitMessage
      },
      gitState: {
        statuses: {
          '/work': [
            { path: 'a.ts', staged: false, status: 'modified' },
            { path: 'b.ts', staged: true, status: 'added' }
          ]
        },
        diffs: {
          '/work:a.ts:true': 'diff for a.ts',
          '/work:a.ts:false': 'diff for a.ts'
        },
        selectedFile: null as string | null,
        setSelectedFile: vi.fn(),
        refreshStatus: vi.fn(),
        fetchDiff: vi.fn(),
        stageFiles: vi.fn(),
        unstageFiles: vi.fn(),
        discardFiles: vi.fn(),
        commitContexts: {
          '/work': {
            stagedCount: 1,
            hasHead: true,
            lastSubject: '',
            lastBody: '',
            branch: 'dev',
            ahead: 0,
            behind: 0,
            hasUpstream: true
          }
        },
        fetchCommitContext: vi.fn(),
        commit,
        push: vi.fn(),
        stashes: {},
        branches: {},
        fetchStashes: vi.fn(),
        fetchBranches: vi.fn(),
        stashSave: vi.fn(),
        stashApply: vi.fn(),
        stashPop: vi.fn(),
        stashDrop: vi.fn(),
        branchSwitch: vi.fn(),
        branchCreate: vi.fn()
      },
      // Mutable so individual tests can flip the mobile branch on/off.
      mobileRef: { current: true as boolean }
    }
  })

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/git-api', () => ({ gitApi: { getDiff } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/components/git/GitDiffView', () => ({
  GitDiffView: () => <div data-testid="git-diff-view">diff view</div>
}))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: Record<string, unknown>) => unknown) => selector(acpState)
}))
vi.mock('@/stores/git-status-store', () => ({
  diffKey: (cwd: string, path: string, staged: boolean) => `${cwd}:${path}:${staged}`,
  useGitStatusStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState)
}))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

import { GitPanel } from './GitPanel'

describe('GitPanel mobile branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = true
    gitState.selectedFile = null
    gitState.statuses['/work'] = [
      { path: 'a.ts', staged: false, status: 'modified' },
      { path: 'b.ts', staged: true, status: 'added' }
    ]
    gitState.commitContexts['/work'].stagedCount = 1
    getDiff.mockResolvedValue('diff for a.ts')
    generateCommitMessage.mockResolvedValue({ summary: 'S', description: '' })
  })

  it('renders the file list full-width (no diff view) when no file is selected', () => {
    const { container } = render(<GitPanel cwd="/work" isVisible />)

    // File list is present: the branch dropdown + the filter input.
    expect(screen.getByPlaceholderText('Filter changes...')).toBeInTheDocument()
    // No back button (only shown when a file is selected).
    expect(screen.queryByLabelText('Back to file list')).not.toBeInTheDocument()
    // No diff view rendered (mobile hides the diff panel until a file is picked).
    expect(screen.queryByTestId('git-diff-view')).not.toBeInTheDocument()
    // Mobile file list is full-width, not the desktop `w-80` sidebar.
    expect(container.querySelector('.w-80')).toBeNull()
  })

  it('swaps to the diff view with a back button when a file is selected', () => {
    gitState.selectedFile = 'a.ts'
    render(<GitPanel cwd="/work" isVisible />)

    // Diff view + back button render; file list is hidden.
    expect(screen.getByTestId('git-diff-view')).toBeInTheDocument()
    expect(screen.getByLabelText('Back to file list')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
  })

  it('clears selectedFile when the back button is tapped', () => {
    gitState.selectedFile = 'a.ts'
    render(<GitPanel cwd="/work" isVisible />)

    fireEvent.click(screen.getByLabelText('Back to file list'))
    expect(gitState.setSelectedFile).toHaveBeenCalledWith(null)
  })
})

describe('GitPanel desktop branch (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = false
    gitState.selectedFile = 'a.ts'
    gitState.statuses['/work'] = [
      { path: 'a.ts', staged: false, status: 'modified' },
      { path: 'b.ts', staged: true, status: 'added' }
    ]
    getDiff.mockResolvedValue('diff for a.ts')
  })

  it('renders the two-column layout (file list sidebar + diff) when a file is selected', () => {
    const { container } = render(<GitPanel cwd="/work" isVisible />)

    // Desktop keeps the `w-80` file-list sidebar AND the diff view side-by-side.
    expect(container.querySelector('.w-80')).not.toBeNull()
    expect(screen.getByTestId('git-diff-view')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Filter changes...')).toBeInTheDocument()
    // Desktop never renders the mobile back button.
    expect(screen.queryByLabelText('Back to file list')).not.toBeInTheDocument()
  })
})
