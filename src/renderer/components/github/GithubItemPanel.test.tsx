import type {
  GithubChecksResult,
  GithubItemDetail,
  GithubPullDetail
} from '@shared/types/github.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GithubItemTabInline } from '@/components/workspace/tabs/github-item-tab'
import { expectNotWriteGated, expectWriteGated } from '@/lib/test-utils/write-gate'
import { useGithubStore } from '@/stores/github-store'
import { GithubItemPanel } from './GithubItemPanel'

const api = vi.hoisted(() => ({
  getContext: vi.fn(),
  listItems: vi.fn(),
  getItem: vi.fn(),
  getChecks: vi.fn(),
  getCheckLog: vi.fn(),
  merge: vi.fn(),
  comment: vi.fn(),
  checkoutPr: vi.fn()
}))
const writes = vi.hoisted(() => ({ admitted: true }))

vi.mock('@/lib/github-api', () => ({ githubApi: api }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => writes.admitted
}))
vi.mock('@/components/chat/chat-agent-prose', () => ({
  AgentProse: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>
}))

const CWD = '/repo'
const REPO = { host: 'github.com', owner: 'acme', name: 'app' }
const ok = <T,>(data: T) => ({ success: true as const, data })

function pull(overrides: Partial<GithubPullDetail> = {}): GithubPullDetail {
  return {
    headRefName: 'fix/crash',
    headSha: 'abc123',
    baseRefName: 'main',
    isCrossRepository: false,
    maintainerCanModify: false,
    mergeable: 'mergeable',
    mergeStateStatus: 'CLEAN',
    autoMergeEnabled: false,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    reviewThreads: [],
    ...overrides
  }
}

function detail(overrides: Partial<GithubItemDetail> = {}): GithubItemDetail {
  return {
    repo: REPO,
    item: {
      kind: 'pr',
      number: 15,
      title: 'Fix the crash',
      state: 'open',
      author: 'ana',
      labels: [],
      assignees: ['bo'],
      commentCount: 2,
      updatedAt: '2026-10-30T10:00:00Z',
      url: 'https://github.com/acme/app/pull/15',
      checks: 'failure'
    },
    body: 'Fixes the crash on start.',
    createdAt: '2026-10-29T10:00:00Z',
    comments: [
      { id: 'c1', author: 'first', body: 'Looks good', createdAt: '2026-10-29T11:00:00Z', url: '' },
      { id: 'c2', author: 'second', body: 'Ship it', createdAt: '2026-10-29T12:00:00Z', url: '' }
    ],
    pr: pull(),
    fetchedAt: '2026-10-31T10:00:00Z',
    ...overrides
  }
}

const CHECKS: GithubChecksResult = {
  headSha: 'abc123',
  rollup: 'failure',
  checks: [
    { name: 'lint', workflow: 'CI', status: 'success', detailsUrl: null, jobId: 1 },
    { name: 'test', workflow: 'CI', status: 'failure', detailsUrl: null, jobId: 2 }
  ],
  fetchedAt: '2026-10-31T10:00:00Z'
}

function renderPanel(kind: 'issue' | 'pr' = 'pr', isVisible = true) {
  return render(
    <GithubItemPanel cwd={CWD} repo="origin" kind={kind} number={15} isVisible={isVisible} />
  )
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  writes.admitted = true
  useGithubStore.setState({ contexts: {}, lists: {}, items: {}, checks: {}, logs: {}, filters: {} })
  api.getChecks.mockResolvedValue(ok(CHECKS))
  api.listItems.mockResolvedValue(ok({ repo: REPO, items: [], fetchedAt: '' }))
})

