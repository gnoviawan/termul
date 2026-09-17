import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedSnapshot } from '../../shared/types/persistence.types'

const {
  mockTerminalApiSpawn,
  mockTerminalApiKill,
  mockGetSnapshot,
  mockRenameSnapshot,
  mockAddTerminal,
  mockSetTerminalPtyId,
  mockSetTerminalClaim,
  mockCloseTerminal,
  mockSelectTerminal
} = vi.hoisted(() => ({
  mockTerminalApiSpawn: vi.fn(),
  mockTerminalApiKill: vi.fn(),
  mockGetSnapshot: vi.fn(),
  mockRenameSnapshot: vi.fn(),
  mockAddTerminal: vi.fn(),
  mockSetTerminalPtyId: vi.fn(),
  mockSetTerminalClaim: vi.fn(),
  mockCloseTerminal: vi.fn(),
  mockSelectTerminal: vi.fn()
}))

const mockTerminalStoreState = {
  terminals: [] as Array<{ id: string; projectId: string; ptyId?: string }>,
  closeTerminal: mockCloseTerminal,
  addTerminal: mockAddTerminal,
  setTerminalPtyId: mockSetTerminalPtyId,
  setTerminalClaim: mockSetTerminalClaim,
  selectTerminal: mockSelectTerminal
}

const mockProjectState = {
  activeProjectId: 'proj-1',
  projects: [{ id: 'proj-1', name: 'Test', path: '/test', envVars: [] }]
}

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: () => mockTerminalStoreState
  }
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign(
    (selector?: (state: typeof mockProjectState) => unknown) =>
      selector ? selector(mockProjectState) : mockProjectState,
    { getState: () => mockProjectState }
  )
}))

vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotActions: () => ({ getSnapshot: mockGetSnapshot, renameSnapshot: mockRenameSnapshot }),
  useSnapshotLoading: () => false,
  useSnapshots: () => []
}))

vi.mock('@/lib/api', () => ({
  terminalApi: { spawn: mockTerminalApiSpawn, kill: mockTerminalApiKill }
}))

vi.mock('@/lib/env-parser', () => ({
  resolveEnvForSpawn: () => ({ env: {}, hasProjectEnv: false })
}))

import { useRenameSnapshot, useRestoreSnapshot } from './use-snapshots'

const snapshot: PersistedSnapshot = {
  id: 'snap-1',
  projectId: 'proj-1',
  name: 'Snap',
  createdAt: '2026-03-09T00:00:00.000Z',
  terminals: [{ id: 't1', name: 'T1', shell: 'bash', cwd: '/test', scrollback: [] }],
  activeTerminalId: 't1'
}

describe('useRestoreSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTerminalStoreState.terminals = []
    // CAP-3: spawn is the only claim issuance path — the fixture carries it.
    mockTerminalApiSpawn.mockResolvedValue({
      success: true,
      data: { id: 'pty-1', claim: 'lease-claim-snapshot' }
    })
    mockTerminalApiKill.mockResolvedValue({ success: true, data: undefined })
    mockGetSnapshot.mockResolvedValue(snapshot)
    mockAddTerminal.mockReturnValue({ id: 'term-1' })
  })

  it('passes projectId into the spawn payload (web server requires non-empty projectId)', async () => {
    const { result } = renderHook(() => useRestoreSnapshot())
    await result.current('snap-1')

    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' })
    )
    // CAP-3: the issued claim from the snapshot re-spawn lands in the terminal store.
    expect(mockSetTerminalClaim).toHaveBeenCalledWith('pty-1', 'lease-claim-snapshot')
  })
})

describe('useRenameSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRenameSnapshot.mockResolvedValue(undefined)
  })

  it('delegates to the store renameSnapshot action', async () => {
    const { result } = renderHook(() => useRenameSnapshot())
    await result.current('snap-1', 'Fresh Name')

    expect(mockRenameSnapshot).toHaveBeenCalledTimes(1)
    expect(mockRenameSnapshot).toHaveBeenCalledWith('snap-1', 'Fresh Name')
  })

  it('propagates store failures so callers can surface a toast', async () => {
    mockRenameSnapshot.mockRejectedValue(new Error('Failed to persist snapshot rename: Disk full'))

    const { result } = renderHook(() => useRenameSnapshot())
    await expect(result.current('snap-1', 'Doomed')).rejects.toThrow(
      'Failed to persist snapshot rename: Disk full'
    )
  })
})
