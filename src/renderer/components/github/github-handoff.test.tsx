import type {
  GithubChecksResult,
  GithubItemDetail,
  GithubPullDetail,
  GithubReviewThread
} from '@shared/types/github.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatLaunchRequest } from '@/components/agents/launcher/launch-chat'
import { buildReadOnlyGuard } from '@/lib/github-handoff/read-only-guard'
import { startIssuePrompt } from '@/lib/github-handoff/start'
import { renderHandoffPrompt } from '@/lib/github-handoff/untrusted'
import { useAcpStore } from '@/stores/acp-store'
import {
  _resetGithubChatLinksForTesting,
  readOnlyGuardOfSession,
  useGithubChatLinksStore
} from '@/stores/github-chat-links-store'
import { useGithubStore } from '@/stores/github-store'
import { useProjectStore } from '@/stores/project-store'
import { GithubItemPanel } from './GithubItemPanel'
import { runGithubHandoff } from './github-handoff'

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
const launch = vi.hoisted(() => ({
  requests: [] as ChatLaunchRequest[],
  launchChat: vi.fn(),
  rollbackLaunchPlaceholder: vi.fn()
}))
const seams = vi.hoisted(() => ({
  seedComposerDraft: vi.fn(),
  openAgentChatInOwnProject: vi.fn(),
  resolveBaseBranch: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/github-api', () => ({ githubApi: api }))
vi.mock('@/components/agents/launcher/launch-chat', () => launch)
vi.mock('@/components/chat/use-composer-draft', () => ({
  seedComposerDraft: seams.seedComposerDraft
}))
vi.mock('@/lib/open-agent-chat', () => ({
  openAgentChatInOwnProject: seams.openAgentChatInOwnProject
}))
vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: { resolveBaseBranch: seams.resolveBaseBranch }
}))
vi.mock('@/lib/api', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api')>()),
  persistenceApi: {
    read: vi.fn(async () => ({ success: true, data: null })),
    write: vi.fn(async () => ({ success: true })),
    writeDebounced: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true }))
  }
}))
vi.mock('sonner', () => ({ toast: { error: seams.toastError, success: vi.fn() } }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => true
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
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewThreads: [],
    ...overrides
  }
}

function detail(kind: 'issue' | 'pr', pr: GithubPullDetail | null = null): GithubItemDetail {
  return {
    repo: REPO,
    item: {
      kind,
      number: 15,
      title: 'Crash on start',
      state: 'open',
      author: 'ana',
      labels: [],
      assignees: [],
      commentCount: 0,
      updatedAt: '2026-10-30T10:00:00Z',
      url: `https://github.com/acme/app/${kind === 'pr' ? 'pull' : 'issues'}/15`,
      checks: kind === 'pr' ? 'failure' : null
    },
    body: 'It crashes.',
    createdAt: '2026-10-29T10:00:00Z',
    comments: [],
    pr,
    fetchedAt: '2026-10-31T10:00:00Z'
  }
}

const CHECKS: GithubChecksResult = {
  headSha: 'abc123',
  rollup: 'failure',
  checks: [{ name: 'test', workflow: 'CI', status: 'failure', detailsUrl: null, jobId: 2 }],
  fetchedAt: ''
}

const THREAD: GithubReviewThread = {
  id: 'PRRT_1',
  path: 'src/app.ts',
  line: 4,
  isResolved: false,
  isOutdated: false,
  comments: [
    { id: 'r1', author: 'rev', body: 'Rename this', createdAt: '2026-10-30T10:00:00Z', url: '' }
  ]
}

/**
 * The launch helper boundary: open on placeholder `ph-N`, run `beforeStart`
 * on a new worktree, adopt the real session `chat-N`. A real launch does the
 * same in this order.
 */
