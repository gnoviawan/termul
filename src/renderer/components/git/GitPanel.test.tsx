import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDiff, generateCommitMessage, commit, toastError, acpState, gitState } = vi.hoisted(
  () => {
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
            { path: 'a.ts', staged: true, status: 'modified' },
            { path: 'a.ts', staged: true, status: 'modified' },
            { path: 'b.ts', staged: true, status: 'added' }
          ]
        },
        diffs: {},
        selectedFile: null,
        setSelectedFile: vi.fn(),
        refreshStatus: vi.fn(),
        fetchDiff: vi.fn(),
        stageFiles: vi.fn(),
        unstageFiles: vi.fn(),
        discardFiles: vi.fn(),
        commitContexts: {
          '/work': {
            stagedCount: 2,
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
      }
    }
  }
)

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/git-api', () => ({ gitApi: { getDiff } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/components/git/GitDiffView', () => ({ GitDiffView: () => null }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: Record<string, unknown>) => unknown) => selector(acpState)
}))
vi.mock('@/stores/git-status-store', () => ({
  diffKey: (cwd: string, path: string, staged: boolean) => `${cwd}:${path}:${staged}`,
  useGitStatusStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState)
}))

import { GitPanel } from './GitPanel'

describe('GitPanel commit message generation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gitState.statuses['/work'] = [
      { path: 'a.ts', staged: true, status: 'modified' },
      { path: 'a.ts', staged: true, status: 'modified' },
      { path: 'b.ts', staged: true, status: 'added' }
    ]
    gitState.commitContexts['/work'].stagedCount = 2
    getDiff.mockImplementation(async (_cwd: string, path: string) => `diff for ${path}`)
    generateCommitMessage.mockResolvedValue({
      summary: 'Add AI commit generation',
      description: 'Use only staged changes.'
    })
  })

  it('collects unique staged diffs and populates editable fields without committing', async () => {
    render(<GitPanel cwd="/work" isVisible={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate message' }))

    await waitFor(() => expect(generateCommitMessage).toHaveBeenCalledTimes(1))
    expect(getDiff).toHaveBeenCalledTimes(2)
    expect(getDiff).toHaveBeenCalledWith('/work', 'a.ts', true)
    expect(getDiff).toHaveBeenCalledWith('/work', 'b.ts', true)
    expect(generateCommitMessage.mock.calls[0][1]).toContain('BEGIN STAGED FILE: a.ts')
    expect(generateCommitMessage.mock.calls[0][1]).toContain('BEGIN STAGED FILE: b.ts')
    expect(commit).not.toHaveBeenCalled()

    const summary = screen.getByLabelText('Commit summary')
    const description = screen.getByLabelText('Commit description')
    expect(summary).toHaveValue('Add AI commit generation')
    expect(description).toHaveValue('Use only staged changes.')
    fireEvent.change(summary, { target: { value: 'Edit generated summary' } })
    expect(summary).toHaveValue('Edit generated summary')
  })

  it('rejects when all fetched staged diffs are empty', async () => {
    getDiff.mockResolvedValue('')
    render(<GitPanel cwd="/work" isVisible={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate message' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('empty')))
    expect(generateCommitMessage).not.toHaveBeenCalled()
  })

  it('rejects when the staged status count is stale', async () => {
    gitState.commitContexts['/work'].stagedCount = 3
    render(<GitPanel cwd="/work" isVisible={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate message' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Staged files changed'))
    )
    expect(getDiff).not.toHaveBeenCalled()
    expect(generateCommitMessage).not.toHaveBeenCalled()
  })

  it('rejects when the staged path snapshot changes during diff fetch', async () => {
    getDiff.mockImplementation(async (_cwd: string, path: string) => {
      gitState.statuses['/work'] = [{ path: 'c.ts', staged: true, status: 'modified' }]
      return `diff for ${path}`
    })
    render(<GitPanel cwd="/work" isVisible={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate message' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('changed during generation'))
    )
    expect(generateCommitMessage).not.toHaveBeenCalled()
  })

  it('rejects an oversized aggregate before dispatch', async () => {
    getDiff.mockResolvedValue('x'.repeat(60_001))
    render(<GitPanel cwd="/work" isVisible={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate message' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('too large'))
    )
    expect(generateCommitMessage).not.toHaveBeenCalled()
  })

  it('preserves existing fields and deduplicates a same-tick double click on failure', async () => {
    let reject!: (error: Error) => void
    generateCommitMessage.mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
    )
    render(<GitPanel cwd="/work" isVisible={false} />)
    fireEvent.change(screen.getByLabelText('Commit summary'), { target: { value: 'Existing' } })
    const button = screen.getByRole('button', { name: 'Generate message' })

    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(generateCommitMessage).toHaveBeenCalledTimes(1))
    reject(new Error('agent failed'))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('agent failed'))
    expect(screen.getByLabelText('Commit summary')).toHaveValue('Existing')
    expect(commit).not.toHaveBeenCalled()
  })
})
