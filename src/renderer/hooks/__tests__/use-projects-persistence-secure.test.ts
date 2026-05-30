import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import type { PersistedProjectData } from '@shared/types/persistence.types'
import type { Project } from '@/types/project'

const REDACTED_VALUE = '[REDACTED]'

const apiMocks = vi.hoisted(() => ({
  persistenceRead: vi.fn(),
  persistenceWrite: vi.fn(),
  persistenceWriteDebounced: vi.fn(),
  persistenceDelete: vi.fn(),
  secureStorageSet: vi.fn(),
  secureStorageGet: vi.fn(),
  secureStorageDelete: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: apiMocks.persistenceRead,
    write: apiMocks.persistenceWrite,
    writeDebounced: apiMocks.persistenceWriteDebounced,
    delete: apiMocks.persistenceDelete
  },
  secureStorageApi: {
    setSecret: apiMocks.secureStorageSet,
    getSecret: apiMocks.secureStorageGet,
    deleteSecret: apiMocks.secureStorageDelete
  }
}))

import {
  usePersistProjectsImmediate,
  useProjectsAutoSave,
  useProjectsLoader
} from '../use-projects-persistence'

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'test-project',
    name: 'Test Project',
    color: 'blue',
    path: '/test/path',
    gitBranch: 'main',
    ...overrides
  }
}

function getLastPersistedData(mock: ReturnType<typeof vi.fn>): PersistedProjectData {
  const lastCall = mock.mock.calls.at(-1)

  if (!lastCall) {
    throw new Error('Expected persistence API to be called')
  }

  return lastCall[1] as PersistedProjectData
}

