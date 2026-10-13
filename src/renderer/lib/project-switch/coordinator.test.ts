import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import { logFrontendError } from '@/lib/log-api'
import { createProjectSwitchCoordinator } from './coordinator'
import { emptyStagedProject, type StagedProject, type SwitchDeps, type SwitchStatus } from './types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function staged(tag: string): StagedProject {
  return { ...emptyStagedProject(), activeFilePath: tag }
}

/** Fake world: `intent` is the project store, `committed` the workspace store. */
function createWorld(initialCommitted = 'C') {
  const world = {
    committed: initialCommitted,
    intent: initialCommitted,
    focusedPane: 'pane-1',
    trees: new Set<string>(initialCommitted ? [initialCommitted] : []),
    projects: ['C', 'A', 'B', 'L'],
    hydrates: new Map<string, Deferred<StagedProject>>(),
    leaves: [] as Array<{ from: string; gate: Deferred<void> | null }>,
    leaveGate: null as Deferred<void> | null,
    commits: [] as Array<{ projectId: string; staged: StagedProject }>,
    reverts: [] as string[],
    statuses: [] as SwitchStatus[]
  }

  const deps: SwitchDeps = {
    getCommittedProjectId: () => world.committed,
    getActiveProjectId: () => world.intent,
    getFocusedPaneId: () => world.focusedPane,
    hasTree: (projectId) => world.trees.has(projectId),
    leave: vi.fn(async (from: string) => {
      world.leaves.push({ from, gate: world.leaveGate })
      await world.leaveGate?.promise
    }),
    hydrate: vi.fn((projectId: string) => {
      const pending = deferred<StagedProject>()
      world.hydrates.set(projectId, pending)
      return pending.promise
    }),
    hydrateEditor: vi.fn(async (projectId: string) => ({
      ...staged(`editor:${projectId}`),
      tree: null
    })),
    commit: vi.fn((projectId: string, stagedProject: StagedProject) => {
      world.commits.push({ projectId, staged: stagedProject })
      world.committed = projectId
      world.trees.add(projectId)
    }),
    landingProjectId: () => 'L',
    revertTo: vi.fn((projectId: string) => {
      world.reverts.push(projectId)
      world.intent = projectId
    }),
    setStatus: vi.fn((status: SwitchStatus) => {
      world.statuses.push(status)
    })
  }
  const lastStatus = (): SwitchStatus | undefined => world.statuses.at(-1)
  return { world, deps, lastStatus }
}