describe('GithubItemPanel', () => {
  it('renders the body, then comments oldest first', async () => {
    api.getItem.mockResolvedValue(ok(detail()))
    renderPanel()

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Fix the crash #15')
    const markdown = screen.getAllByTestId('markdown').map((el) => el.textContent)
    expect(markdown).toEqual(['Fixes the crash on start.', 'Looks good', 'Ship it'])
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(api.getItem).toHaveBeenCalledWith({
      cwd: CWD,
      repo: 'origin',
      kind: 'pr',
      number: 15,
      refresh: undefined
    })
  })

  it('lists the failed check first and unfolds its log tail', async () => {
    api.getItem.mockResolvedValue(ok(detail()))
    api.getCheckLog.mockResolvedValue(
      ok({ jobId: 2, tail: 'Error: expected 1 to be 2', truncated: true })
    )
    renderPanel()

    const checks = await screen.findByRole('region', { name: /Checks/ })
    await within(checks).findByText('test')
    const rows = within(checks).getAllByRole('listitem')
    expect(within(rows[0]).getByRole('img', { name: 'Failed' })).toBeInTheDocument()
    expect(rows[0]).toHaveTextContent('test')
    expect(within(rows[1]).getByRole('img', { name: 'Passed' })).toBeInTheDocument()
    expect(within(rows[1]).queryByRole('button', { name: /^Log of/ })).toBeNull()

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Log of test' }))
    expect(await within(rows[0]).findByText('Error: expected 1 to be 2')).toBeInTheDocument()
    expect(api.getCheckLog).toHaveBeenCalledWith({ cwd: CWD, repo: 'origin', jobId: 2 })
  })

  it('reads nothing while its tab is hidden, then loads once it shows', async () => {
    api.getItem.mockResolvedValue(ok(detail()))
    const { rerender } = renderPanel('pr', false)
    await act(async () => {})
    expect(api.getItem).not.toHaveBeenCalled()
    expect(api.getChecks).not.toHaveBeenCalled()

    rerender(<GithubItemPanel cwd={CWD} repo="origin" kind="pr" number={15} isVisible />)
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Fix the crash #15')
    expect(api.getChecks).toHaveBeenCalledTimes(1)
  })

  it('re-reads the checks past the cache when the PR head moved', async () => {
    api.getItem.mockResolvedValue(ok(detail({ pr: pull({ headSha: 'def456' }) })))
    renderPanel()

    await waitFor(() =>
      expect(api.getChecks).toHaveBeenLastCalledWith({
        cwd: CWD,
        repo: 'origin',
        number: 15,
        refresh: true
      })
    )
    expect(api.getChecks).toHaveBeenCalledTimes(2)
  })

  it("hides the previous head's checks until the new head's checks arrive", async () => {
    api.getItem.mockResolvedValue(ok(detail({ pr: pull({ headSha: 'def456' }) })))
    const fresh = deferred<ReturnType<typeof ok<typeof CHECKS>>>()
    api.getChecks.mockResolvedValueOnce(ok(CHECKS)).mockReturnValueOnce(fresh.promise)
    renderPanel()

    const checks = await screen.findByRole('region', { name: /Checks/ })
    await waitFor(() => expect(api.getChecks).toHaveBeenCalledTimes(2))
    expect(within(checks).queryAllByRole('listitem')).toHaveLength(0)

    fresh.resolve(ok({ ...CHECKS, headSha: 'def456' }))
    await waitFor(() => expect(within(checks).getAllByRole('listitem').length).toBeGreaterThan(0))
  })

  it("shows the error when the new head's checks fail to load", async () => {
    api.getItem.mockResolvedValue(ok(detail({ pr: pull({ headSha: 'def456' }) })))
    api.getChecks
      .mockResolvedValueOnce(ok(CHECKS))
      .mockResolvedValueOnce({ success: false, error: 'rate limited', code: 'GH_RATE_LIMITED' })
    renderPanel()

    const checks = await screen.findByRole('region', { name: /Checks/ })
    expect(
      await within(checks).findByText(/Couldn't load checks: rate limited/)
    ).toBeInTheDocument()
    expect(within(checks).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('keeps the merge controls disabled while the item is being re-read', async () => {
    api.getItem.mockResolvedValue(ok(detail({ pr: pull({ mergeStateStatus: 'CLEAN' }) })))
    renderPanel()
    const mergeBox = await screen.findByRole('region', { name: 'Merge' })
    expect(within(mergeBox).getByRole('button', { name: 'Merge' })).toBeEnabled()

    const reread = deferred<ReturnType<typeof ok<GithubItemDetail>>>()
    api.getItem.mockReturnValueOnce(reread.promise)
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() =>
      expect(within(mergeBox).getByRole('button', { name: 'Merge' })).toBeDisabled()
    )

    reread.resolve(ok(detail({ pr: pull({ mergeStateStatus: 'CLEAN' }) })))
    await waitFor(() =>
      expect(within(mergeBox).getByRole('button', { name: 'Merge' })).toBeEnabled()
    )
  })

  it('gives each Actions job its own row when two share a workflow and name', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.getItem.mockResolvedValue(ok(detail()))
    api.getChecks.mockResolvedValue(
      ok({
        ...CHECKS,
        checks: [
          { name: 'test', workflow: 'CI', status: 'failure', detailsUrl: null, jobId: 2 },
          { name: 'test', workflow: 'CI', status: 'success', detailsUrl: null, jobId: 3 }
        ]
      })
    )
    renderPanel()

    const checks = await screen.findByRole('region', { name: /Checks/ })
    await waitFor(() => expect(within(checks).getAllByRole('listitem')).toHaveLength(2))
    expect(errors.mock.calls.flat().join(' ')).not.toContain('same key')
    errors.mockRestore()
  })

  it('keeps the merge controls busy until the PR re-read lands', async () => {
    api.getItem.mockResolvedValue(ok(detail({ pr: pull({ mergeStateStatus: 'BLOCKED' }) })))
    api.merge.mockResolvedValue(ok({ number: 15 }))
    renderPanel()
    const mergeBox = await screen.findByRole('region', { name: 'Merge' })

    const reread = deferred<ReturnType<typeof ok<GithubItemDetail>>>()
    api.getItem.mockReturnValueOnce(reread.promise)
    fireEvent.click(within(mergeBox).getByRole('button', { name: 'Enable auto-merge' }))
    await waitFor(() => expect(api.getItem).toHaveBeenCalledTimes(2))
    expect(within(mergeBox).getByRole('button', { name: 'Enable auto-merge' })).toBeDisabled()

    await act(async () => {
      reread.resolve(
        ok(detail({ pr: pull({ mergeStateStatus: 'BLOCKED', autoMergeEnabled: true }) }))
      )
    })
    expect(
      await within(mergeBox).findByRole('button', { name: 'Disable auto-merge' })
    ).toBeEnabled()
  })

  it('disables Merge with the reason when GitHub reports the PR blocked', async () => {
    api.getItem.mockResolvedValue(ok(detail({ pr: pull({ mergeStateStatus: 'BLOCKED' }) })))
    renderPanel()

    const mergeBox = await screen.findByRole('region', { name: 'Merge' })
    expect(within(mergeBox).getByRole('button', { name: 'Merge' })).toBeDisabled()
    expect(mergeBox).toHaveTextContent('Merging is blocked by required reviews or checks.')
    expect(within(mergeBox).getByRole('button', { name: 'Enable auto-merge' })).toBeEnabled()
  })

  it('merges a clean PR after the confirm and re-reads it past the cache', async () => {
    api.getItem.mockResolvedValue(ok(detail()))
    api.merge.mockResolvedValue(ok({ number: 15 }))
    renderPanel()

    const mergeBox = await screen.findByRole('region', { name: 'Merge' })
    const merge = within(mergeBox).getByRole('button', { name: 'Merge' })
    expectNotWriteGated(merge)
    fireEvent.click(merge)
    const confirm = await screen.findByRole('alertdialog', { name: 'Merge pull request #15?' })
    expect(confirm).toHaveTextContent('Merge fix/crash into main on GitHub.')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Merge' }))

    await waitFor(() =>
      expect(api.merge).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        number: 15,
        action: { kind: 'merge', method: 'merge' }
      })
    )
    await waitFor(() =>
      expect(api.getItem).toHaveBeenLastCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'pr',
        number: 15,
        refresh: true
      })
    )
  })

  it('gates the merge controls on a read-only server', async () => {
    writes.admitted = false
    api.getItem.mockResolvedValue(ok(detail()))
    renderPanel()

    const mergeBox = await screen.findByRole('region', { name: 'Merge' })
    expectWriteGated(within(mergeBox).getByRole('button', { name: 'Merge' }))
  })

  it('shows a merged PR as merged, without merge controls', async () => {
    api.getItem.mockResolvedValue(
      ok(detail({ item: { ...detail().item, state: 'merged', checks: 'success' } }))
    )
    renderPanel()

    expect(await screen.findByText('Merged')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Merge' })).toBeNull()
  })

  it('posts a comment with Ctrl+Enter and shows the comment GitHub returned', async () => {
    api.getItem.mockResolvedValueOnce(ok(detail()))
    // The re-read stays in flight, so what shows is the comment the post returned.
    api.getItem.mockReturnValue(new Promise(() => {}))
    api.comment.mockResolvedValue(
      ok({
        comment: {
          id: 'c3',
          author: 'me',
          body: 'Posted on GitHub',
          createdAt: '2026-10-31T11:00:00Z',
          url: 'https://github.com/acme/app/pull/15#issuecomment-3'
        }
      })
    )
    renderPanel('issue')

    const box = await screen.findByRole('textbox', { name: 'Add a comment' })
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled()
    fireEvent.change(box, { target: { value: 'Thanks, **merged**' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(api.comment).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'issue',
        number: 15,
        target: { kind: 'conversation' },
        body: 'Thanks, **merged**'
      })
    )
    const markdown = await screen.findAllByTestId('markdown')
    expect(markdown.map((el) => el.textContent)).toEqual([
      'Fixes the crash on start.',
      'Looks good',
      'Ship it',
      'Posted on GitHub'
    ])
    expect(box).toHaveValue('')
    expect(api.getItem).toHaveBeenLastCalledWith({
      cwd: CWD,
      repo: 'origin',
      kind: 'issue',
      number: 15,
      refresh: true
    })
  })

  it('keeps the text and shows the error when GitHub refuses the comment', async () => {
    api.getItem.mockResolvedValue(ok(detail()))
    api.comment.mockResolvedValue({
      success: false,
      code: 'GH_FAILED',
      error: 'Resource not accessible by integration'
    })
    renderPanel()

    const box = await screen.findByRole('textbox', { name: 'Add a comment' })
    fireEvent.change(box, { target: { value: 'Draft reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Resource not accessible by integration'
    )
    expect(box).toHaveValue('Draft reply')
    expect(screen.getAllByTestId('markdown')).toHaveLength(3)
  })

  it('replies inside a review thread', async () => {
    const thread = {
      id: 'PRRT_1',
      path: 'src/app.ts',
      line: 4,
      isResolved: false,
      isOutdated: false,
      comments: [
        { id: 'r1', author: 'rev', body: 'Rename this', createdAt: '2026-10-30T10:00:00Z', url: '' }
      ]
    }
    api.getItem.mockResolvedValueOnce(ok(detail({ pr: pull({ reviewThreads: [thread] }) })))
    api.getItem.mockReturnValue(new Promise(() => {}))
    api.comment.mockResolvedValue(
      ok({
        comment: {
          id: 'r2',
          author: 'me',
          body: 'Renamed',
          createdAt: '2026-10-31T11:00:00Z',
          url: ''
        }
      })
    )
    renderPanel()

    const threads = await screen.findByRole('region', { name: /Review threads/ })
    fireEvent.click(within(threads).getByRole('button', { name: 'Reply' }))
    const reply = within(threads).getByRole('textbox', { name: 'Reply to this thread' })
    fireEvent.change(reply, { target: { value: 'Renamed' } })
    fireEvent.click(within(threads).getByRole('button', { name: 'Reply' }))

    await waitFor(() =>
      expect(api.comment).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'pr',
        number: 15,
        target: { kind: 'review_thread', threadId: 'PRRT_1' },
        body: 'Renamed'
      })
    )
    await waitFor(() =>
      expect(
        within(threads)
          .getAllByTestId('markdown')
          .map((el) => el.textContent)
      ).toEqual(['Rename this', 'Renamed'])
    )
    expect(within(threads).queryByRole('textbox')).toBeNull()
  })

  it('gates the comment box on a read-only server', async () => {
    writes.admitted = false
    api.getItem.mockResolvedValue(ok(detail()))
    renderPanel()

    expect(await screen.findByRole('textbox', { name: 'Add a comment' })).toBeDisabled()
    expectWriteGated(screen.getByRole('button', { name: 'Comment' }))
  })
})

