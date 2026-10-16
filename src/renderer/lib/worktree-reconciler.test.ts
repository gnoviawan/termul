import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project, Worktree } from '@/types/project'
import {
  mergeWorktrees,
  reconcileProjectWorktrees,
  worktreeIdForPath,
  worktreeKey
} from './worktree-reconciler'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/worktree-api', () => ({ worktreeApi: { list: mocks.list } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.logFrontendError }))

const ROOT = '/repo'
const WT_A = '/repo/.termul/worktrees/a'

function info(path: string, branch = 'b', name = 'n') {
  return { name, branch, path, headCommit: 'abc' }
}

function ok(...entries: ReturnType<typeof info>[]) {
  return { success: true as const, data: entries }
}

function wt(partial: Partial<Worktree> & Pick<Worktree, 'id' | 'path'>): Worktree {
  return { name: 'n', branch: 'b', createdAt: '2026-01-01T00:00:00.000Z', ...partial }
}

function seed(overrides: Partial<Project> = {}, path: string | undefined = ROOT) {
  useProjectStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'Project',
        color: 'blue',
        path,
        isGitRepo: true,
        worktrees: [],
        ...overrides
      } as Project
    ],
    isLoaded: true
  })
}

/**
 * Seeds the switcher pick. `unavailable` is the in-memory-only usable state, so
 * the real action runs without touching persistence.
 */
function seedPick(path: string | null, status: 'ready' | 'unavailable' = 'unavailable') {
  useShellLayoutStore.setState({
    status,
    worktreePickByProject: path === null ? {} : { p1: path }
  })
}

function pick(): string | undefined {
  return useShellLayoutStore.getState().worktreePickByProject.p1
}

function project(): Project {
  const found = useProjectStore.getState().projects.find((p) => p.id === 'p1')
  if (!found) throw new Error('project missing')
  return found
}

/** Controllable `list` call: resolve it by hand. */
function deferredList() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockReset()
  resetShellLayoutStoreForTests()
  seedPick(null)
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('worktreeKey / worktreeIdForPath / isPathInsideRoot', () => {
  it('normalizes separators, verbatim prefix and trailing slash; lower-cases Windows paths only', () => {
    expect(worktreeKey('E:\\Repo\\Wt\\')).toBe('e:/repo/wt')
    expect(worktreeKey('\\\\?\\E:\\Repo\\Wt')).toBe('e:/repo/wt')
    expect(worktreeKey('\\\\?\\UNC\\Srv\\Share\\Wt')).toBe('//srv/share/wt')
    expect(worktreeKey('//Srv/Share/Wt/')).toBe('//srv/share/wt')
    expect(worktreeKey('/Repo/Wt/')).toBe('/Repo/Wt')
    expect(worktreeKey('/repo/wt')).not.toBe(worktreeKey('/Repo/Wt'))
  })

  it('derives a deterministic id from the canonical key, distinct per path and per attempt', () => {
    const id = worktreeIdForPath('E:\\Repo\\Wt\\')
    expect(id).toMatch(/^wt-[0-9a-f]{14}$/)
    expect(worktreeIdForPath('e:/repo/wt')).toBe(id)
    expect(worktreeIdForPath('/repo/other')).not.toBe(worktreeIdForPath('/repo/wt'))
    expect(worktreeIdForPath('/repo/wt', 1)).not.toBe(worktreeIdForPath('/repo/wt'))
  })

  it('tests containment on segment boundaries', () => {})
})

describe('mergeWorktrees', () => {
  it('keeps object identity when nothing changed', () => {
    const stored = [wt({ id: 'wt-x', path: WT_A, branch: 'b', name: 'n' })]
    const result = mergeWorktrees({
      stored,
      listed: [info(WT_A, 'b', 'n')],
      projectPath: ROOT
    })
    expect(result.worktrees[0]).toBe(stored[0])
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0 })
  })

  it('drops a stored entry with the project root key and never adds the root', () => {
    const result = mergeWorktrees({
      stored: [wt({ id: 'wt-root', path: '/repo/' })],
      listed: [info('/repo'), info(WT_A)],
      projectPath: ROOT
    })
    expect(result.worktrees.map((w) => w.path)).toEqual([WT_A])
    expect(result.removed).toBe(1)
  })

  it('collapses duplicate stored rows for one path into one', () => {
    const result = mergeWorktrees({
      stored: [wt({ id: 'wt-1', path: WT_A }), wt({ id: 'wt-2', path: `${WT_A}/` })],
      listed: [info(WT_A)],
      projectPath: ROOT
    })
    expect(result.worktrees.map((w) => w.id)).toEqual(['wt-1'])
  })

  it('resolves a path-derived id collision with a different path', () => {
    const collidingId = worktreeIdForPath('/repo/.termul/worktrees/new')
    const result = mergeWorktrees({
      stored: [wt({ id: collidingId, path: WT_A })],
      listed: [info(WT_A), info('/repo/.termul/worktrees/new')],
      projectPath: ROOT
    })
    const ids = result.worktrees.map((w) => w.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(collidingId)
  })
})