function fakeLaunch(request: ChatLaunchRequest) {
  launch.requests.push(request)
  const n = launch.requests.length
  const placeholderId = `ph-${n}`
  const started = (async () => {
    const checkout = request.newWorktree
      ? { launchCwd: `/wt-${n}`, worktreePath: `/wt-${n}`, worktreeBranch: `chat/${n}` }
      : request.checkout
    const turn = await request.beforeStart?.(checkout)
    request.onAdopt?.(placeholderId, `chat-${n}`)
    return { sessionId: `chat-${n}`, turn }
  })()
  return { placeholderId, started: started.then((r) => r.sessionId), turn: started }
}

const itemRef = (kind: 'issue' | 'pr') => ({ cwd: CWD, repo: 'origin' as const, kind, number: 15 })

beforeEach(() => {
  vi.clearAllMocks()
  launch.requests.length = 0
  launch.launchChat.mockImplementation(fakeLaunch)
  seams.resolveBaseBranch.mockResolvedValue(ok({ defaultBase: 'main', isDetached: false }))
  _resetGithubChatLinksForTesting()
  useAcpStore.setState({
    agentConfigs: [{ id: 'claude', name: 'Claude' } as never],
    sessions: {},
    sessionIndex: []
  })
  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'app', color: 'blue', path: CWD, isGitRepo: true }],
    activeProjectId: 'p1'
  })
  useGithubStore.setState({ contexts: {}, lists: {}, items: {}, checks: {}, logs: {}, filters: {} })
})

async function turnOf(index: number) {
  return (launch.launchChat.mock.results[index].value as ReturnType<typeof fakeLaunch>).turn
}

describe('runGithubHandoff', () => {
  it('Start opens a new worktree chat with the issue as an unsent draft', async () => {
    const issue = detail('issue')
    await runGithubHandoff(
      { projectId: 'p1', itemRef: itemRef('issue'), detail: issue },
      {
        action: 'start'
      }
    )

    const [request] = launch.requests
    expect(request.configId).toBe('claude')
    expect(request.newWorktree).toEqual({ projectRoot: CWD, baseBranch: 'main' })
    expect((await turnOf(0)).turn).toEqual({ blocks: null })
    expect(seams.seedComposerDraft).toHaveBeenCalledTimes(1)
    expect(seams.seedComposerDraft).toHaveBeenCalledWith(
      'p1',
      'chat-1',
      renderHandoffPrompt(startIssuePrompt(issue))
    )
    expect(useGithubChatLinksStore.getState().byProject.p1).toMatchObject([
      { sessionId: 'chat-1', action: 'start', itemId: 'github.com/acme/app#15' }
    ])
  })

  it('Ask runs read-only in the current checkout and reopens the same chat', async () => {
    const ctx = { projectId: 'p1', itemRef: itemRef('pr'), detail: detail('pr', pull()) }
    await runGithubHandoff(ctx, { action: 'ask' })
    expect(launch.requests[0].newWorktree).toBeUndefined()
    expect(launch.requests[0].checkout).toEqual({ launchCwd: CWD })
    expect(readOnlyGuardOfSession('p1', 'chat-1')).toBe(
      buildReadOnlyGuard({ repo: REPO, kind: 'pr', number: 15 })
    )

    useAcpStore.setState({ sessionIndex: [{ id: 'chat-1', title: 'Ask' } as never] })
    await runGithubHandoff(ctx, { action: 'ask' })

    expect(launch.launchChat).toHaveBeenCalledTimes(1)
    expect(seams.openAgentChatInOwnProject).toHaveBeenCalledWith('chat-1', 'github.handoff.ask')
  })

  it('Fix CI checks the PR out in the new worktree and sends the failure evidence', async () => {
    api.checkoutPr.mockResolvedValue(
      ok({
        headSha: 'abc123',
        headRefName: 'fix/crash',
        pushCommand: 'git push fork HEAD:fix/crash'
      })
    )
    api.getCheckLog.mockResolvedValue(ok({ jobId: 2, tail: 'Error: boom', truncated: false }))
    await runGithubHandoff(
      { projectId: 'p1', itemRef: itemRef('pr'), detail: detail('pr', pull()) },
      { action: 'fix_ci', checks: CHECKS }
    )

    expect(api.checkoutPr).toHaveBeenCalledWith({ cwd: '/wt-1', repo: 'origin', number: 15 })
    const { turn } = await turnOf(0)
    expect(turn?.worktreeBranch).toBe('fix/crash')
    const text = (turn?.blocks?.[0] as { text: string }).text
    expect(text).toContain('Commit the fix and push it with: git push fork HEAD:fix/crash')
    expect(text).toContain('<<<GITHUB_UNTRUSTED_DATA\nFailed checks on acme/app#15 at abc123:')
    expect(text).toContain('Log tail of "test" (job 2):\nError: boom')
    expect(readOnlyGuardOfSession('p1', 'chat-1')).toBeNull()
  })

  it('rolls the chat back with the reason when a fork blocks pushes', async () => {
    api.checkoutPr.mockResolvedValue({
      success: false,
      code: 'GH_FORK_PUSH_BLOCKED',
      error: 'maintainer edits are off'
    })
    await runGithubHandoff(
      {
        projectId: 'p1',
        itemRef: itemRef('pr'),
        detail: detail('pr', pull({ reviewThreads: [THREAD] }))
      },
      { action: 'resolve_comments', threads: [THREAD] }
    )

    expect(launch.rollbackLaunchPlaceholder).toHaveBeenCalledWith('ph-1')
    expect(seams.toastError).toHaveBeenCalledWith(
      "This fork PR doesn't allow maintainer edits, so an agent can't push to it."
    )
  })
})

