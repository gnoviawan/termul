import type { GithubContext, GithubListItem, GithubListResult } from '@shared/types/github.types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GITHUB_FILTER, useGithubStore } from '@/stores/github-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { GithubPanel } from './GithubPanel'

const api = vi.hoisted(() => ({
  getContext: vi.fn(),
  listItems: vi.fn(),
  getItem: vi.fn(),
  getChecks: vi.fn(),
  getCheckLog: vi.fn(),
  merge: vi.fn()
}))
const signIn = vi.hoisted(() => ({ openGithubSignInTerminal: vi.fn() }))

vi.mock('@/lib/github-api', () => ({ githubApi: api }))
vi.mock('@/lib/github-sign-in', () => signIn)

const CWD = '/repo'
const ORIGIN = { host: 'github.com', owner: 'me', name: 'app' }
const UPSTREAM = { host: 'github.com', owner: 'acme', name: 'app' }

const ok = <T,>(data: T) => ({ success: true as const, data })

function connected(
  overrides: Partial<Extract<GithubContext['auth'], { state: 'connected' }>> = {}
) {
  return {
    auth: {
      state: 'connected' as const,
      host: 'github.com',
      account: 'me',
      scopes: ['repo'],
      tokenSource: 'keyring' as const,
      missingScopes: [],
      fixCommands: [],
      ...overrides
    },
    repo: { kind: 'resolved' as const, origin: ORIGIN, upstream: UPSTREAM }
  }
}

const ISSUE: GithubListItem = {
  kind: 'issue',
  number: 12,
  title: 'Crash on start',
  state: 'open',
  author: 'ana',
  labels: [{ name: 'bug', color: 'd73a4a' }],
  assignees: [],
  commentCount: 3,
  updatedAt: '2026-10-30T10:00:00Z',
  url: 'https://github.com/me/app/issues/12',
  checks: null
}
const PR: GithubListItem = {
  ...ISSUE,
  kind: 'pr',
  number: 15,
  title: 'Fix the crash',
  labels: [],
  commentCount: 0,
  checks: 'failure'
}

function list(...items: GithubListItem[]): GithubListResult {
  return { repo: ORIGIN, items, fetchedAt: '2026-10-31T10:00:00Z' }
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <GithubPanel projectId="p1" cwd={CWD} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useGithubStore.setState({ contexts: {}, lists: {}, items: {}, checks: {}, logs: {}, filters: {} })
  useWorkspaceStore.setState({
    root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
    activePaneId: 'pane-1',
    fullscreenPaneId: null
  })
  signIn.openGithubSignInTerminal.mockResolvedValue(true)
})

describe('GithubPanel status states', () => {
  it('shows the install link when gh is missing', async () => {
    api.getContext.mockResolvedValue(
      ok({ auth: { state: 'cli_missing' }, repo: { kind: 'not_github' } })
    )
    renderPanel()

    expect(await screen.findByText('GitHub CLI not installed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /cli\.github\.com/ })).toHaveAttribute(
      'href',
      'https://cli.github.com'
    )
    expect(api.listItems).not.toHaveBeenCalled()
  })

  it('offers sign-in for the project host and runs its login command in a terminal', async () => {
    api.getContext.mockResolvedValue(
      ok({
        auth: {
          state: 'unauthenticated',
          host: 'ghe.acme.com',
          loginCommand: 'gh auth login --hostname ghe.acme.com'
        },
        repo: { kind: 'resolved', origin: { ...ORIGIN, host: 'ghe.acme.com' }, upstream: null }
      })
    )
    renderPanel()

    expect(await screen.findByText('Sign in to ghe.acme.com')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(signIn.openGithubSignInTerminal).toHaveBeenCalledWith(
      'p1',
      CWD,
      'gh auth login --hostname ghe.acme.com'
    )
  })

  it('says so when the project is not on GitHub', async () => {
    api.getContext.mockResolvedValue(ok({ ...connected(), repo: { kind: 'not_github' } }))
    renderPanel()
    expect(await screen.findByText("This project isn't a GitHub repository")).toBeInTheDocument()
  })

  it('shows the copyable fix for a missing scope above the list', async () => {
    api.getContext.mockResolvedValue(
      ok(
        connected({
          missingScopes: ['read:org'],
          fixCommands: ['gh auth refresh -h github.com -s read:org']
        })
      )
    )
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    renderPanel()

    const warning = (await screen.findByText('read:org')).closest<HTMLElement>('[role="status"]')
    if (!warning) throw new Error('expected the warning banner')
    expect(warning).toHaveTextContent('missing the read:org scope')
    expect(
      within(warning).getByText('gh auth refresh -h github.com -s read:org')
    ).toBeInTheDocument()
    expect(
      within(warning).getByRole('button', {
        name: 'Copy gh auth refresh -h github.com -s read:org'
      })
    ).toBeInTheDocument()
  })
})

describe('GithubPanel list', () => {
  beforeEach(() => {
    api.getContext.mockResolvedValue(ok(connected()))
  })

  it('lists open issues and PRs with their number, author and check rollup', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE, PR)))
    renderPanel()

    const issue = await screen.findByRole('button', { name: 'Open issue #12: Crash on start' })
    expect(issue).toHaveTextContent('#12')
    expect(issue).toHaveTextContent('ana')
    expect(issue).toHaveTextContent('bug')
    const pr = screen.getByRole('button', { name: 'Open pull request #15: Fix the crash' })
    expect(within(pr).getByRole('img', { name: 'Checks failed' })).toBeInTheDocument()
    expect(api.listItems).toHaveBeenCalledWith({
      cwd: CWD,
      filter: DEFAULT_GITHUB_FILTER,
      refresh: undefined
    })
  })

  it('narrows the list through the kind and involvement filters', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })

    fireEvent.click(screen.getByRole('button', { name: 'PRs' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, kind: 'pr' },
      refresh: undefined
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review requested' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, kind: 'pr', reviewRequested: true },
      refresh: undefined
    })
    expect(screen.getByRole('button', { name: 'Review requested' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('refreshes past the host cache from the refresh button', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: DEFAULT_GITHUB_FILTER,
      refresh: true
    })
  })

  it('keeps the last list on screen when a refresh hits the rate limit', async () => {
    api.listItems.mockResolvedValueOnce(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })

    api.listItems.mockResolvedValueOnce({
      success: false,
      code: 'GH_RATE_LIMITED',
      error: 'API rate limit exceeded'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(await screen.findByText(/GitHub rate limit reached/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /#12/ })).toBeInTheDocument()
  })

  it('opens the clicked item as a GitHub tab in the active pane', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE, PR)))
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /#15/ }))

    const root = useWorkspaceStore.getState().root
    if (root.type !== 'leaf') throw new Error('expected leaf')
    expect(root.tabs).toEqual([
      {
        type: 'github-item',
        id: 'github-item-/repo-origin-15',
        cwd: CWD,
        repo: 'origin',
        kind: 'pr',
        number: 15,
        title: 'Fix the crash'
      }
    ])
    expect(root.activeTabId).toBe('github-item-/repo-origin-15')
    expect(screen.getByRole('button', { name: /#15/ })).toHaveAttribute('aria-current', 'true')
  })
})
