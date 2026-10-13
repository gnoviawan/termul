import type { ProjectListPayload } from '@shared/types/web-projects.types'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { useProjectsAutoSave, useProjectsLoader } from '../use-projects-persistence'

const {
  mockList,
  mockAddProject,
  mockRemoveProject,
  mockUpdateProject,
  mockSubscribe,
  mockPersistenceRead,
  mockPersistenceWrite,
  mockReconcile
} = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockAddProject: vi.fn(),
  mockRemoveProject: vi.fn(),
  mockUpdateProject: vi.fn(),
  mockReconcile: vi.fn(),
  mockSubscribe: vi.fn(),
  mockPersistenceRead: vi.fn(),
  mockPersistenceWrite: vi.fn()
}))

// Web/remote mode: the loader must hit `GET /projects` (the in-memory registry
// mirror), NOT the stubbed plugin-store (which returns nothing in a browser).
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => false }))
// #854: the loader waits for the web auth gate before fetching the mirror.
// These suites exercise the already-authed path — resolve the gate as ok.
vi.mock('@/lib/web-auth-gate', () => ({ useWebAuthGateOk: () => true }))
vi.mock('@/lib/worktree-reconciler', () => ({ reconcileProjectWorktrees: mockReconcile }))
vi.mock('@/lib/web-server-api', () => ({
  webServerProjects: {
    list: mockList,
    addProject: mockAddProject,
    removeProject: mockRemoveProject,
    updateProject: mockUpdateProject
  }
}))
vi.mock('@/lib/acp-transport', () => ({
  // The loader subscribes to the `projects` watch through the transport.
  getAcpTransport: () => ({ watches: { subscribe: mockSubscribe } })
}))
vi.mock('@/lib/api', () => ({
  // Issue #855: the web loader reads + writes the per-client active project
  // through the same `persistenceApi` the desktop path uses.
  persistenceApi: {
    read: mockPersistenceRead,
    write: mockPersistenceWrite
  },
  secureStorageApi: { getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() },
  syncProjects: vi.fn(),
  terminalApi: {},
  worktreeApi: {}
}))

const payload: ProjectListPayload = {
  projects: [
    { id: 'p1', name: 'Alpha', color: 'blue', path: '/a', isArchived: false, isDefault: true },
    { id: 'p2', name: 'Beta', color: 'gray', path: '/b', isArchived: false, isDefault: false }
  ],
  defaultProjectId: 'p1'
}

interface ProjectsWatchHandlers {
  onState: (list: ProjectListPayload) => void
  onDelta: (list: ProjectListPayload) => void
}

/** The handlers the loader registered on the `projects` watch. */
function watchHandlers(): ProjectsWatchHandlers {
  expect(mockSubscribe).toHaveBeenCalledWith('projects', expect.any(Object))
  return mockSubscribe.mock.calls[0]?.[1] as ProjectsWatchHandlers
}

