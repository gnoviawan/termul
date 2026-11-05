import type {
  GithubChecksResult,
  GithubItemDetail,
  GithubPullDetail,
  GithubRepoMeta
} from '@shared/types/github.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  checkoutPr: vi.fn(),
  getRepoMeta: vi.fn(),
  createLabel: vi.fn(),
  editItem: vi.fn(),
  setItemState: vi.fn()
}))
const writes = vi.hoisted(() => ({ admitted: true }))
const shell = vi.hoisted(() => ({ mobile: false }))
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))

vi.mock('@/lib/github-api', () => ({ githubApi: api }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => writes.admitted
}))
vi.mock('@/hooks/use-mobile-web-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-mobile-web-shell')>()),
  useMobileWebShell: () => shell.mobile
}))
vi.mock('sonner', () => ({ toast: toasts }))
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
      {
        id: 'c1',
        author: 'first',
        isBot: false,
        body: 'Looks good',
        createdAt: '2026-10-29T11:00:00Z',
        url: ''
      },
      {
        id: 'c2',
        author: 'second',
        isBot: false,
        body: 'Ship it',
        createdAt: '2026-10-29T12:00:00Z',
        url: ''
      }
    ],
    timeline: [],
    stateReason: null,
    pr: pull(),
    fetchedAt: '2026-10-31T10:00:00Z',
    ...overrides
  }
}

function issue(overrides: Partial<GithubItemDetail> = {}): GithubItemDetail {
  const base = detail()
  return detail({
    item: {
      ...base.item,
      kind: 'issue',
      checks: null,
      url: 'https://github.com/acme/app/issues/15'
    },
    pr: null,
    ...overrides
  })
}