describe('GithubHandoffBar', () => {
  function renderPr(pr: GithubPullDetail) {
    api.getItem.mockResolvedValue(ok(detail('pr', pr)))
    api.getChecks.mockResolvedValue(ok(CHECKS))
    return render(<GithubItemPanel cwd={CWD} repo="origin" kind="pr" number={15} isVisible />)
  }

  it('offers Review, Ask, Fix CI and Resolve comments on a failing PR with open threads', async () => {
    renderPr(pull({ reviewThreads: [THREAD] }))
    const bar = await screen.findByRole('toolbar', { name: 'Agent actions' })
    await within(bar).findByRole('button', { name: 'Fix CI' })
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Review', 'Ask', 'Fix CI', 'Resolve comments'])
  })

  it('disables Fix CI and Resolve comments on a fork PR that refuses maintainer edits', async () => {
    renderPr(pull({ isCrossRepository: true, maintainerCanModify: false, reviewThreads: [THREAD] }))
    const bar = await screen.findByRole('toolbar', { name: 'Agent actions' })
    expect(await within(bar).findByRole('button', { name: 'Fix CI' })).toBeDisabled()
    expect(within(bar).getByRole('button', { name: 'Resolve comments' })).toBeDisabled()
    expect(within(bar).getByRole('button', { name: 'Ask' })).toBeEnabled()
    expect(
      screen.getByText("This fork PR doesn't allow maintainer edits, so an agent can't push to it.")
    ).toBeInTheDocument()
  })

  it('hands only the threads left selected in the picker to the agent', async () => {
    const second = { ...THREAD, id: 'PRRT_2', path: 'src/b.ts' }
    api.checkoutPr.mockResolvedValue(
      ok({
        headSha: 'abc123',
        headRefName: 'fix/crash',
        pushCommand: 'git push origin HEAD:fix/crash'
      })
    )
    renderPr(pull({ reviewThreads: [THREAD, second] }))

    fireEvent.click(await screen.findByRole('button', { name: 'Resolve comments' }))
    const dialog = await screen.findByRole('dialog', { name: 'Resolve review comments' })
    fireEvent.click(within(dialog).getByRole('switch', { name: /src\/b\.ts/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hand off 1 thread' }))

    await waitFor(() => expect(launch.launchChat).toHaveBeenCalledTimes(1))
    const text = ((await turnOf(0)).turn?.blocks?.[0] as { text: string }).text
    expect(text).toContain('Thread 1: src/app.ts:4')
    expect(text).not.toContain('src/b.ts')
  })
})