describe('use-projects-persistence secure storage integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useProjectStore.setState({
      projects: [],
      activeProjectId: '',
      isLoaded: true
    })

    apiMocks.persistenceRead.mockResolvedValue({ success: false })
    apiMocks.persistenceWrite.mockResolvedValue({ success: true })
    apiMocks.persistenceWriteDebounced.mockResolvedValue({ success: true })
    apiMocks.persistenceDelete.mockResolvedValue({ success: true })
    apiMocks.secureStorageSet.mockResolvedValue({ success: true })
    apiMocks.secureStorageGet.mockResolvedValue({ success: false, code: 'KEY_NOT_FOUND' })
    apiMocks.secureStorageDelete.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips overwriting secure storage when a secret is still redacted in memory', async () => {
    const { unmount } = renderHook(() => useProjectsAutoSave())

    act(() => {
      useProjectStore.setState({ activeProjectId: 'warmup' })
    })

    act(() => {
      useProjectStore.setState({
        projects: [
          buildProject({
            envVars: [{ key: 'API_KEY', value: REDACTED_VALUE, isSecret: true }]
          })
        ],
        activeProjectId: 'test-project'
      })
    })

    await waitFor(() => {
      expect(apiMocks.persistenceWriteDebounced).toHaveBeenCalled()
    })

    expect(apiMocks.secureStorageSet).not.toHaveBeenCalled()
    expect(getLastPersistedData(apiMocks.persistenceWriteDebounced).projects[0].envVars).toEqual([
      { key: 'API_KEY', value: REDACTED_VALUE, isSecret: true }
    ])

    unmount()
  })

  it('aborts the persist instead of writing the raw secret when secure storage write fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    apiMocks.secureStorageSet.mockResolvedValue({
      success: false,
      error: 'Storage failed',
      code: 'STORAGE_ERROR'
    })

    const { unmount } = renderHook(() => useProjectsAutoSave())

    act(() => {
      useProjectStore.setState({ activeProjectId: 'warmup' })
    })

    act(() => {
      useProjectStore.setState({
        projects: [
          buildProject({
            envVars: [{ key: 'API_KEY', value: 'secret-value', isSecret: true }]
          })
        ],
        activeProjectId: 'test-project'
      })
    })

    await waitFor(() => {
      expect(apiMocks.secureStorageSet).toHaveBeenCalledWith(
        'project:test-project:env:API_KEY',
        'secret-value'
      )
    })

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to auto-save projects:',
        expect.any(Error)
      )
    })

    // The keychain write failed, so the persist must be aborted entirely.
    // No plaintext secret (and no misleading [REDACTED] placeholder) is written to disk,
    // and the recoverable value stays in the in-memory store.
    expect(apiMocks.persistenceWriteDebounced).not.toHaveBeenCalled()
    expect(useProjectStore.getState().projects[0].envVars).toEqual([
      { key: 'API_KEY', value: 'secret-value', isSecret: true }
    ])

    unmount()
  })

  it('removes orphaned secret keys when a project env secret is renamed or made non-secret', async () => {
    useProjectStore.setState({
      projects: [
        buildProject({
          envVars: [
            { key: 'OLD_SECRET', value: 'old-secret', isSecret: true },
            { key: 'SHARED_KEY', value: 'keep-secret', isSecret: true }
          ]
        })
      ],
      activeProjectId: 'test-project'
    })

    const { unmount } = renderHook(() => useProjectsAutoSave())

    act(() => {
      useProjectStore.setState({ activeProjectId: 'warmup' })
    })

    act(() => {
      useProjectStore.setState({
        projects: [
          buildProject({
            envVars: [
              { key: 'RENAMED_SECRET', value: 'new-secret', isSecret: true },
              { key: 'SHARED_KEY', value: 'visible-now', isSecret: false }
            ]
          })
        ],
        activeProjectId: 'test-project'
      })
    })

    await waitFor(() => {
      expect(apiMocks.persistenceWriteDebounced).toHaveBeenCalled()
    })

    expect(apiMocks.secureStorageDelete).toHaveBeenCalledWith(
      'project:test-project:env:OLD_SECRET'
    )
    expect(apiMocks.secureStorageDelete).toHaveBeenCalledWith(
      'project:test-project:env:SHARED_KEY'
    )
    expect(apiMocks.secureStorageSet).toHaveBeenCalledWith(
      'project:test-project:env:RENAMED_SECRET',
      'new-secret'
    )

    unmount()
  })

  it('loads redacted secrets back from secure storage', async () => {
    apiMocks.persistenceRead.mockResolvedValue({
      success: true,
      data: {
        projects: [
          {
            id: 'test-project',
            name: 'Test Project',
            color: 'blue',
            envVars: [
              { key: 'PUBLIC_VAR', value: 'public-value', isSecret: false },
              { key: 'API_KEY', value: REDACTED_VALUE, isSecret: true }
            ]
          }
        ],
        activeProjectId: 'test-project',
        updatedAt: new Date().toISOString()
      } satisfies PersistedProjectData
    })
    apiMocks.secureStorageGet.mockResolvedValue({
      success: true,
      data: 'secret-key-123'
    })

    const { unmount } = renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().projects).toHaveLength(1)
    })

    expect(useProjectStore.getState().projects[0].envVars).toEqual([
      { key: 'PUBLIC_VAR', value: 'public-value', isSecret: false },
      { key: 'API_KEY', value: 'secret-key-123', isSecret: true }
    ])

    unmount()
  })

  it('uses the persisted snapshot to clean up orphaned secrets during immediate saves', async () => {
    apiMocks.persistenceRead.mockResolvedValue({
      success: true,
      data: {
        projects: [
          {
            id: 'test-project',
            name: 'Test Project',
            color: 'blue',
            envVars: [{ key: 'API_KEY', value: REDACTED_VALUE, isSecret: true }]
          }
        ],
        activeProjectId: 'test-project',
        updatedAt: new Date().toISOString()
      } satisfies PersistedProjectData
    })

    useProjectStore.setState({
      projects: [
        buildProject({
          envVars: [{ key: 'PUBLIC_ONLY', value: 'visible', isSecret: false }]
        })
      ],
      activeProjectId: 'test-project'
    })

    const { result, unmount } = renderHook(() => usePersistProjectsImmediate())

    await act(async () => {
      await result.current()
    })

    expect(apiMocks.secureStorageDelete).toHaveBeenCalledWith(
      'project:test-project:env:API_KEY'
    )
    expect(apiMocks.persistenceWrite).toHaveBeenCalled()

    unmount()
  })
})