const META: GithubRepoMeta = {
  repo: REPO,
  labels: [
    { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
    { name: 'ai', color: '1d76db', description: null },
    { name: 'enhancement', color: 'a2eeef', description: 'New feature' }
  ],
  assignableUsers: ['ana', 'bo', 'me'],
  viewer: 'me',
  fetchedAt: '2026-10-31T10:00:00Z'
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

/** Switch to a section tab and return its panel's checks region. */
async function openChecks() {
  fireEvent.click(await screen.findByRole('tab', { name: /^Checks/ }))
  return screen.findByRole('region', { name: 'Checks' })
}

beforeEach(() => {
  vi.clearAllMocks()
  writes.admitted = true
  shell.mobile = false
  useGithubStore.setState({
    contexts: {},
    lists: {},
    items: {},
    checks: {},
    logs: {},
    repoMeta: {},
    filters: {}
  })
  api.getChecks.mockResolvedValue(ok(CHECKS))
  api.getRepoMeta.mockResolvedValue(ok(META))
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

    const checks = await openChecks()
    await within(checks).findByText('test')
    // Only what needs a look shows; the passing check folds.
    expect(within(checks).getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(within(checks).getByRole('button', { name: 'Show 1 passed' }))
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

    const checks = await openChecks()
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

    const checks = await openChecks()
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

    const checks = await openChecks()
    fireEvent.click(await within(checks).findByRole('button', { name: 'Show 1 passed' }))
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
          isBot: false,
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

  it('locks the comment text while the post is in flight', async () => {
    api.getItem.mockResolvedValue(ok(detail()))
    const post = deferred<{ success: false; code: string; error: string }>()
    api.comment.mockReturnValue(post.promise)
    renderPanel()

    const box = await screen.findByRole('textbox', { name: 'Add a comment' })
    fireEvent.change(box, { target: { value: 'First thought' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(await screen.findByRole('button', { name: 'Posting…' })).toBeDisabled()
    expect(box).toHaveAttribute('readonly')

    await act(async () => post.resolve({ success: false, code: 'GH_FAILED', error: 'nope' }))
    expect(box).not.toHaveAttribute('readonly')
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
        {
          id: 'r1',
          author: 'rev',
          isBot: false,
          body: 'Rename this',
          createdAt: '2026-10-30T10:00:00Z',
          url: ''
        }
      ]
    }
    api.getItem.mockResolvedValueOnce(ok(detail({ pr: pull({ reviewThreads: [thread] }) })))
    api.getItem.mockReturnValue(new Promise(() => {}))
    api.comment.mockResolvedValue(
      ok({
        comment: {
          id: 'r2',
          author: 'me',
          isBot: false,
          body: 'Renamed',
          createdAt: '2026-10-31T11:00:00Z',
          url: ''
        }
      })
    )
    renderPanel()

    fireEvent.click(await screen.findByRole('tab', { name: /^Threads/ }))
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

describe('GithubItemPanel labels, assignees and state', () => {
  beforeAll(() => {
    // cmdk scrolls the highlighted option into view; jsdom has no layout.
    Element.prototype.scrollIntoView ??= () => {}
  })

  it('applies label changes from the picker and re-reads the item from GitHub', async () => {
    api.getItem.mockResolvedValue(
      ok(detail({ item: { ...detail().item, labels: [{ name: 'bug', color: 'd73a4a' }] } }))
    )
    api.editItem.mockResolvedValue(ok({ number: 15 }))
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit labels' }))
    const picker = await screen.findByRole('dialog')
    fireEvent.click(await within(picker).findByRole('option', { name: /^ai/ }))
    fireEvent.click(within(picker).getByRole('option', { name: /^bug/ }))

    const reread = deferred<ReturnType<typeof ok<GithubItemDetail>>>()
    api.getItem.mockReturnValueOnce(reread.promise)
    fireEvent.click(within(picker).getByRole('button', { name: 'Done · +1 −1 labels' }))

    await waitFor(() =>
      expect(api.editItem).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'pr',
        number: 15,
        addLabels: ['ai'],
        removeLabels: ['bug']
      })
    )
    expect(api.getItem).toHaveBeenLastCalledWith({
      cwd: CWD,
      repo: 'origin',
      kind: 'pr',
      number: 15,
      refresh: true
    })
    expect(within(picker).getByRole('button', { name: 'Saving…' })).toBeDisabled()

    await act(async () => {
      reread.resolve(
        ok(detail({ item: { ...detail().item, labels: [{ name: 'ai', color: '1d76db' }] } }))
      )
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const labels = screen.getByText('Labels', { selector: 'dt' }).closest('div')
    if (!labels) throw new Error('expected the labels row')
    expect(labels).toHaveTextContent('ai')
    expect(labels).not.toHaveTextContent('bug')
  })

  it('removes only the labels the user cleared when a refresh lands while the picker is open', async () => {
    api.getItem.mockResolvedValue(
      ok(detail({ item: { ...detail().item, labels: [{ name: 'bug', color: 'd73a4a' }] } }))
    )
    api.editItem.mockResolvedValue(ok({ number: 15 }))
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit labels' }))
    const picker = await screen.findByRole('dialog')
    fireEvent.click(await within(picker).findByRole('option', { name: /^bug/ }))

    // A poll re-read while the picker is open: someone else added `ai` on GitHub.
    api.getItem.mockResolvedValue(
      ok(
        detail({
          item: {
            ...detail().item,
            labels: [
              { name: 'bug', color: 'd73a4a' },
              { name: 'ai', color: '1d76db' }
            ]
          }
        })
      )
    )
    await act(async () => {
      await useGithubStore
        .getState()
        .loadItem({ cwd: CWD, repo: 'origin', kind: 'pr', number: 15 }, { refresh: true })
    })

    fireEvent.click(within(picker).getByRole('button', { name: /^Done/ }))
    await waitFor(() =>
      expect(api.editItem).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'pr',
        number: 15,
        addLabels: [],
        removeLabels: ['bug']
      })
    )
  })

  it('toasts a refused label edit and keeps the picker and chips as GitHub reports them', async () => {
    api.getItem.mockResolvedValue(
      ok(detail({ item: { ...detail().item, labels: [{ name: 'bug', color: 'd73a4a' }] } }))
    )
    api.editItem.mockResolvedValue({ success: false, code: 'GH_FAILED', error: 'Not allowed' })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit labels' }))
    const picker = await screen.findByRole('dialog')
    fireEvent.click(await within(picker).findByRole('option', { name: /^ai/ }))
    fireEvent.click(within(picker).getByRole('button', { name: 'Done · +1 label' }))

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Couldn't update the labels", {
        description: 'Not allowed'
      })
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    const labels = screen.getByText('Labels', { selector: 'dt' }).closest('div')
    expect(labels).toHaveTextContent('bug')
    expect(labels).not.toHaveTextContent('ai')
  })

  it('closes an issue as not planned from the ⋯ menu', async () => {
    api.getItem.mockResolvedValue(ok(issue()))
    api.setItemState.mockResolvedValue(ok({ number: 15 }))
    renderPanel('issue')

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Issue actions' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close as not planned' }))

    await waitFor(() =>
      expect(api.setItemState).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'issue',
        number: 15,
        action: { kind: 'close', reason: 'not_planned' }
      })
    )
    await waitFor(() =>
      expect(api.getItem).toHaveBeenLastCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'issue',
        number: 15,
        refresh: true
      })
    )
  })

  it('gates the menu writes and the label editor on a read-only server', async () => {
    writes.admitted = false
    api.getItem.mockResolvedValue(ok(issue()))
    renderPanel('issue')

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Issue actions' }), {
      button: 0,
      ctrlKey: false
    })
    expectWriteGated(await screen.findByRole('menuitem', { name: /^Close issue/ }))
    expectWriteGated(screen.getByRole('menuitem', { name: /^Assign to me/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit labels' }))

    const picker = await screen.findByRole('dialog')
    await within(picker).findByRole('option', { name: /^bug/ })
    expectWriteGated(within(picker).getByRole('button', { name: 'Done' }))
    expect(api.editItem).not.toHaveBeenCalled()
  })

  it('folds a bot comment to one line until Show', async () => {
    api.getItem.mockResolvedValue(
      ok(
        detail({
          comments: [
            {
              id: 'b1',
              author: 'coderabbitai',
              isBot: true,
              body: '<!-- walkthrough -->\n## Walkthrough\nThree files changed',
              createdAt: '2026-10-29T11:00:00Z',
              url: ''
            }
          ]
        })
      )
    )
    renderPanel()

    const bot = await screen.findByRole('article', { name: 'Comment by coderabbitai (bot)' })
    expect(bot).toHaveTextContent('Walkthrough Three files changed')
    expect(within(bot).queryByTestId('markdown')).toBeNull()

    fireEvent.click(within(bot).getByRole('button', { name: 'Show comment by coderabbitai' }))
    expect(within(bot).getByTestId('markdown')).toHaveTextContent('Three files changed')
  })

  it('shows label and state events between comments in time order', async () => {
    api.getItem.mockResolvedValue(
      ok(
        issue({
          timeline: [
            {
              id: 'e1',
              kind: 'labeled',
              actor: 'ana',
              createdAt: '2026-10-29T11:30:00Z',
              label: { name: 'bug', color: 'd73a4a' },
              assignee: null
            }
          ]
        })
      )
    )
    renderPanel('issue')

    const conversation = await screen.findByRole('list', { name: 'Conversation' })
    const entries = within(conversation)
      .getAllByRole('listitem')
      .map((el) => el.textContent)
    expect(entries).toHaveLength(4)
    expect(entries[0]).toContain('Fixes the crash on start.')
    expect(entries[1]).toContain('Looks good')
    expect(entries[2]).toMatch(/^ana\s*added\s*bug/)
    expect(entries[3]).toContain('Ship it')
  })

  it('offers Conversation and Linked chats on an issue', async () => {
    api.getItem.mockResolvedValue(ok(issue()))
    renderPanel('issue')

    const tabs = await screen.findByRole('tablist', { name: 'Sections' })
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['Conversation2', 'Linked chats0'])
    fireEvent.click(within(tabs).getByRole('tab', { name: /Linked chats/ }))
    expect(screen.getByText(/No agent chats started from this issue yet/)).toBeInTheDocument()
  })

  it('edits labels in a bottom sheet on the phone shell', async () => {
    shell.mobile = true
    api.getItem.mockResolvedValue(ok(detail()))
    api.editItem.mockResolvedValue(ok({ number: 15 }))
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit labels' }))
    const sheet = await screen.findByRole('dialog', { name: 'Labels' })
    const ai = await within(sheet).findByRole('button', { name: 'ai' })
    fireEvent.click(ai)
    expect(ai).toHaveAttribute('aria-pressed', 'true')
    expect(within(sheet).getByRole('button', { name: 'Remove ai' })).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done · +1 label' }))

    await waitFor(() =>
      expect(api.editItem).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'pr',
        number: 15,
        addLabels: ['ai'],
        removeLabels: []
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Labels' })).toBeNull())
  })

  it('creates a label from the phone sheet and keeps the selection made before it', async () => {
    shell.mobile = true
    api.getItem.mockResolvedValue(ok(detail()))
    api.createLabel.mockResolvedValue(
      ok({ label: { name: 'prio', color: 'b60205', description: null } })
    )
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit labels' }))
    const sheet = await screen.findByRole('dialog', { name: 'Labels' })
    fireEvent.click(await within(sheet).findByRole('button', { name: 'ai' }))
    fireEvent.change(within(sheet).getByRole('searchbox', { name: 'Find or create a label' }), {
      target: { value: 'prio' }
    })
    api.getRepoMeta.mockResolvedValue(
      ok({
        ...META,
        labels: [...META.labels, { name: 'prio', color: 'b60205', description: null }]
      })
    )
    fireEvent.click(within(sheet).getByRole('button', { name: /Create label “prio”/ }))
    const form = await screen.findByRole('dialog', { name: 'New label' })
    fireEvent.click(within(form).getByRole('button', { name: 'Create label' }))

    await waitFor(() =>
      expect(api.createLabel).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        name: 'prio',
        color: 'b60205',
        description: null
      })
    )
    const list = await screen.findByRole('dialog', { name: 'Labels' })
    expect(await within(list).findByRole('button', { name: 'prio' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(list).getByRole('button', { name: 'ai' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(list).getByRole('button', { name: 'Done · +2 labels' })).toBeEnabled()
  })

  it('reopens the label editor from the ⋯ menu with what GitHub reports, not a cancelled pick', async () => {
    api.getItem.mockResolvedValue(
      ok(detail({ item: { ...detail().item, labels: [{ name: 'bug', color: 'd73a4a' }] } }))
    )
    renderPanel()
    const openFromMenu = async () => {
      fireEvent.pointerDown(await screen.findByRole('button', { name: 'Pull request actions' }), {
        button: 0,
        ctrlKey: false
      })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit labels' }))
      return screen.findByRole('dialog')
    }

    let picker = await openFromMenu()
    fireEvent.click(await within(picker).findByRole('option', { name: /^ai/ }))
    expect(within(picker).getByRole('button', { name: 'Done · +1 label' })).toBeInTheDocument()
    fireEvent.click(within(picker).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    picker = await openFromMenu()
    expect(await within(picker).findByRole('option', { name: /^ai/ })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(within(picker).getByRole('option', { name: /^bug/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(within(picker).getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('sends exactly the added and removed people from the assignee picker', async () => {
    api.getItem.mockResolvedValue(ok(detail()))
    api.editItem.mockResolvedValue(ok({ number: 15 }))
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit assignees' }))
    const picker = await screen.findByRole('dialog')
    fireEvent.click(await within(picker).findByRole('option', { name: /^ana/ }))
    fireEvent.click(within(picker).getByRole('option', { name: /^bo/ }))
    fireEvent.click(within(picker).getByRole('button', { name: 'Done · +1 −1 assignees' }))

    await waitFor(() =>
      expect(api.editItem).toHaveBeenCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'pr',
        number: 15,
        addAssignees: ['ana'],
        removeAssignees: ['bo']
      })
    )
    expect(api.editItem).toHaveBeenCalledTimes(1)
  })

  it('assigns, then unassigns, the signed-in account from the ⋯ menu', async () => {
    api.getItem.mockResolvedValue(ok(issue()))
    api.editItem.mockResolvedValue(ok({ number: 15 }))
    renderPanel('issue')
    const menu = async () =>
      fireEvent.pointerDown(await screen.findByRole('button', { name: 'Issue actions' }), {
        button: 0,
        ctrlKey: false
      })

    await menu()
    api.getItem.mockResolvedValue(ok(issue({ item: { ...issue().item, assignees: ['bo', 'me'] } })))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Assign to me' }))
    await waitFor(() =>
      expect(api.editItem).toHaveBeenLastCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'issue',
        number: 15,
        addAssignees: ['me']
      })
    )

    await waitFor(() => expect(screen.getByText('me', { selector: 'dd span' })).toBeInTheDocument())
    await menu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unassign me' }))
    await waitFor(() =>
      expect(api.editItem).toHaveBeenLastCalledWith({
        cwd: CWD,
        repo: 'origin',
        kind: 'issue',
        number: 15,
        removeAssignees: ['me']
      })
    )
  })

  it('offers no self-assignment where the account cannot be assigned, but keeps Unassign me', async () => {
    api.getRepoMeta.mockResolvedValue(ok({ ...META, assignableUsers: ['ana', 'bo'] }))
    api.getItem.mockResolvedValue(ok(issue({ item: { ...issue().item, assignees: [] } })))
    const { unmount } = renderPanel('issue')

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Issue actions' }), {
      button: 0,
      ctrlKey: false
    })
    await screen.findByRole('menuitem', { name: 'Edit assignees' })
    await waitFor(() => expect(api.getRepoMeta).toHaveBeenCalled())
    expect(screen.queryByRole('menuitem', { name: /Assign to me/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Assign yourself' })).toBeNull()
    unmount()

    api.getItem.mockResolvedValue(ok(issue({ item: { ...issue().item, assignees: ['me'] } })))
    renderPanel('issue')
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Issue actions' }), {
      button: 0,
      ctrlKey: false
    })
    expect(await screen.findByRole('menuitem', { name: 'Unassign me' })).toBeInTheDocument()
  })

  it('shows a merge as "merged this" without the close GitHub records right after it', async () => {
    api.getItem.mockResolvedValue(
      ok(
        detail({
          comments: [],
          item: { ...detail().item, state: 'merged' },
          timeline: [
            {
              id: 'm1',
              kind: 'merged',
              actor: 'ana',
              createdAt: '2026-10-30T10:00:00Z',
              label: null,
              assignee: null
            },
            {
              id: 'c1',
              kind: 'closed',
              actor: 'ana',
              createdAt: '2026-10-30T10:00:01Z',
              label: null,
              assignee: null
            }
          ]
        })
      )
    )
    renderPanel()

    const conversation = await screen.findByRole('list', { name: 'Conversation' })
    const entries = within(conversation).getAllByRole('listitem')
    expect(entries).toHaveLength(2)
    expect(entries[1]).toHaveTextContent(/ana\s*merged this/)
    expect(conversation).not.toHaveTextContent('closed this')
  })

  it('says a closed issue was closed as not planned', async () => {
    api.getItem.mockResolvedValue(
      ok(issue({ item: { ...issue().item, state: 'closed' }, stateReason: 'not_planned' }))
    )
    renderPanel('issue')
    expect(await screen.findByText('Closed as not planned')).toBeInTheDocument()
  })

  it('keeps running and cancelled checks in view and counts the failure on the tab', async () => {
    api.getItem.mockResolvedValue(ok(detail()))
    api.getChecks.mockResolvedValue(
      ok({
        ...CHECKS,
        checks: [
          { name: 'lint', workflow: 'CI', status: 'success', detailsUrl: null, jobId: 1 },
          { name: 'test', workflow: 'CI', status: 'failure', detailsUrl: null, jobId: 2 },
          { name: 'e2e', workflow: 'CI', status: 'pending', detailsUrl: null, jobId: 3 },
          { name: 'deploy', workflow: 'CI', status: 'cancelled', detailsUrl: null, jobId: 4 },
          { name: 'docs', workflow: 'CI', status: 'skipped', detailsUrl: null, jobId: 5 }
        ]
      })
    )
    renderPanel()

    expect(await screen.findByRole('tab', { name: 'Checks1 failed' })).toBeInTheDocument()
    const checks = await openChecks()
    await within(checks).findByText('test')
    expect(
      within(checks)
        .getAllByRole('listitem')
        .map((row) => row.textContent?.replace('CI', ''))
    ).toEqual(['testLog', 'e2e', 'deploy'])
    expect(
      within(checks).getByRole('button', { name: 'Show 2 passed and skipped' })
    ).toBeInTheDocument()
  })

  it('pins the comment box on the phone shell and drops it off the Conversation tab', async () => {
    shell.mobile = true
    api.getItem.mockResolvedValue(ok(detail()))
    renderPanel()

    const box = await screen.findByRole('textbox', { name: 'Add a comment' })
    expect(box).toHaveAttribute('rows', '1')
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: /^Checks/ }))
    expect(screen.queryByRole('textbox', { name: 'Add a comment' })).toBeNull()
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