/** Let queued microtasks (awaited fakes) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('project switch coordinator', () => {
  it('A then B: A hydrate resolves late and only B commits', async () => {
    const { world, deps, lastStatus } = createWorld()
    const coordinator = createProjectSwitchCoordinator(deps)

    world.intent = 'A'
    const a = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()
    world.intent = 'B'
    const b = coordinator.request({ kind: 'pick', projectId: 'B' })
    await settle()

    world.hydrates.get('B')?.resolve(staged('B'))
    expect(await b).toBe('committed')
    // A's hydration lands only now.
    world.hydrates.get('A')?.resolve(staged('A'))
    expect(await a).toBe('superseded')

    expect(world.commits.map((c) => c.projectId)).toEqual(['B'])
    expect(world.committed).toBe('B')
    expect(lastStatus()).toEqual({ kind: 'idle' })
  })

  it('drops a late completion after the user returned to the committed project', async () => {
    const { world, deps, lastStatus } = createWorld('C')
    const coordinator = createProjectSwitchCoordinator(deps)

    world.intent = 'A'
    const a = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()
    expect(lastStatus()).toEqual({ kind: 'pending', projectId: 'A' })

    // User is back on C before A's hydration lands.
    world.intent = 'C'
    const back = coordinator.request({ kind: 'pick', projectId: 'C' })
    expect(await back).toBe('noop')
    expect(lastStatus()).toEqual({ kind: 'idle' })

    world.hydrates.get('A')?.resolve(staged('A'))
    expect(await a).toBe('superseded')
    expect(world.commits).toEqual([])
    expect(world.committed).toBe('C')
  })

  it('an explicit open supersedes a pending pick, runs afterCommit once, and an effect-style pick coalesces', async () => {
    const { world, deps } = createWorld('C')
    const coordinator = createProjectSwitchCoordinator(deps)
    const afterCommit = vi.fn(() => {
      // Runs on the owner's tree: the commit already happened.
      expect(world.committed).toBe('B')
    })

    world.intent = 'A'
    const pick = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()

    world.intent = 'B'
    const open = coordinator.request({ kind: 'open', projectId: 'B', afterCommit })
    // The workspace hook's effect then re-issues the pick for the same project.
    const effectPick = coordinator.request({ kind: 'pick', projectId: 'B' })
    await settle()

    expect(effectPick).toBe(open)
    expect(deps.hydrate).toHaveBeenCalledTimes(2) // A (superseded) + B, not a third for the duplicate
    world.hydrates.get('B')?.resolve(staged('B'))
    expect(await open).toBe('committed')
    // A's hydration lands late; its request was superseded by the open.
    world.hydrates.get('A')?.resolve(staged('A'))
    expect(await pick).toBe('superseded')
    expect(afterCommit).toHaveBeenCalledTimes(1)
    expect(world.commits.map((c) => c.projectId)).toEqual(['B'])
  })

  it('dispose mid-hydrate: nothing commits and no status stays pending', async () => {
    const { world, deps, lastStatus } = createWorld('C')
    const coordinator = createProjectSwitchCoordinator(deps)

    world.intent = 'A'
    const a = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()
    expect(lastStatus()).toEqual({ kind: 'pending', projectId: 'A' })

    coordinator.dispose()
    expect(lastStatus()).toEqual({ kind: 'idle' })

    world.hydrates.get('A')?.resolve(staged('A'))
    expect(await a).toBe('cancelled')
    expect(world.commits).toEqual([])
    expect(await coordinator.request({ kind: 'pick', projectId: 'B' })).toBe('cancelled')
  })

  it('failure returns to the committed project and never commits a half-built tree', async () => {
    const { world, deps, lastStatus } = createWorld('C')
    const coordinator = createProjectSwitchCoordinator(deps)

    world.intent = 'A'
    const a = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()
    world.hydrates.get('A')?.reject(new Error('disk gone'))

    expect(await a).toBe('failed')
    expect(world.commits).toEqual([])
    expect(world.reverts).toEqual(['C'])
    expect(lastStatus()).toEqual({ kind: 'failed', projectId: 'A', message: 'disk gone' })
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'project-switch' })
    )
  })

  it('first-boot failure commits a fresh tree for the landing project', async () => {
    const { world, deps, lastStatus } = createWorld('')
    const coordinator = createProjectSwitchCoordinator(deps)

    world.intent = 'A'
    const a = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()
    world.hydrates.get('A')?.reject(new Error('boom'))

    expect(await a).toBe('failed')
    expect(deps.leave).not.toHaveBeenCalled()
    expect(world.commits).toHaveLength(1)
    expect(world.commits[0].projectId).toBe('L')
    expect(world.commits[0].staged.tree).not.toBeNull()
    expect(world.commits[0].staged.editorFiles.size).toBe(0)
    expect(world.reverts).toEqual(['L'])
    expect(lastStatus()).toMatchObject({ kind: 'failed', projectId: 'A' })
  })

  it('a superseded request failing is swallowed', async () => {
    const { world, deps, lastStatus } = createWorld('C')
    const coordinator = createProjectSwitchCoordinator(deps)

    world.intent = 'A'
    const a = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()
    world.intent = 'B'
    const b = coordinator.request({ kind: 'pick', projectId: 'B' })
    await settle()

    world.hydrates.get('A')?.reject(new Error('late failure'))
    expect(await a).toBe('superseded')
    expect(world.reverts).toEqual([])
    expect(lastStatus()).toEqual({ kind: 'pending', projectId: 'B' })

    world.hydrates.get('B')?.resolve(staged('B'))
    expect(await b).toBe('committed')
  })

  it('a visited project hydrates only its editor state and never builds a tree', async () => {
    const { world, deps } = createWorld('C')
    world.trees.add('A')
    const coordinator = createProjectSwitchCoordinator(deps)

    world.intent = 'A'
    expect(await coordinator.request({ kind: 'pick', projectId: 'A' })).toBe('committed')

    expect(deps.hydrate).not.toHaveBeenCalled()
    expect(deps.hydrateEditor).toHaveBeenCalledTimes(1)
    expect(world.commits[0].staged.tree).toBeNull()
    expect(deps.leave).toHaveBeenCalledWith('C')
  })

  it('a focused-pane change aborts an open (but not a pick)', async () => {
    const { world, deps } = createWorld('C')
    const coordinator = createProjectSwitchCoordinator(deps)
    const afterCommit = vi.fn()

    world.intent = 'A'
    const open = coordinator.request({ kind: 'open', projectId: 'A', afterCommit })
    await settle()
    world.focusedPane = 'pane-2'
    world.hydrates.get('A')?.resolve(staged('A'))

    expect(await open).toBe('superseded')
    expect(world.commits).toEqual([])
    expect(afterCommit).not.toHaveBeenCalled()

    world.intent = 'B'
    const pick = coordinator.request({ kind: 'pick', projectId: 'B' })
    await settle()
    world.focusedPane = 'pane-3'
    world.hydrates.get('B')?.resolve(staged('B'))
    expect(await pick).toBe('committed')
  })

  it('a pick of the committed project is a noop that supersedes a stale in-flight request', async () => {
    const { world, deps } = createWorld('C')
    const coordinator = createProjectSwitchCoordinator(deps)

    expect(await coordinator.request({ kind: 'pick', projectId: 'C' })).toBe('noop')
    expect(deps.leave).not.toHaveBeenCalled()

    world.intent = 'A'
    const a = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()
    world.intent = 'C'
    expect(await coordinator.request({ kind: 'pick', projectId: 'C' })).toBe('noop')
    world.hydrates.get('A')?.resolve(staged('A'))
    expect(await a).toBe('superseded')
    expect(world.commits).toEqual([])
  })

  it('a request superseded while leaving never reaches hydrate', async () => {
    const { world, deps } = createWorld('C')
    world.leaveGate = deferred<void>()
    const coordinator = createProjectSwitchCoordinator(deps)

    world.intent = 'A'
    const a = coordinator.request({ kind: 'pick', projectId: 'A' })
    await settle()
    world.intent = 'C'
    await coordinator.request({ kind: 'pick', projectId: 'C' })
    world.leaveGate.resolve()

    expect(await a).toBe('superseded')
    expect(deps.hydrate).not.toHaveBeenCalled()
  })
})
