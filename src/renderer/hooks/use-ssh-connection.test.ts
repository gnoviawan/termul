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
    sftpListDir: vi.fn(),
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
})
