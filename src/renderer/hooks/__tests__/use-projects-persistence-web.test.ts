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
    { id: 'p1', name: 'Alpha', color: 'blue', path: '/a', isArchived: false, isActive: true },
    { id: 'p2', name: 'Beta', color: 'gray', path: null, isArchived: true, isActive: false }
  ],
  activeProjectId: 'p1'
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
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
    expect(useProjectStore.getState().projects[1].isArchived).toBe(true)
  })

  it('refetches /projects when the desktop broadcasts projects_changed', async () => {
    mockList
      .mockResolvedValueOnce({ success: true, data: payload })
      .mockResolvedValueOnce({ success: true, data: { ...payload, activeProjectId: 'p2' } })

    renderHook(() => useProjectsLoader())
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))

    // The loader registered a `projects_changed` listener; firing it refetches.
    const listener = mockOnEvent.mock.calls[0]?.[1] as (() => void) | undefined
    expect(typeof listener).toBe('function')
    listener?.()

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(useProjectStore.getState().activeProjectId).toBe('p2')
    })
  })
})
