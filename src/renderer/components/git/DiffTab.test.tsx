import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitApi, toastError, mockLogFrontendError, capability } = vi.hoisted(() => ({
  gitApi: {
    getDiff: vi.fn(),
    stageHunk: vi.fn(),
    unstageHunk: vi.fn(),
    getStatus: vi.fn(),
    getCommitContext: vi.fn(),
    getDiffStat: vi.fn()
  },
  toastError: vi.fn(),
  mockLogFrontendError: vi.fn(),
  capability: { admitted: true }
}))

vi.mock('@/lib/git-api', () => ({ gitApi }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => capability.admitted
}))

import { diffKey, useGitStatusStore } from '@/stores/git-status-store'
import { DiffTab } from './DiffTab'

const CWD = '/wt/feature'
const PATH = 'src/a.ts'

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const x = 1
-oldLine
+newLine
 const y = 2
`

function renderTab(overrides: Partial<{ staged: boolean; isVisible: boolean }> = {}) {
  return render(
    <DiffTab
      cwd={CWD}
      path={PATH}
      staged={overrides.staged ?? false}
      isVisible={overrides.isVisible ?? true}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  capability.admitted = true
  useGitStatusStore.setState({
    paths: {},
    statuses: {},
    diffs: {},
    diffErrors: {},
    commitContexts: {},
    diffStats: {},
    errors: {},
    selectedFile: null
  })
  gitApi.getDiff.mockResolvedValue(SAMPLE_DIFF)
  gitApi.stageHunk.mockResolvedValue(undefined)
  gitApi.unstageHunk.mockResolvedValue(undefined)
  gitApi.getStatus.mockResolvedValue([])
  gitApi.getCommitContext.mockResolvedValue({
    branch: 'main',
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    hasHead: true,
    lastSubject: '',
    lastBody: ''
  })
  gitApi.getDiffStat.mockResolvedValue({ added: 0, removed: 0 })
})

describe('DiffTab', () => {
  it('loads the diff for its own cwd and renders the header and hunk controls', async () => {
    renderTab()

    expect(screen.getByText('Loading diff...')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Stage hunk' })).toBeEnabled()
    expect(gitApi.getDiff).toHaveBeenCalledTimes(1)
    expect(gitApi.getDiff).toHaveBeenCalledWith(CWD, PATH, false)
    expect(screen.getByTitle(PATH)).toBeInTheDocument()
    expect(screen.getByText('Working tree')).toBeInTheDocument()
    expect(screen.getByText(/newLine/)).toBeInTheDocument()
  })

  it('labels the staged side and offers Unstage hunk', async () => {
    renderTab({ staged: true })

    expect(await screen.findByRole('button', { name: 'Unstage hunk' })).toBeEnabled()
    expect(screen.getByText('Staged')).toBeInTheDocument()
    expect(gitApi.getDiff).toHaveBeenCalledWith(CWD, PATH, true)
  })

  it('does not fetch while hidden, then loads when shown', async () => {
    const { rerender } = renderTab({ isVisible: false })
    expect(gitApi.getDiff).not.toHaveBeenCalled()

    rerender(<DiffTab cwd={CWD} path={PATH} staged={false} isVisible />)
    expect(await screen.findByRole('button', { name: 'Stage hunk' })).toBeInTheDocument()
    expect(gitApi.getDiff).toHaveBeenCalledTimes(1)
  })

  it('shows "No diff available" for an empty diff and keeps rendering the tab', async () => {
    gitApi.getDiff.mockResolvedValue('')
    renderTab()

    expect(await screen.findByText('No diff available')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load this diff.")).not.toBeInTheDocument()
  })

  it('shows the failure state with Retry, no toast, and refetches on Retry', async () => {
    gitApi.getDiff.mockRejectedValueOnce(new Error('git exploded'))
    renderTab()

    expect(await screen.findByText("Couldn't load this diff.")).toBeInTheDocument()
    expect(screen.getByText('git exploded')).toBeInTheDocument()
    expect(screen.queryByText('No diff available')).not.toBeInTheDocument()
    expect(toastError).not.toHaveBeenCalled()
    expect(useGitStatusStore.getState().diffErrors[diffKey(CWD, PATH, false)]).toBe('git exploded')
    const warns = mockLogFrontendError.mock.calls.filter(([entry]) => entry.level === 'warn')
    expect(warns).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('button', { name: 'Stage hunk' })).toBeInTheDocument()
    expect(gitApi.getDiff).toHaveBeenCalledTimes(2)
    expect(screen.queryByText("Couldn't load this diff.")).not.toBeInTheDocument()
  })

  it('stages a hunk against the tab cwd and reloads the diff', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Stage hunk' }))

    await waitFor(() => expect(gitApi.stageHunk).toHaveBeenCalledTimes(1))
    expect(gitApi.stageHunk).toHaveBeenCalledWith(CWD, PATH, expect.stringContaining('@@'))
    // The write invalidated the cache: the tab reads the (now smaller) diff again.
    await waitFor(() => expect(gitApi.getDiff).toHaveBeenCalledTimes(2))
    expect(toastError).not.toHaveBeenCalled()
  })

  it('toasts and logs one warn (never the patch) when staging a hunk fails', async () => {
    gitApi.stageHunk.mockRejectedValue(new Error('patch does not apply'))
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Stage hunk' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Failed to stage hunk: Error: patch does not apply')
    )
    const warns = mockLogFrontendError.mock.calls.filter(([entry]) => entry.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(JSON.stringify(warns[0][0])).not.toContain('newLine')
  })

  it('unstages a hunk on the staged side', async () => {
    renderTab({ staged: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Unstage hunk' }))

    await waitFor(() => expect(gitApi.unstageHunk).toHaveBeenCalledTimes(1))
    expect(gitApi.unstageHunk).toHaveBeenCalledWith(CWD, PATH, expect.stringContaining('@@'))
    expect(gitApi.stageHunk).not.toHaveBeenCalled()
  })

  it('disables hunk controls with a visible reason and makes no call on a read-only server', async () => {
    capability.admitted = false
    renderTab()

    const button = await screen.findByRole('button', { name: 'Stage hunk' })
    expect(button).toBeDisabled()
    expect(
      screen.getAllByText('This server is read-only for remote clients.').length
    ).toBeGreaterThan(0)

    fireEvent.click(button)
    expect(gitApi.stageHunk).not.toHaveBeenCalled()
    expect(gitApi.unstageHunk).not.toHaveBeenCalled()
  })
})
