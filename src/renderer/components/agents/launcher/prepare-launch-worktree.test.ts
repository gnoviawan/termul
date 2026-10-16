import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Worktree } from '@/types/project'
import { persistedIsolationMode, prepareLaunchWorktree } from './prepare-launch-worktree'

const mocks = vi.hoisted(() => ({ create: vi.fn(), reconcile: vi.fn() }))

vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: {
    create: mocks.create,
    copyIncludeFiles: vi.fn()
  }
}))
vi.mock('@/lib/worktree-reconciler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/worktree-reconciler')>()),
  reconcileProjectWorktrees: mocks.reconcile
}))

const worktree = (id: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  name: id,
  branch: `feat/${id}`,
  path: `/work/.termul/worktrees/${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra
})

const initialProjects = useProjectStore.getState().projects
const setPick = vi.fn()

describe('prepareLaunchWorktree: existing', () => {
  beforeEach(() => {
    mocks.create.mockReset()
    mocks.reconcile.mockReset()
    setPick.mockReset()
    useShellLayoutStore.setState({ setWorktreePick: setPick })
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'P',
          color: 'blue',
          path: '/work',
          isGitRepo: true,
          worktrees: [worktree('a'), worktree('ext', { outsideProjectRoot: true })]
        }
      ]
    } as never)
  })
  afterEach(() => {
    useProjectStore.setState({ projects: initialProjects })
  })

  const input = (existingWorktreeId: string | null, canUseWorktree = false) => ({
    isolationMode: 'existing' as const,
    canUseWorktree,
    baseBranch: null,
    projectRoot: '/work',
    projectId: 'p1',
    existingWorktreeId
  })

  it('returns the listed worktree as the launch cwd with no network, reconcile or pick write', async () => {
    await expect(prepareLaunchWorktree(input('a'))).resolves.toEqual({
      launchCwd: '/work/.termul/worktrees/a',
      worktreePath: '/work/.termul/worktrees/a',
      worktreeBranch: 'feat/a'
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(setPick).not.toHaveBeenCalled()
  })

  it('does not need canUseWorktree (a read-only server may still launch)', async () => {
    await expect(prepareLaunchWorktree(input('a', false))).resolves.toMatchObject({
      worktreePath: '/work/.termul/worktrees/a'
    })
  })

  it.each([
    ['an id that is not listed', 'missing'],
    ['an outside-root worktree', 'ext'],
    ['no selection', null]
  ])('throws for %s', async (_name, id) => {
    await expect(prepareLaunchWorktree(input(id))).rejects.toThrow(
      'That worktree is no longer available.'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('prepareLaunchWorktree: collision retry', () => {
  beforeEach(() => {
    mocks.create.mockReset()
    mocks.reconcile.mockReset()
  })

  it.each([
    'WORKTREE_EXISTS',
    'BRANCH_EXISTS',
    'BRANCH_ALREADY_HAS_WORKTREE'
  ])('retries once with a -2 suffix on %s', async (code) => {
    mocks.create
      .mockResolvedValueOnce({ success: false, error: 'collision', code })
      .mockImplementationOnce(async ({ name, branch }: { name: string; branch: string }) => ({
        success: true,
        data: { name, branch, path: `/work/.termul/worktrees/${name}`, headCommit: '' }
      }))
    const result = await prepareLaunchWorktree({
      isolationMode: 'worktree',
      canUseWorktree: true,
      baseBranch: 'main',
      projectRoot: '/work',
      projectId: 'p1'
    })
    const [first, retry] = mocks.create.mock.calls.map(([arg]) => arg as { branch: string })
    expect(retry.branch).toBe(`${first.branch}-2`)
    expect(result.worktreeBranch).toBe(`${first.branch}-2`)
  })
})

describe('persistedIsolationMode', () => {
  it('persists an existing-worktree launch as the current checkout', () => {
    expect(persistedIsolationMode('existing')).toBe('current')
    expect(persistedIsolationMode('current')).toBe('current')
    expect(persistedIsolationMode('worktree')).toBe('worktree')
  })
})
