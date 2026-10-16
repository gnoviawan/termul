import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from '@/lib/uuid'
import { useProjectStore } from '@/stores/project-store'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'
import { prepareLaunchWorktree } from './prepare-launch-worktree'

vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-runtime')>()),
  isTauriContext: () => false
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/uuid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/uuid')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})

const PROJECT_ROOT = '/work'
const createdInfo = (name: string) => ({
  name,
  branch: `chat/${name}`,
  path: `/work/.termul/worktrees/${name}`,
  headCommit: 'abc123'
})

type Route = () => Response
const fetchMock = vi.fn<typeof fetch>()

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function ndjson(frames: unknown[]): Response {
  return new Response(`${frames.map((f) => JSON.stringify(f)).join('\n')}\n`, {
    headers: { 'content-type': 'application/x-ndjson' }
  })
}

function serve(routes: Record<string, Route[]>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const queue = routes[path]
    if (!queue?.length) return json({ success: false, error: 'unrouted', code: 'NOT_FOUND' })
    const route = queue.length > 1 ? queue.shift()! : queue[0]!
    return route()
  })
}

function worktreeCalls(): { path: string; body: unknown }[] {
  return fetchMock.mock.calls
    .map(([input, init]) => ({
      path: new URL(String(input), 'http://localhost').pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }))
    .filter((call) => call.path.startsWith('/worktree/'))
}

const createdResult = (name: string) => () =>
  ndjson([
    { type: 'preparing', progressId: 'prog-1' },
    {
      type: 'progress',
      progressId: 'prog-1',
      line: `Preparing worktree (new branch 'chat/${name}')`
    },
    { type: 'result', result: { success: true, data: createdInfo(name) } }
  ])
const includeCopied = () => json({ success: true, data: { ran: 1, copied: 2, skipped: [] } })
const listing = (name: string) => () => json({ success: true, data: [createdInfo(name)] })

const initialProjects = useProjectStore.getState().projects

describe('prepareLaunchWorktree on the web client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    vi.mocked(randomUUID).mockReturnValueOnce('abcd1234-0000-4000-8000-000000000000')
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'P',
          color: 'blue',
          path: PROJECT_ROOT,
          isGitRepo: true,
          worktrees: []
        }
      ]
    } as never)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    useProjectStore.setState({ projects: initialProjects })
  })

  const launch = () =>
    prepareLaunchWorktree({
      isolationMode: 'worktree',
      canUseWorktree: true,
      baseBranch: 'main',
      projectRoot: PROJECT_ROOT,
      projectId: 'p1',
      progressId: 'prog-1'
    })

  it('creates the worktree over HTTP and launches into the path the host returned', async () => {
    serve({
      '/worktree/create': [createdResult('abcd1234')],
      '/worktree/copy-include-files': [includeCopied],
      '/worktree/list': [listing('abcd1234')]
    })

    await expect(launch()).resolves.toEqual({
      launchCwd: '/work/.termul/worktrees/abcd1234',
      worktreePath: '/work/.termul/worktrees/abcd1234',
      worktreeBranch: 'chat/abcd1234'
    })

    expect(worktreeCalls()).toEqual([
      {
        path: '/worktree/create',
        body: {
          projectPath: '/work',
          name: 'abcd1234',
          branch: 'chat/abcd1234',
          isNewBranch: true,
          startRef: 'main',
          progressId: 'prog-1',
          streamProgress: true
        }
      },
      {
        path: '/worktree/copy-include-files',
        body: { projectPath: '/work', worktreePath: '/work/.termul/worktrees/abcd1234' }
      },
      { path: '/worktree/list', body: { projectPath: '/work' } }
    ])
    expect(invoke).not.toHaveBeenCalled()

    const op = useWorktreeProgressStore.getState().ops['prog-1']
    expect(op?.status).toBe('done')
    expect(op?.lines).toEqual([
      "Preparing worktree (new branch 'chat/abcd1234')",
      'Copying .worktree-include files…'
    ])

    const stored = useProjectStore.getState().projects[0]?.worktrees ?? []
    expect(stored.map((w) => [w.path, w.branch])).toEqual([
      ['/work/.termul/worktrees/abcd1234', 'chat/abcd1234']
    ])
  })

  it('retries once under a -2 name when the host answers WORKTREE_EXISTS', async () => {
    serve({
      '/worktree/create': [
        () =>
          ndjson([
            {
              type: 'result',
              result: { success: false, error: 'already exists', code: 'WORKTREE_EXISTS' }
            }
          ]),
        createdResult('abcd1234-2')
      ],
      '/worktree/copy-include-files': [includeCopied],
      '/worktree/list': [listing('abcd1234-2')]
    })

    await expect(launch()).resolves.toEqual({
      launchCwd: '/work/.termul/worktrees/abcd1234-2',
      worktreePath: '/work/.termul/worktrees/abcd1234-2',
      worktreeBranch: 'chat/abcd1234-2'
    })
    const creates = worktreeCalls()
      .filter((call) => call.path === '/worktree/create')
      .map((call) => call.body as { name: string; branch: string })
    expect(creates.map(({ name, branch }) => [name, branch])).toEqual([
      ['abcd1234', 'chat/abcd1234'],
      ['abcd1234-2', 'chat/abcd1234-2']
    ])
  })

  it('fails the launch with the host error and marks the progress card failed', async () => {
    serve({
      '/worktree/create': [
        () =>
          ndjson([
            {
              type: 'result',
              result: { success: false, error: 'invalid reference: main', code: 'GIT_ERROR' }
            }
          ])
      ]
    })

    await expect(launch()).rejects.toThrow('Worktree creation failed: invalid reference: main')
    expect(worktreeCalls().map((call) => call.path)).toEqual(['/worktree/create'])
    expect(useWorktreeProgressStore.getState().ops['prog-1']).toMatchObject({
      status: 'error',
      error: 'Worktree creation failed: invalid reference: main'
    })
  })
})
