import { PersistenceKeys } from '@shared/types/persistence.types'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { editorStateKey } from '@/hooks/editor-persistence/types'
import { useProjectStore } from '@/stores/project-store'
import {
  useDeleteProjectWithCascade,
  usePersistProjectsImmediate,
  useProjectsLoader
} from './use-projects-persistence'

const REDACTED_VALUE = '[REDACTED]'

const {
  mockPersistenceRead,
  mockPersistenceWrite,
  mockPersistenceDelete,
  mockSecureStorageGet,
  mockSecureStorageSet
} = vi.hoisted(() => ({
  mockPersistenceRead: vi.fn(),
  mockPersistenceWrite: vi.fn(),
  mockPersistenceDelete: vi.fn(),
  mockSecureStorageGet: vi.fn(),
  mockSecureStorageSet: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockPersistenceRead,
    write: mockPersistenceWrite,
    writeDebounced: vi.fn(),
    delete: mockPersistenceDelete
  },
  secureStorageApi: {
    getSecret: mockSecureStorageGet,
    setSecret: mockSecureStorageSet,
    deleteSecret: vi.fn()
  }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

describe('use-projects-persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPersistenceRead.mockResolvedValue({ success: false })
    mockPersistenceWrite.mockResolvedValue({ success: true, data: undefined })
    mockPersistenceDelete.mockResolvedValue({ success: true, data: undefined })
    mockSecureStorageGet.mockResolvedValue({ success: false, code: 'KEY_NOT_FOUND' })
    mockSecureStorageSet.mockResolvedValue({ success: true, data: undefined })

    useProjectStore.setState({
      projects: [],
      activeProjectId: '',
      isLoaded: false
    })
  })

  it('stores secret env vars in secure storage and persists redacted placeholders', async () => {
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

    const { result } = renderHook(() => usePersistProjectsImmediate())
    await result.current()

    expect(mockSecureStorageSet).toHaveBeenCalledWith(
      'project:project-1:env:API_TOKEN',
      'super-secret-token'
    )
    expect(mockPersistenceWrite).toHaveBeenCalledWith(
      PersistenceKeys.projects,
      expect.objectContaining({
        projects: [
          expect.objectContaining({
            envVars: [
              { key: 'PUBLIC_URL', value: 'https://example.com', isSecret: undefined },
              { key: 'API_TOKEN', value: REDACTED_VALUE, isSecret: true }
            ]
          })
        ]
      })
    )
  })

  it('hydrates redacted secret env vars from secure storage during load', async () => {
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
              { key: 'API_TOKEN', value: REDACTED_VALUE, isSecret: true }
            ]
          }
        ],
        activeProjectId: 'project-1',
        updatedAt: '2026-05-25T00:00:00.000Z'
      }
    })
    mockSecureStorageGet.mockResolvedValue({
      success: true,
      data: 'restored-from-secure-storage'
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
          { key: 'API_TOKEN', value: 'restored-from-secure-storage', isSecret: true }
        ]
      })
    ])
  })

  it('deleting a project also deletes its terminal layout, snapshots and workspace record', async () => {
    useProjectStore.setState({
      projects: [{ id: 'project-1', name: 'Doomed', color: 'blue', gitBranch: 'main' }],
      activeProjectId: 'project-1',
      isLoaded: true
    })

    const { result } = renderHook(() => useDeleteProjectWithCascade())
    await result.current('project-1')

    const deleted = mockPersistenceDelete.mock.calls.map(([key]) => key).sort()
    expect(deleted).toEqual(
      [
        PersistenceKeys.terminals('project-1'),
        PersistenceKeys.snapshots('project-1'),
        editorStateKey('project-1')
      ].sort()
    )
    expect(useProjectStore.getState().projects).toEqual([])
  })
})
