import { act, renderHook } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SSHProfile } from '@shared/types/ssh.types'
import { useSSHConnection } from './use-ssh-connection'
import { useSSHStore } from '@/stores/ssh-store'
import { useTerminalStore } from '@/stores/terminal-store'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  write: vi.fn(),
  kill: vi.fn(),
  connect: vi.fn(),
  createAskpassScript: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    spawn: mocks.spawn,
    write: mocks.write,
    kill: mocks.kill,
  },
  sshApi: {
    connect: mocks.connect,
    sftpListDir: vi.fn().mockResolvedValue({ success: true, data: [] }),
  },
  createAskpassScript: mocks.createAskpassScript,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

const baseProfile: SSHProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'agent',
  portForwards: [],
}

describe('useSSHConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useSSHStore.setState({
      connections: [],
      profiles: [],
      transfers: [],
      isLoaded: false,
      activeProfileId: null,
      editingFile: null,
      editingContent: '',
    })
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: '',
      ptyIdIndex: new Map(),
    })

    mocks.spawn.mockResolvedValue({
      success: true,
      data: { id: 'pty-1', shell: 'ssh', cwd: '/' },
    })
    mocks.write.mockResolvedValue({ success: true, data: undefined })
    mocks.connect.mockResolvedValue({
      success: true,
      data: {
        id: 'conn-1',
        profileId: 'profile-1',
        status: 'connected',
        terminalId: null,
        error: null,
        reconnectAttempts: 0,
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('preserves default known_hosts verification when spawning interactive ssh', async () => {
    const { result } = renderHook(() => useSSHConnection(baseProfile))

    await act(async () => {
      await result.current.handleConnect()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(mocks.write).toHaveBeenCalledWith(
      'pty-1',
      expect.stringContaining('-o StrictHostKeyChecking=accept-new')
    )
    expect(mocks.write).toHaveBeenCalledWith(
      'pty-1',
      expect.not.stringContaining('UserKnownHostsFile')
    )
  })

  it('marks connected and readies SFTP only after the backend connect succeeds', async () => {
    const { result } = renderHook(() => useSSHConnection(baseProfile))

    await act(async () => {
      await result.current.handleConnect()
    })

    const conn = useSSHStore.getState().connections.find((c) => c.profileId === 'profile-1')
    expect(conn?.status).toBe('connected')
    expect(conn?.id).toBe('conn-1') // swapped to the backend id
    expect(result.current.sftpReady).toBe(true)
  })

  it('does NOT report connected when the backend SSH connect fails', async () => {
    mocks.connect.mockResolvedValueOnce({
      success: false,
      error: 'Password authentication failed',
      code: 'SSH_CONNECT_ERROR',
    })

    const { result } = renderHook(() => useSSHConnection(baseProfile))

    await act(async () => {
      await result.current.handleConnect()
    })

    const conn = useSSHStore.getState().connections.find((c) => c.profileId === 'profile-1')
    expect(conn?.status).toBe('failed')
    expect(conn?.error).toBe('Password authentication failed')
    expect(result.current.isConnected).toBe(false)
    expect(result.current.sftpReady).toBe(false)
  })

  it('downgrades to failed when the interactive ssh process exits before connecting', async () => {
    mocks.connect.mockResolvedValueOnce({
      success: false,
      error: 'timed out',
      code: 'SSH_CONNECT_ERROR',
    })

    const { result } = renderHook(() => useSSHConnection(baseProfile))

    await act(async () => {
      await result.current.handleConnect()
    })
    act(() => {
      result.current.handleSSHProcessExit()
    })

    const conn = useSSHStore.getState().connections.find((c) => c.profileId === 'profile-1')
    expect(conn?.status).toBe('failed')
    expect(result.current.isConnected).toBe(false)
  })

  it('keeps the interactive terminal reachable after a backend connect failure (no orphan)', async () => {
    mocks.connect.mockResolvedValueOnce({
      success: false,
      error: 'auth failed',
      code: 'SSH_CONNECT_ERROR',
    })

    const { result } = renderHook(() => useSSHConnection(baseProfile))

    await act(async () => {
      await result.current.handleConnect()
    })

    // The PTY is NOT killed on failure: the terminal stays visible (SSHWorkspace
    // renders on localTerminalPtyId) with a Disconnect control, so the ssh
    // process is never an unreachable orphan.
    expect(mocks.kill).not.toHaveBeenCalled()
    expect(result.current.localTerminalPtyId).toBe('pty-1')
    const conn = useSSHStore.getState().connections.find((c) => c.profileId === 'profile-1')
    expect(conn?.status).toBe('failed')
  })

  it('kills the previous PTY when retrying connect (prevents orphan leak)', async () => {
    mocks.connect.mockResolvedValueOnce({
      success: false,
      error: 'auth failed',
      code: 'SSH_CONNECT_ERROR',
    })
    mocks.spawn
      .mockResolvedValueOnce({ success: true, data: { id: 'pty-1', shell: 'ssh', cwd: '/' } })
      .mockResolvedValueOnce({ success: true, data: { id: 'pty-2', shell: 'ssh', cwd: '/' } })

    const { result } = renderHook(() => useSSHConnection(baseProfile))

    await act(async () => {
      await result.current.handleConnect()
    })
    // Retry: the first (failed) PTY must be killed before the new spawn.
    await act(async () => {
      await result.current.handleConnect()
    })

    expect(mocks.kill).toHaveBeenCalledWith('pty-1')
    expect(result.current.localTerminalPtyId).toBe('pty-2')
  })

  it('does not blank SFTP or downgrade when the shell exits on a healthy connection', async () => {
    const { result } = renderHook(() => useSSHConnection(baseProfile))

    await act(async () => {
      await result.current.handleConnect()
    })
    // Sanity: connected with SFTP ready.
    expect(result.current.isConnected).toBe(true)
    expect(result.current.sftpReady).toBe(true)

    // User types `exit` in the interactive shell; the ssh2/SFTP backend is
    // independent and still connected, so SFTP must stay ready and the badge
    // must remain connected.
    act(() => {
      result.current.handleSSHProcessExit()
    })

    const conn = useSSHStore.getState().connections.find((c) => c.profileId === 'profile-1')
    expect(conn?.status).toBe('connected')
    expect(result.current.sftpReady).toBe(true)
  })
})
