import type { ProjectListPayload } from '@shared/types/web-projects.types'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { useProjectsLoader } from '../use-projects-persistence'

const { mockList, mockOnEvent, mockPersistenceRead } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockOnEvent: vi.fn(),
  mockPersistenceRead: vi.fn()
}))

// Web/remote mode: the loader must hit `GET /projects` (the in-memory registry
// mirror), NOT the stubbed plugin-store (which returns nothing in a browser).
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => false }))
vi.mock('@/lib/web-server-api', () => ({ webServerProjects: { list: mockList } }))
vi.mock('@/lib/acp-transport', () => ({
  // The loader registers a `projects_changed` listener via the transport.
  getAcpTransport: () => ({ onEvent: mockOnEvent })
}))
vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockPersistenceRead,
    write: vi.fn(),
    writeDebounced: vi.fn(),
    delete: vi.fn()
  },
  secureStorageApi: { getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() },
  syncProjects: vi.fn(),
  terminalApi: {},
  worktreeApi: {}
}))

const payload: ProjectListPayload = {
  projects: [
    { id: 'p1', name: 'Alpha', color: 'blue', path: '/a', isArchived: false, isDefault: true },
    { id: 'p2', name: 'Beta', color: 'gray', path: null, isArchived: true, isDefault: false }
  ],
  defaultProjectId: 'p1'
}

describe('useProjectsLoader (web/remote mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The plugin-store stub must NEVER be read in web mode.
    mockPersistenceRead.mockResolvedValue({ success: false })
    useProjectStore.setState({
      projects: [],
      groups: [],
      activeProjectId: '',
      isLoaded: false,
      isWorktreeOperationLocked: false
    })
    mockOnEvent.mockReturnValue(() => {})
  })

  it('mirrors the project list from GET /projects instead of the stubbed store', async () => {
    mockList.mockResolvedValue({ success: true, data: payload })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().projects).toHaveLength(2)
    })
    expect(mockPersistenceRead).not.toHaveBeenCalled()
    // Epic 7: the initial load seeds activeProjectId from the host default.
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
    expect(useProjectStore.getState().projects[1].isArchived).toBe(true)
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

  it('refetches /projects on projects_changed but PRESERVES activeProjectId (no silent retarget)', async () => {
    // Initial load seeds activeProjectId = p1 (the host default).
    mockList
      .mockResolvedValueOnce({ success: true, data: payload })
      // A subsequent projects_changed carries a DIFFERENT defaultProjectId
      // (e.g. the desktop switched). The client must NOT adopt it as its
      // active selection — only the list + isDefault flags refresh.
      // The host sets isDefault on the matching project (p2).
      .mockResolvedValueOnce({
        success: true,
        data: {
          projects: [
            { ...payload.projects[0]!, isDefault: false },
            { ...payload.projects[1]!, isDefault: true }
          ],
          defaultProjectId: 'p2'
        }
      })

    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
    })

    // The loader registered a `projects_changed` listener; firing it refetches.
    const listener = mockOnEvent.mock.calls[0]?.[1] as (() => void) | undefined
    expect(typeof listener).toBe('function')
    listener?.()

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
    // Epic 7: the client's own activeProjectId is PRESERVED (not retargeted
    // to the host's new defaultProjectId 'p2').
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
    // P16: the isDefault flags DO refresh from the new host default — the
    // project matching the new defaultProjectId has isDefault === true.
    const projects = useProjectStore.getState().projects
    expect(projects.find((p) => p.id === 'p2')?.isDefault).toBe(true)
    expect(projects.find((p) => p.id === 'p1')?.isDefault).toBe(false)
  })

  it('falls back to defaultProjectId when the current project is deleted by the host', async () => {
    // Initial load: client is on p1 (the default).
    mockList.mockResolvedValueOnce({ success: true, data: payload })
    // Subsequent refetch: p1 was deleted; the host default is now p2.
    mockList.mockResolvedValueOnce({
      success: true,
      data: {
        projects: [{ ...payload.projects[1]!, isArchived: false, isDefault: true }],
        defaultProjectId: 'p2'
      }
    })

    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
    })

    const listener = mockOnEvent.mock.calls[0]?.[1] as (() => void) | undefined
    listener?.()

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
    // The client's activeProjectId (p1) is no longer in the list → fall back
    // to the host default (p2).
    expect(useProjectStore.getState().activeProjectId).toBe('p2')
  })
})
