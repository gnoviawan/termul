import type { GithubContext, GithubListItem, GithubListResult } from '@shared/types/github.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GITHUB_FILTER, useGithubStore } from '@/stores/github-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { GithubPanel } from './GithubPanel'

const api = vi.hoisted(() => ({
  getContext: vi.fn(),
  listItems: vi.fn(),
  getItem: vi.fn(),
  getChecks: vi.fn(),
  getCheckLog: vi.fn(),
  merge: vi.fn(),
  getRepoMeta: vi.fn()
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
  useGithubStore.setState({
    contexts: {},
    lists: {},
    items: {},
    checks: {},
    logs: {},
    repoMeta: {},
    filters: {}
  })
  api.getRepoMeta.mockResolvedValue(
    ok({
      repo: ORIGIN,
      labels: [
        { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
        { name: 'ai', color: '1d76db', description: null },
        { name: 'docs', color: '0075ca', description: null }
      ],
      assignableUsers: ['ana', 'me'],
      viewer: 'me',
      fetchedAt: '2026-10-31T10:00:00Z'
    })
  )
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
    expect(screen.getByRole('link', { name: 'Install it from cli.github.com' })).toHaveAttribute(
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
  beforeAll(() => {
    // cmdk scrolls the highlighted option into view; jsdom has no layout.
    Element.prototype.scrollIntoView ??= () => {}
  })

  beforeEach(() => {
    api.getContext.mockResolvedValue(ok(connected()))
  })

  it('lists open issues and PRs with their number, author and check rollup', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE, PR)))
    renderPanel()

    const issue = await screen.findByRole('button', {
      name: 'Open issue #12: Crash on start, 3 comments, labels bug'
    })
    expect(issue).toHaveTextContent('#12')
    expect(issue).toHaveTextContent('ana')
    expect(issue).toHaveTextContent('bug')
    const pr = screen.getByRole('button', {
      name: 'Open pull request #15: Fix the crash, checks failed'
    })
    expect(within(pr).getByRole('img', { name: 'Checks failed' })).toBeInTheDocument()
    expect(api.listItems).toHaveBeenCalledWith({
      cwd: CWD,
      filter: DEFAULT_GITHUB_FILTER,
      refresh: undefined
    })
  })

  it('narrows the list through the kind and assignee filters', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })

    fireEvent.click(screen.getByRole('button', { name: 'PRs' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, kind: 'pr' },
      refresh: undefined
    })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Assignee: Anyone' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Review requested' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, kind: 'pr', reviewRequested: true },
      refresh: undefined
    })
    expect(screen.getByRole('button', { name: 'Assignee: Review requested' })).toBeInTheDocument()

    // Review requests are PR-only: Issues drops the filter.
    fireEvent.click(screen.getByRole('button', { name: 'Issues' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, kind: 'issue' },
      refresh: undefined
    })
  })

  it('searches the typed text once after a pause, and once on Enter', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })
    vi.useFakeTimers()
    try {
      const searches = () =>
        api.listItems.mock.calls.filter(([request]) => request.filter.search !== '').length
      const search = screen.getByRole('searchbox', { name: 'Search issues and pull requests' })

      fireEvent.change(search, { target: { value: 'reopen' } })
      act(() => vi.advanceTimersByTime(349))
      expect(searches()).toBe(0)
      act(() => vi.advanceTimersByTime(1))
      expect(api.listItems).toHaveBeenLastCalledWith({
        cwd: CWD,
        filter: { ...DEFAULT_GITHUB_FILTER, search: 'reopen' },
        refresh: undefined
      })
      expect(searches()).toBe(1)

      fireEvent.change(search, { target: { value: 'reopen composer' } })
      fireEvent.keyDown(search, { key: 'Enter' })
      expect(api.listItems).toHaveBeenLastCalledWith({
        cwd: CWD,
        filter: { ...DEFAULT_GITHUB_FILTER, search: 'reopen composer' },
        refresh: undefined
      })
      act(() => vi.advanceTimersByTime(1000))
      expect(searches()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("narrows to one person's items from the assignee menu", async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Assignee: Anyone' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Assigned to ana' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, assignee: { kind: 'user', login: 'ana' } },
      refresh: undefined
    })
    expect(screen.getByRole('button', { name: 'Assignee: Assigned to ana' })).toBeInTheDocument()
    // The signed-in account is "Assigned to me", not a second entry.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Assignee: Assigned to ana' }), {
      button: 0,
      ctrlKey: false
    })
    await screen.findByRole('menuitemradio', { name: 'Assigned to ana' })
    expect(screen.queryByRole('menuitemradio', { name: 'Assigned to me' })).toBeInTheDocument()
    expect(screen.queryAllByRole('menuitemradio', { name: /^Assigned to / })).toHaveLength(2)
  })

  it('filters by the labels picked in the label picker and shows them as removable chips', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE, PR)))
    renderPanel()
    await screen.findByRole('button', { name: /#15/ })

    fireEvent.click(screen.getByRole('button', { name: 'Labels' }))
    const picker = await screen.findByRole('dialog')
    fireEvent.click(await within(picker).findByRole('option', { name: /^bug/ }))
    fireEvent.click(within(picker).getByRole('option', { name: /^ai/ }))
    fireEvent.click(within(picker).getByRole('button', { name: 'Match all' }))
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    fireEvent.click(within(picker).getByRole('button', { name: 'Show results · 2 labels' }))

    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, labels: ['bug', 'ai'], labelMode: 'all' },
      refresh: undefined
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('button', { name: /#15/ })).toBeNull())
    expect(screen.getByRole('button', { name: /#12/ })).toBeInTheDocument()
    const active = screen.getByRole('group', { name: 'Active label filters' })
    expect(active).toHaveTextContent('All of')
    expect(screen.getByRole('button', { name: 'Labels: bug, ai' })).toBeInTheDocument()

    fireEvent.click(within(active).getByRole('button', { name: 'Remove bug' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, labels: ['ai'], labelMode: 'all' },
      refresh: undefined
    })
    fireEvent.click(within(active).getByRole('button', { name: 'Clear all' }))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: DEFAULT_GITHUB_FILTER,
      refresh: undefined
    })
    expect(screen.queryByRole('group', { name: 'Active label filters' })).toBeNull()
  })

  it('gives the repository selector and Refresh the 44px touch row height', async () => {
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })

    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveClass('pointer-coarse:h-11')
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveClass('pointer-coarse:size-11')
  })

  it('shows no repository name and puts Refresh at the end of the kind row', async () => {
    api.getContext.mockResolvedValue(
      ok({ ...connected(), repo: { kind: 'resolved', origin: ORIGIN, upstream: null } })
    )
    api.listItems.mockResolvedValue(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })

    expect(screen.queryByText('me/app')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Repository' })).toBeNull()
    const kind = screen.getByRole('group', { name: 'Kind' })
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    expect(kind.parentElement).toBe(refresh.parentElement)
    expect(kind.nextElementSibling).toBe(refresh)
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

  it("reloads after the remote changes and never shows the old repository's items", async () => {
    api.listItems.mockResolvedValueOnce(ok(list(ISSUE)))
    renderPanel()
    await screen.findByRole('button', { name: /#12/ })

    const moved = { ...ORIGIN, name: 'app-renamed' }
    let resolveList: (value: ReturnType<typeof ok<GithubListResult>>) => void = () => {}
    api.listItems.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve
      })
    )
    act(() => {
      useGithubStore.setState({
        contexts: {
          [CWD]: {
            data: { ...connected(), repo: { kind: 'resolved', origin: moved, upstream: null } },
            status: 'idle',
            errorCode: null,
            error: null
          }
        }
      })
    })

    expect(screen.queryByRole('button', { name: /#12/ })).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(api.listItems).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolveList(ok({ ...list(PR), repo: moved }))
    })
    expect(await screen.findByRole('button', { name: /#15/ })).toBeInTheDocument()
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
