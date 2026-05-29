import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionRecovery } from './use-session-recovery'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  restore: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  sessionApi: {
    save: mocks.save,
    restore: mocks.restore,
    clear: vi.fn(),
    flush: vi.fn(),
    hasSession: vi.fn()
  }
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ projects: [], activeProjectId: '' })),
    subscribe: vi.fn((listener: () => void) => {
      return () => void listener
    })
  }
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: vi.fn(() => ({ terminals: [], activeTerminalId: '' })),
    subscribe: vi.fn((listener: () => void) => {
      return () => void listener
    })
  }
}))

describe('useSessionRecovery', () => {
  beforeEach(() => {
    mocks.save.mockReset()
    mocks.restore.mockReset()
    mocks.save.mockResolvedValue({ success: true, data: undefined })
    mocks.restore.mockResolvedValue({ success: false, error: 'No saved session found', code: 'SESSION_NOT_FOUND' })
  })

  it('saves a crash-recovery session immediately on mount', async () => {
    renderHook(() => useSessionRecovery())
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.save).toHaveBeenCalled()
  })
})
