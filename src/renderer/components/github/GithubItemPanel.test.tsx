import type {
  GithubChecksResult,
  GithubItemDetail,
  GithubPullDetail
} from '@shared/types/github.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNotWriteGated, expectWriteGated } from '@/lib/test-utils/write-gate'
import { useGithubStore } from '@/stores/github-store'
import { GithubItemPanel } from './GithubItemPanel'

const api = vi.hoisted(() => ({
  getContext: vi.fn(),
  listItems: vi.fn(),
  getItem: vi.fn(),
  getChecks: vi.fn(),
  getCheckLog: vi.fn(),
  merge: vi.fn()
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

function renderPanel(kind: 'issue' | 'pr' = 'pr') {
  return render(<GithubItemPanel cwd={CWD} repo="origin" kind={kind} number={15} isVisible />)
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
})
