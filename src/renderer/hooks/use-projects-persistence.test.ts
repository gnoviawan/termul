import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useProjectStore } from '@/stores/project-store'
import { PersistenceKeys } from '@shared/types/persistence.types'
import {
  usePersistProjectsImmediate,
  useProjectsLoader
} from './use-projects-persistence'

const { mockPersistenceRead, mockPersistenceWrite } = vi.hoisted(() => ({
  mockPersistenceRead: vi.fn(),
  mockPersistenceWrite: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockPersistenceRead,
    write: mockPersistenceWrite,
    writeDebounced: vi.fn(),
    delete: vi.fn()
  }
}))

describe('use-projects-persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProjectStore.setState({
      projects: [],
      activeProjectId: '',
      isLoaded: false
    })
  })

  it('redacts secret env var values before persisting projects', async () => {
    useProjectStore.setState({
      projects: [
        {
          id: 'project-1',
          name: 'Secure Project',
          color: 'blue',
          gitBranch: 'main',
          envVars: [
            { key: 'PUBLIC_URL', value: 'https://example.com' },
            { key: 'API_TOKEN', value: 'super-secret-token', isSecret: true }
          ]
        }
      ],
      activeProjectId: 'project-1',
      isLoaded: true
    })

    mockPersistenceWrite.mockResolvedValue({ success: true, data: undefined })

    const { result } = renderHook(() => usePersistProjectsImmediate())
    await result.current()

    expect(mockPersistenceWrite).toHaveBeenCalledWith(
      PersistenceKeys.projects,
      expect.objectContaining({
        projects: [
          expect.objectContaining({
            envVars: [
              { key: 'PUBLIC_URL', value: 'https://example.com', isSecret: undefined },
              { key: 'API_TOKEN', value: '', isSecret: true }
            ]
          })
        ]
      })
    )
  })

  it('restores secret env vars as blank values after loading persisted projects', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        projects: [
          {
            id: 'project-1',
            name: 'Secure Project',
            color: 'blue',
            gitBranch: 'main',
            envVars: [
              { key: 'PUBLIC_URL', value: 'https://example.com' },
              { key: 'API_TOKEN', value: 'persisted-secret-should-not-survive', isSecret: true }
            ]
          }
        ],
        activeProjectId: 'project-1',
        updatedAt: '2026-05-25T00:00:00.000Z'
      }
    })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().isLoaded).toBe(true)
    })

    expect(useProjectStore.getState().projects).toEqual([
      expect.objectContaining({
        id: 'project-1',
        envVars: [
          { key: 'PUBLIC_URL', value: 'https://example.com', isSecret: undefined },
          { key: 'API_TOKEN', value: '', isSecret: true }
        ]
      })
    ])
  })
})