describe('useProjectsLoader (web/remote mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The plugin-store stub must NEVER be read for the projects snapshot in
    // web mode; the activeProject key IS read (issue #855) and defaults to
    // "not found" (a fresh client with no persisted selection).
    mockPersistenceRead.mockImplementation((key: string) =>
      key === 'active-project'
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: false })
    )
    mockPersistenceWrite.mockResolvedValue({ success: true })
    useProjectStore.setState({
      projects: [],
      groups: [],
      activeProjectId: '',
      isLoaded: false,
      isWorktreeOperationLocked: false
    })
    mockSubscribe.mockReturnValue(() => {})
    mockReconcile.mockResolvedValue('unchanged')
  })

  it('mirrors the project list from GET /projects instead of the stubbed store', async () => {
    mockList.mockResolvedValue({ success: true, data: payload })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().projects).toHaveLength(2)
    })
    // The projects snapshot is NEVER read from the plugin-store in web mode.
    // (The activeProject read happens — issue #855 — but with the default
    // failure result it does not change the seeded selection.)
    expect(mockPersistenceRead).toHaveBeenCalledTimes(1)
    expect(mockPersistenceRead).toHaveBeenCalledWith('active-project')
    // Epic 7: the initial load seeds activeProjectId from the host default.
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
    expect(useProjectStore.getState().projects[1].isArchived).toBe(false)
  })

  it('initial load seeds activeProjectId from defaultProjectId (Epic 7)', async () => {
    // Host default is p2; the client has no prior selection.
    mockList.mockResolvedValue({
      success: true,
      data: { ...payload, defaultProjectId: 'p2', projects: payload.projects }
    })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().activeProjectId).toBe('p2')
    })
  })

  it('initial load falls back to the first project when defaultProjectId is null', async () => {
    mockList.mockResolvedValue({
      success: true,
      data: { ...payload, defaultProjectId: null }
    })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
    })
  })

  it('initial load falls back to the first project when defaultProjectId is dangling (P2)', async () => {
    // The host's default references a project that was deleted from the list.
    // The client must NOT seed from a dangling id — fall back to the first
    // project in the list instead.
    mockList.mockResolvedValue({
      success: true,
      data: { ...payload, defaultProjectId: 'p-deleted' }
    })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
    })
  })

  it('applies a projects watch delta but PRESERVES activeProjectId (no silent retarget)', async () => {
    // Initial load seeds activeProjectId = p1 (the host default).
    mockList.mockResolvedValueOnce({ success: true, data: payload })

    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
    })

    // A delta carries a DIFFERENT defaultProjectId (e.g. the desktop switched).
    // The client must NOT adopt it as its active selection — only the list +
    // isDefault flags refresh.
    watchHandlers().onDelta({
      projects: [
        { ...payload.projects[0]!, isDefault: false },
        { ...payload.projects[1]!, isDefault: true }
      ],
      defaultProjectId: 'p2'
    })

    await waitFor(() => {
      expect(useProjectStore.getState().projects.find((p) => p.id === 'p2')?.isDefault).toBe(true)
    })
    // Epic 7: the client's own activeProjectId is PRESERVED (not retargeted
    // to the host's new defaultProjectId 'p2').
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
    expect(useProjectStore.getState().projects.find((p) => p.id === 'p1')?.isDefault).toBe(false)
    // No second HTTP read: the delta IS the new list.
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('does not write a host-sent list back as local add or remove edits', async () => {
    mockList.mockResolvedValueOnce({ success: true, data: payload })
    renderHook(() => {
      useProjectsLoader()
      useProjectsAutoSave()
    })
    await waitFor(() => expect(useProjectStore.getState().projects).toHaveLength(2))

    // The host drops p1 and adds p3: neither is something this client did.
    watchHandlers().onDelta({
      projects: [
        payload.projects[1]!,
        { ...payload.projects[0]!, id: 'p3', name: 'Gamma', isDefault: false }
      ],
      defaultProjectId: 'p2'
    })

    await waitFor(() => {
      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p2', 'p3'])
    })
    expect(mockAddProject).not.toHaveBeenCalled()
    expect(mockRemoveProject).not.toHaveBeenCalled()
    expect(mockUpdateProject).not.toHaveBeenCalled()
  })

  it('rebuilds the list from a watch state (reconnect) without a refetch', async () => {
    mockList.mockResolvedValueOnce({ success: true, data: payload })
    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(useProjectStore.getState().projects).toHaveLength(2))

    // The host lost a project while the socket was down; the fresh state says so.
    watchHandlers().onState({ projects: [payload.projects[1]!], defaultProjectId: 'p2' })

    await waitFor(() => expect(useProjectStore.getState().projects).toHaveLength(1))
    expect(useProjectStore.getState().projects[0]?.id).toBe('p2')
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('drops an HTTP list that resolves after a newer watch list', async () => {
    let resolveHttp: (value: unknown) => void = () => {}
    mockList.mockReturnValueOnce(new Promise((resolve) => (resolveHttp = resolve)))
    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))

    watchHandlers().onState({ projects: [payload.projects[1]!], defaultProjectId: 'p2' })
    await waitFor(() => expect(useProjectStore.getState().projects).toHaveLength(1))
    // The older HTTP answer (two projects) arrives late and must not win.
    resolveHttp({ success: true, data: payload })
    // Let the late answer run to completion before asserting it changed nothing.
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(useProjectStore.getState().projects).toHaveLength(1)
    expect(useProjectStore.getState().projects[0]?.id).toBe('p2')
  })

  it('falls back to defaultProjectId when the current project is deleted by the host', async () => {
    // Initial load: client is on p1 (the default).
    mockList.mockResolvedValueOnce({ success: true, data: payload })

    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
    })

    // p1 was deleted; the host default is now p2.
    watchHandlers().onDelta({
      projects: [{ ...payload.projects[1]!, isArchived: false, isDefault: true }],
      defaultProjectId: 'p2'
    })

    // The client's activeProjectId (p1) is no longer in the list → fall back
    // to the host default (p2).
    await waitFor(() => expect(useProjectStore.getState().activeProjectId).toBe('p2'))
  })

  it('PRESERVES locally resolved isGitRepo across a projects watch delta', async () => {
    // Initial load: mirror carries NO git fields (ProjectSummary is frozen
    // without them), so p1 arrives with isGitRepo undefined.
    mockList.mockResolvedValueOnce({ success: true, data: payload })

    renderHook(() => useProjectsLoader())
    await waitFor(() => {
      expect(
        useProjectStore.getState().projects.find((p) => p.id === 'p1')?.isGitRepo
      ).toBeUndefined()
    })

    // Simulate the local probe flipping p2 to a git repo (the web path this
    // suite exists to guard).
    useProjectStore.getState().updateProject('p2', { isGitRepo: true })
    expect(useProjectStore.getState().projects.find((p) => p.id === 'p2')?.isGitRepo).toBe(true)

    // The next list is identical but carries NO git fields (the real wire
    // shape — ProjectSummary never transports isGitRepo). The flag in the
    // store must survive the setProjects replacement; without the carry-over
    // the launcher's worktree picker would flicker away.
    watchHandlers().onDelta({
      projects: [payload.projects[0]!, { ...payload.projects[1]!, name: 'Beta renamed' }],
      defaultProjectId: 'p1'
    })

    // The renamed project proves the new list was applied before the flags are read.
    await waitFor(() => {
      expect(useProjectStore.getState().projects.find((p) => p.id === 'p2')?.name).toBe(
        'Beta renamed'
      )
    })
    const projects = useProjectStore.getState().projects
    expect(projects.find((p) => p.id === 'p2')?.isGitRepo).toBe(true)
    expect(projects.find((p) => p.id === 'p1')?.isGitRepo).toBeUndefined()
  })

  it('PRESERVES the probed gitBranch across a projects watch delta', async () => {
    mockList.mockResolvedValueOnce({ success: true, data: payload })

    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(useProjectStore.getState().projects).toHaveLength(2))

    useProjectStore.getState().updateProject('p1', { gitBranch: 'main' })

    watchHandlers().onDelta({
      ...payload,
      projects: [{ ...payload.projects[0]!, name: 'Alpha renamed' }, payload.projects[1]!]
    })

    await waitFor(() => {
      const projects = useProjectStore.getState().projects
      expect(projects.find((p) => p.id === 'p1')?.name).toBe('Alpha renamed')
      expect(projects.find((p) => p.id === 'p1')?.gitBranch).toBe('main')
      expect(projects.find((p) => p.id === 'p2')?.gitBranch).toBeUndefined()
    })
  })

  it('reconciles worktrees for every project with a path after the initial load', async () => {
    mockList.mockResolvedValue({
      success: true,
      data: {
        ...payload,
        projects: [...payload.projects, { ...payload.projects[0]!, id: 'p3', path: null }]
      }
    })

    renderHook(() => useProjectsLoader())

    await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(2))
    expect(mockReconcile).toHaveBeenCalledWith('p1')
    expect(mockReconcile).toHaveBeenCalledWith('p2')
  })

  it('PRESERVES worktrees (and carries no activeWorktreeId) across a projects watch delta', async () => {
    mockList.mockResolvedValueOnce({ success: true, data: payload })

    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(useProjectStore.getState().projects).toHaveLength(2))

    const worktrees = [
      { id: 'wt-1', name: 'a', branch: 'a', path: '/a/wt', createdAt: '2026-01-01T00:00:00.000Z' }
    ]
    useProjectStore.getState().updateProject('p1', { worktrees })

    watchHandlers().onDelta({
      ...payload,
      projects: [{ ...payload.projects[0]!, name: 'Alpha renamed' }, payload.projects[1]!]
    })

    await waitFor(() => {
      const p1 = useProjectStore.getState().projects.find((p) => p.id === 'p1')
      expect(p1?.name).toBe('Alpha renamed')
      expect(p1?.worktrees).toEqual(worktrees)
      expect(p1).not.toHaveProperty('activeWorktreeId')
    })
  })

  // ----- Issue #855: active project restored after reload -------------------

  it('initial load restores the client-persisted active project over the host default', async () => {
    // Simulate a reload: the store is fresh (isLoaded: false) but the client
    // previously selected p2 and the server-side store persisted it.
    mockPersistenceRead.mockImplementation((key: string) =>
      key === 'active-project'
        ? Promise.resolve({ success: true, data: 'p2' })
        : Promise.resolve({ success: false })
    )
    mockList.mockResolvedValue({ success: true, data: payload })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().isLoaded).toBe(true)
    })
    // The persisted client selection (p2) wins over the host default (p1) —
    // a reload returns to the project the user switched to.
    expect(useProjectStore.getState().activeProjectId).toBe('p2')
  })

  it('initial load falls back to the host default when the persisted selection is gone', async () => {
    // The persisted selection (p-deleted) references a project no longer in
    // the list — the restore must not seed a dangling id.
    mockPersistenceRead.mockImplementation((key: string) =>
      key === 'active-project'
        ? Promise.resolve({ success: true, data: 'p-deleted' })
        : Promise.resolve({ success: false })
    )
    mockList.mockResolvedValue({ success: true, data: payload })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().isLoaded).toBe(true)
    })
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
  })

  it('persists the active project when the user switches (store subscription)', async () => {
    mockList.mockResolvedValue({ success: true, data: payload })
    renderHook(() => useProjectsLoader())
    await waitFor(() => {
      expect(useProjectStore.getState().isLoaded).toBe(true)
    })
    mockPersistenceWrite.mockClear()

    // The user picks p2 (e.g. via the Projects sheet).
    useProjectStore.getState().selectProject('p2')

    await waitFor(() => {
      expect(mockPersistenceWrite).toHaveBeenCalledWith('active-project', 'p2')
    })
    // The loader's own initial-load write of the seeded selection also flows
    // through the same key — but a switch AFTER the initial seed overwrites
    // it with the new selection (last write wins).
  })

  it('initial load with a failed persistence read falls back to the host default', async () => {
    // Degraded server store (read fails): reload must still work, seeding
    // from the host default as before (issue #855 is best-effort).
    mockPersistenceRead.mockImplementation((key: string) =>
      key === 'active-project'
        ? Promise.resolve({ success: false, error: 'STORE_UNAVAILABLE', code: 'STORE_UNAVAILABLE' })
        : Promise.resolve({ success: false })
    )
    mockList.mockResolvedValue({ success: true, data: payload })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().isLoaded).toBe(true)
    })
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
  })
})