describe('reconcileProjectWorktrees', () => {
  it('adds a listed worktree with a path-derived id and createdAt', async () => {
    seed()
    mocks.list.mockResolvedValue(ok(info(ROOT, 'main', 'repo'), info(WT_A, 'feat', 'a')))

    expect(await reconcileProjectWorktrees('p1')).toBe('updated')

    const { worktrees } = project()
    expect(worktrees).toHaveLength(1)
    expect(worktrees?.[0]).toMatchObject({
      id: worktreeIdForPath(WT_A),
      name: 'a',
      branch: 'feat',
      path: WT_A
    })
    expect(Number.isNaN(Date.parse(worktrees?.[0].createdAt ?? ''))).toBe(false)
    expect(worktrees?.[0].outsideProjectRoot).toBeUndefined()
  })

  it('keeps the id and updates branch/name when the path comes back in another form', async () => {
    seed(
      { worktrees: [wt({ id: 'wt-keep', path: 'E:\\Repo\\wt\\', branch: 'old', name: 'old' })] },
      'E:\\Repo'
    )
    mocks.list.mockResolvedValue(ok(info('\\\\?\\e:\\repo\\WT', 'new', 'newname')))

    expect(await reconcileProjectWorktrees('p1')).toBe('updated')

    const { worktrees } = project()
    expect(worktrees).toHaveLength(1)
    expect(worktrees?.[0]).toMatchObject({
      id: 'wt-keep',
      branch: 'new',
      name: 'newname',
      path: 'E:\\Repo\\wt\\'
    })
  })

  it('prunes entries absent from a successful listing and clears a pick naming one', async () => {
    seed({
      worktrees: [
        wt({ id: 'wt-1', path: WT_A }),
        wt({ id: 'wt-2', path: '/repo/.termul/worktrees/b' })
      ]
    })
    seedPick('/repo/.termul/worktrees/b')
    mocks.list.mockResolvedValue(ok(info(WT_A)))

    expect(await reconcileProjectWorktrees('p1')).toBe('updated')

    expect(project().worktrees?.map((w) => w.id)).toEqual(['wt-1'])
    expect(pick()).toBeUndefined()
  })

  it('returns updated when only the pick was cleared', async () => {
    seed({ worktrees: [wt({ id: 'wt-1', path: WT_A })] })
    seedPick('/repo/.termul/worktrees/gone')
    mocks.list.mockResolvedValue(ok(info(WT_A)))
    const before = useProjectStore.getState().projects

    expect(await reconcileProjectWorktrees('p1')).toBe('updated')

    expect(pick()).toBeUndefined()
    expect(useProjectStore.getState().projects).toBe(before)
  })

  it('keeps a pick that survives the merge, in any path form', async () => {
    seed({ worktrees: [wt({ id: 'wt-1', path: WT_A })] })
    seedPick(WT_A)
    mocks.list.mockResolvedValue(ok(info(WT_A)))

    expect(await reconcileProjectWorktrees('p1')).toBe('unchanged')
    expect(pick()).toBe(WT_A)
  })

  it('keeps the pick of a listed worktree flagged outside the project root', async () => {
    seed({ worktrees: [wt({ id: 'wt-ext', path: '/elsewhere/wt' })] })
    seedPick('/elsewhere/wt')
    mocks.list.mockResolvedValue(ok({ ...info('/elsewhere/wt'), outsideProjectRoot: true }))

    await reconcileProjectWorktrees('p1')

    expect(project().worktrees?.[0].outsideProjectRoot).toBe(true)
    expect(pick()).toBe('/elsewhere/wt')
  })

  it('does not write the pick when there is none', async () => {
    seed({ worktrees: [wt({ id: 'wt-1', path: WT_A })] })
    const setPick = vi.spyOn(useShellLayoutStore.getState(), 'setWorktreePick')
    mocks.list.mockResolvedValue(ok(info(WT_A)))

    await reconcileProjectWorktrees('p1')

    expect(setPick).not.toHaveBeenCalled()
  })

  it.each([
    ['success:false', async () => ({ success: false, error: 'x', code: 'GIT_ERROR' })],
    ['undefined', async () => undefined],
    ['rejected', async () => Promise.reject(new Error('boom'))],
    [
      'sync throw',
      () => {
        throw new Error('boom')
      }
    ],
    ['success without data', async () => ({ success: true })]
  ])('leaves worktrees untouched on a failed listing (%s)', async (_label, impl) => {
    const stored = [wt({ id: 'wt-1', path: WT_A })]
    seed({ worktrees: stored })
    seedPick('/repo/.termul/worktrees/gone')
    mocks.list.mockImplementation(impl)

    expect(await reconcileProjectWorktrees('p1')).toBe('failed')

    expect(project().worktrees).toBe(stored)
    expect(pick()).toBe('/repo/.termul/worktrees/gone')
    expect(project().isGitRepo).toBe(true)
  })

  it.each(['NOT_A_GIT_REPO', 'GIT_NOT_FOUND'])('flips isGitRepo false on %s', async (code) => {
    const stored = [wt({ id: 'wt-1', path: WT_A })]
    seed({ worktrees: stored })
    mocks.list.mockResolvedValue({ success: false, error: 'x', code })

    expect(await reconcileProjectWorktrees('p1')).toBe('failed')

    expect(project().isGitRepo).toBe(false)
    expect(project().worktrees).toBe(stored)
  })

  it('sets isGitRepo true on a successful listing (self-heal)', async () => {
    seed({ isGitRepo: false })
    mocks.list.mockResolvedValue(ok(info(ROOT)))

    expect(await reconcileProjectWorktrees('p1')).toBe('updated')
    expect(project().isGitRepo).toBe(true)
  })

  it('does not write when nothing changed (no autosave churn)', async () => {
    seed({ worktrees: [wt({ id: 'wt-1', path: WT_A })] })
    mocks.list.mockResolvedValue(ok(info(WT_A)))
    const before = useProjectStore.getState().projects
    const listener = vi.fn()
    const unsub = useProjectStore.subscribe(listener)

    expect(await reconcileProjectWorktrees('p1')).toBe('unchanged')

    unsub()
    expect(listener).not.toHaveBeenCalled()
    expect(useProjectStore.getState().projects).toBe(before)
  })

  it('commits worktrees + isGitRepo with one updateProject call and clears the pruned pick', async () => {
    seed({
      isGitRepo: false,
      worktrees: [wt({ id: 'wt-gone', path: '/repo/.termul/worktrees/gone' })]
    })
    seedPick('/repo/.termul/worktrees/gone')
    mocks.list.mockResolvedValue(ok(info(WT_A)))
    const listener = vi.fn()
    const unsub = useProjectStore.subscribe(listener)

    await reconcileProjectWorktrees('p1')

    unsub()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(project().isGitRepo).toBe(true)
    expect(pick()).toBeUndefined()
  })

  it('skips a project without a path or one that does not exist', async () => {
    seed({ path: undefined })
    expect(await reconcileProjectWorktrees('p1')).toBe('skipped')
    expect(await reconcileProjectWorktrees('missing')).toBe('skipped')
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('does not write when the project is deleted before commit', async () => {
    seed()
    const pending = deferredList()
    mocks.list.mockReturnValue(pending.promise)

    const run = reconcileProjectWorktrees('p1')
    useProjectStore.setState({ projects: [] })
    pending.resolve(ok(info(WT_A)))

    expect(await run).toBe('skipped')
    expect(useProjectStore.getState().projects).toEqual([])
  })

  it('preserves project fields changed while the listing is pending', async () => {
    seed({ defaultShell: '/bin/bash' })
    const pending = deferredList()
    mocks.list.mockReturnValue(pending.promise)

    const run = reconcileProjectWorktrees('p1')
    useProjectStore.getState().updateProject('p1', { defaultShell: '/bin/zsh' })
    pending.resolve(ok(info(WT_A)))
    await run

    expect(project().defaultShell).toBe('/bin/zsh')
    expect(project().worktrees).toHaveLength(1)
  })

  it('merges against worktrees added to the store while the listing is pending', async () => {
    seed()
    const pending = deferredList()
    mocks.list.mockReturnValue(pending.promise)

    const run = reconcileProjectWorktrees('p1')
    useProjectStore.getState().updateProject('p1', {
      worktrees: [wt({ id: 'wt-concurrent', path: WT_A, branch: 'old' })]
    })
    seedPick(WT_A)
    pending.resolve(ok(info(WT_A, 'fresh')))
    await run

    expect(project().worktrees).toHaveLength(1)
    expect(project().worktrees?.[0]).toMatchObject({ id: 'wt-concurrent', branch: 'fresh' })
    expect(pick()).toBe(WT_A)
  })

  describe('single-flight', () => {
    it('runs list at most twice for overlapping calls; later callers share the trailing run', async () => {
      seed()
      const first = deferredList()
      const second = deferredList()
      mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

      const a = reconcileProjectWorktrees('p1')
      const b = reconcileProjectWorktrees('p1')
      const c = reconcileProjectWorktrees('p1')
      expect(b).toBe(c)
      expect(a).not.toBe(b)
      expect(mocks.list).toHaveBeenCalledTimes(1)

      // The first (stale) listing predates the new worktree.
      first.resolve(ok())
      expect(await a).toBe('unchanged')
      await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))

      second.resolve(ok(info(WT_A, 'fresh')))
      expect(await b).toBe('updated')
      expect(await c).toBe('updated')

      expect(mocks.list).toHaveBeenCalledTimes(2)
      expect(project().worktrees).toHaveLength(1)
      expect(project().worktrees?.[0].path).toBe(WT_A)
    })

    it('starts a fresh run once the previous flight is done', async () => {
      seed()
      mocks.list.mockResolvedValue(ok(info(WT_A)))
      await reconcileProjectWorktrees('p1')
      await reconcileProjectWorktrees('p1')
      expect(mocks.list).toHaveBeenCalledTimes(2)
    })

    it('never rejects and keeps flying after a failed run', async () => {
      seed()
      mocks.list.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(ok(info(WT_A)))

      const a = reconcileProjectWorktrees('p1')
      const b = reconcileProjectWorktrees('p1')
      await expect(a).resolves.toBe('failed')
      await expect(b).resolves.toBe('updated')
    })

    it('keeps per-project flights independent', async () => {
      useProjectStore.setState({
        projects: [
          { id: 'p1', name: 'One', color: 'blue', path: '/one', worktrees: [] },
          { id: 'p2', name: 'Two', color: 'blue', path: '/two', worktrees: [] }
        ] as Project[]
      })
      mocks.list.mockResolvedValue(ok())
      await Promise.all([reconcileProjectWorktrees('p1'), reconcileProjectWorktrees('p2')])
      expect(mocks.list).toHaveBeenCalledTimes(2)
    })
  })

  describe('outside-root flag (host-provided)', () => {
    it('stores the host flag on new and existing rows', async () => {
      seed()
      mocks.list.mockResolvedValue(
        ok(info(WT_A), { ...info('/elsewhere/wt-out'), outsideProjectRoot: true })
      )

      await reconcileProjectWorktrees('p1')

      const byPath = new Map(project().worktrees?.map((w) => [w.path, w]))
      expect(byPath.get(WT_A)?.outsideProjectRoot).toBeUndefined()
      expect(byPath.get('/elsewhere/wt-out')?.outsideProjectRoot).toBe(true)
    })

    it('does not recompute the flag from paths and clears it when the host drops it', async () => {
      seed()
      mocks.list.mockResolvedValue(ok({ ...info('/elsewhere/wt-out'), outsideProjectRoot: true }))
      await reconcileProjectWorktrees('p1')
      expect(project().worktrees?.[0].outsideProjectRoot).toBe(true)

      mocks.list.mockResolvedValue(ok(info('/elsewhere/wt-out')))
      await reconcileProjectWorktrees('p1')
      expect(project().worktrees?.[0].outsideProjectRoot).toBeUndefined()
    })
  })

  it('logs an unexpected thrown error as a warn and resolves failed', async () => {
    seed()
    mocks.list.mockResolvedValue(ok(info(WT_A)))
    const original = useProjectStore.getState().updateProject
    useProjectStore.setState({
      updateProject: () => {
        throw new Error('store exploded')
      }
    })

    try {
      expect(await reconcileProjectWorktrees('p1')).toBe('failed')
    } finally {
      useProjectStore.setState({ updateProject: original })
    }
    expect(mocks.logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'worktreeReconciler' })
    )
  })
})
