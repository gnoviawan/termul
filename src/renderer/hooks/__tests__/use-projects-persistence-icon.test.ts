import type { PersistedProjectData } from '@shared/types/persistence.types'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'

/**
 * spec-project-icon persistence round-trip: `icon` (incl. the renderer's
 * `fetchedAt` staleness clock) must survive dehydrate → projects.json →
 * rehydrate, or every restart would flash monograms until re-resolution.
 */

const apiMocks = vi.hoisted(() => ({
  persistenceRead: vi.fn(),
  persistenceWrite: vi.fn(),
  persistenceWriteDebounced: vi.fn(),
  persistenceDelete: vi.fn(),
  secureStorageSet: vi.fn(),
  secureStorageGet: vi.fn(),
  secureStorageDelete: vi.fn(),
  grantFsScope: vi.fn(),
  worktreeList: vi.fn()
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
  },
  filesystemApi: { grantFsScope: apiMocks.grantFsScope },
  worktreeApi: { list: apiMocks.worktreeList }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

import { useProjectsAutoSave, useProjectsLoader } from '../use-projects-persistence'

const ICON = {
  dataUri: 'data:image/png;base64,QUJD',
  mime: 'image/png',
  source: 'file' as const,
  fetchedAt: 1_700_000_000_000
}

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'test-project',
    name: 'Test Project',
    color: 'blue',
    path: '/test/path',
    ...overrides
  }
}

describe('use-projects-persistence icon round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Autosave writes only once the store reports loaded.
    useProjectStore.setState({ projects: [], activeProjectId: '', isLoaded: true })
    apiMocks.persistenceRead.mockResolvedValue({ success: false })
    apiMocks.persistenceWriteDebounced.mockResolvedValue({ success: true })
    apiMocks.secureStorageGet.mockResolvedValue({ success: false, code: 'KEY_NOT_FOUND' })
    apiMocks.grantFsScope.mockResolvedValue({ success: true })
    apiMocks.worktreeList.mockResolvedValue({ success: false })
  })

  it('dehydrates project.icon into the persisted record', async () => {
    renderHook(() => useProjectsAutoSave())

    act(() => {
      useProjectStore.setState({ activeProjectId: 'warmup' })
    })
    act(() => {
      useProjectStore.setState({
        projects: [buildProject({ icon: ICON })],
        activeProjectId: 'test-project'
      })
    })

    await waitFor(() => {
      expect(apiMocks.persistenceWriteDebounced).toHaveBeenCalled()
    })
    const written = apiMocks.persistenceWriteDebounced.mock.calls.at(
      -1
    )?.[1] as PersistedProjectData
    expect(written.projects[0].icon).toEqual(ICON)
  })

  it('rehydrates project.icon so it renders before re-resolution', async () => {
    apiMocks.persistenceRead.mockResolvedValue({
      success: true,
      data: {
        projects: [
          {
            id: 'test-project',
            name: 'Test Project',
            color: 'blue',
            path: '/test/path',
            icon: ICON
          }
        ],
        activeProjectId: 'test-project',
        updatedAt: new Date().toISOString()
      } satisfies PersistedProjectData
    })

    renderHook(() => useProjectsLoader())

    await waitFor(() => {
      expect(useProjectStore.getState().projects[0]?.icon).toEqual(ICON)
    })
  })
})