describe('GithubItemTabInline', () => {
  const noop = () => {}
  const tab = {
    type: 'github-item' as const,
    id: 'github-item-/repo-origin-15',
    cwd: CWD,
    repo: 'origin' as const,
    kind: 'pr' as const,
    number: 15,
    title: 'Fix the crash'
  }

  function renderTab() {
    return render(
      <GithubItemTabInline
        tab={tab}
        isActive={false}
        isDragging={false}
        isDropTarget={false}
        dropPosition={null}
        bulkMenu={{}}
        onSelect={noop}
        onClose={noop}
        onDragStart={noop}
        onDragOver={noop}
        onDragLeave={noop}
        onDrop={noop}
      />
    )
  }

  it('shows no state until the detail says it, then the loaded state and title', async () => {
    api.getItem.mockResolvedValue(
      ok(detail({ item: { ...detail().item, title: 'Fix the crash for good', state: 'merged' } }))
    )
    const { container } = renderTab()
    // TabChrome hides its icon slot from the accessibility tree, so read the glyph's own name.
    const stateGlyph = () => container.querySelector('svg[role="img"]')?.getAttribute('aria-label')
    expect(stateGlyph()).toBeUndefined()
    expect(screen.getByText('#15 Fix the crash')).toBeInTheDocument()

    await act(async () => {
      await useGithubStore.getState().loadItem({ cwd: CWD, repo: 'origin', kind: 'pr', number: 15 })
    })
    expect(stateGlyph()).toBe('Merged pull request')
    expect(screen.getByText('#15 Fix the crash for good')).toBeInTheDocument()
  })
})
