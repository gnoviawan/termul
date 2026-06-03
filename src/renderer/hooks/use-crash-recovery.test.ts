import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCrashRecovery } from './use-crash-recovery'

const mocks = vi.hoisted(() => ({
  hasSession: vi.fn(),
  restore: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  sessionApi: {
    hasSession: mocks.hasSession,
    restore: mocks.restore,
    save: vi.fn(),
    clear: vi.fn(),
    flush: vi.fn()
  },
  terminalApi: {
    onData: vi.fn(() => vi.fn())
  },
  persistenceApi: {
    read: vi.fn(),
    write: vi.fn(),
    writeDebounced: vi.fn(),
    flushPendingWrites: vi.fn(),
    delete: vi.fn()
  }
}))

const projectState = {
  activeProjectId: '',
  projects: [{ id: 'project-a' }, { id: 'project-b' }]
}

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => projectState),
    setState: vi.fn((next: Partial<typeof projectState>) => Object.assign(projectState, next))
  }
}))

describe('useCrashRecovery', () => {
  beforeEach(() => {
    mocks.hasSession.mockReset()
    mocks.restore.mockReset()
    projectState.activeProjectId = ''
  })

  it('restores the last valid project when a session exists', async () => {
    mocks.hasSession.mockResolvedValue({ success: true, data: true })
    mocks.restore.mockResolvedValue({
      success: true,
      data: {
        timestamp: '2026-01-01T00:00:00.000Z',
        terminals: [],
        workspaces: [{ projectId: 'project-b', activeTerminalId: null, terminals: [] }]
      }
    })

    renderHook(() => useCrashRecovery())

    await waitFor(() => {
      expect(projectState.activeProjectId).toBe('project-b')
    })
  })

  it('does nothing when there is no saved session', async () => {
    mocks.hasSession.mockResolvedValue({ success: true, data: false })
    mocks.restore.mockResolvedValue({ success: true, data: null })

    renderHook(() => useCrashRecovery())

    await waitFor(() => {
      expect(mocks.restore).not.toHaveBeenCalled()
    })
  })
})
