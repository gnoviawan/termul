import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockPtyProcess = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn()
}

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPtyProcess)
}))

vi.mock('./shell-detect', () => ({
  getDefaultShell: vi.fn(() => ({
    path: 'powershell.exe',
    name: 'powershell',
    displayName: 'PowerShell'
  })),
  getShellByName: vi.fn((name: string) => {
    const shells: Record<string, { path: string; name: string; displayName: string }> = {
      'powershell': { path: 'powershell.exe', name: 'powershell', displayName: 'PowerShell' },
      'cmd': { path: 'cmd.exe', name: 'cmd', displayName: 'Command Prompt' },
      'pwsh': { path: 'pwsh.exe', name: 'pwsh', displayName: 'PowerShell Core' },
      'bash': { path: 'bash.exe', name: 'bash', displayName: 'Bash' },
      'zsh': { path: 'zsh.exe', name: 'zsh', displayName: 'Zsh' }
    }
    // Return null for unknown shells so the fallback in pty-manager.ts uses the input directly
    return shells[name] || null
  }),
  getHomeDirectory: vi.fn(() => 'C:\\Users\\TestUser'),
  getCurrentPlatform: vi.fn(() => 'win32')
}))

import * as pty from 'node-pty'
import { PtyManager, getDefaultPtyManager, resetDefaultPtyManager } from './pty-manager'

// Helper to spawn and assert success
function spawnHelper(manager: PtyManager, options?: Parameters<PtyManager['spawn']>[0]): string {
  const id = manager.spawn(options)
  expect(id).not.toBeNull()
  return id!
}

describe('PtyManager', () => {
  let manager: PtyManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockPtyProcess.onData.mockImplementation(() => {})
    mockPtyProcess.onExit.mockImplementation(() => {})
    // Disable orphan detection in tests to avoid timer leaks
    manager = new PtyManager({ disableOrphanDetection: true })
  })

  afterEach(() => {
    manager.destroy()
  })

  describe('spawn', () => {
    it('should spawn a new PTY instance and return terminal ID', () => {
      const id = spawnHelper(manager)

      expect(id).toMatch(/^terminal-\d+-\d+$/)
      expect(pty.spawn).toHaveBeenCalledWith(
        'powershell.exe',
        [],
        expect.objectContaining({
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: 'C:\\Users\\TestUser'
        })
      )
    })

    it('should use custom shell when provided', () => {
      spawnHelper(manager, { shell: 'cmd.exe' })

      expect(pty.spawn).toHaveBeenCalledWith(
        'cmd.exe',
        [],
        expect.objectContaining({
          name: 'xterm-256color'
        })
      )
    })

    it('should use custom cwd when provided', () => {
      spawnHelper(manager, { cwd: 'C:\\Projects' })

      expect(pty.spawn).toHaveBeenCalledWith(
        'powershell.exe',
        [],
        expect.objectContaining({
          cwd: 'C:\\Projects'
        })
      )
    })

    it('should use custom dimensions when provided', () => {
      spawnHelper(manager, { cols: 120, rows: 40 })

      expect(pty.spawn).toHaveBeenCalledWith(
        'powershell.exe',
        [],
        expect.objectContaining({
          cols: 120,
          rows: 40
        })
      )
    })

    it('should merge custom environment variables', () => {
      spawnHelper(manager, { env: { CUSTOM_VAR: 'value' } })

      expect(pty.spawn).toHaveBeenCalledWith(
        'powershell.exe',
        [],
        expect.objectContaining({
          env: expect.objectContaining({
            CUSTOM_VAR: 'value'
          })
        })
      )
    })

    it('should generate unique IDs for each terminal', () => {
      const id1 = spawnHelper(manager)
      const id2 = spawnHelper(manager)
      const id3 = spawnHelper(manager)

      expect(id1).not.toBe(id2)
      expect(id2).not.toBe(id3)
      expect(id1).not.toBe(id3)
    })
  })

  describe('write', () => {
    it('should write data to the PTY process', () => {
      const id = spawnHelper(manager)

      const result = manager.write(id, 'test input')

      expect(result).toBe(true)
      expect(mockPtyProcess.write).toHaveBeenCalledWith('test input')
    })

    it('should return false for non-existent terminal', () => {
      const result = manager.write('nonexistent-id', 'test')

      expect(result).toBe(false)
      expect(mockPtyProcess.write).not.toHaveBeenCalled()
    })

    it('should forward Ctrl+C signal (0x03)', () => {
      const id = spawnHelper(manager)

      manager.write(id, '\x03')

      expect(mockPtyProcess.write).toHaveBeenCalledWith('\x03')
    })

    it('should forward Ctrl+D signal (0x04)', () => {
      const id = spawnHelper(manager)

      manager.write(id, '\x04')

      expect(mockPtyProcess.write).toHaveBeenCalledWith('\x04')
    })

    it('should forward Ctrl+Z signal (0x1a)', () => {
      const id = spawnHelper(manager)

      manager.write(id, '\x1a')

      expect(mockPtyProcess.write).toHaveBeenCalledWith('\x1a')
    })
  })

  describe('resize', () => {
    it('should resize the PTY process', () => {
      const id = spawnHelper(manager)

      const result = manager.resize(id, 100, 50)

      expect(result).toBe(true)
      expect(mockPtyProcess.resize).toHaveBeenCalledWith(100, 50)
    })

    it('should return false for non-existent terminal', () => {
      const result = manager.resize('nonexistent-id', 100, 50)

      expect(result).toBe(false)
      expect(mockPtyProcess.resize).not.toHaveBeenCalled()
    })
  })

  describe('kill', () => {
    it('should kill the PTY process', () => {
      const id = spawnHelper(manager)

      const result = manager.kill(id)

      expect(result).toBe(true)
      expect(mockPtyProcess.kill).toHaveBeenCalled()
    })

    it('should remove terminal from active terminals', () => {
      const id = spawnHelper(manager)

      manager.kill(id)

      expect(manager.get(id)).toBeUndefined()
    })

    it('should return false for non-existent terminal', () => {
      const result = manager.kill('nonexistent-id')

      expect(result).toBe(false)
    })
  })

  describe('get', () => {
    it('should return terminal instance when exists', () => {
      const id = spawnHelper(manager)

      const instance = manager.get(id)

      expect(instance).toBeDefined()
      expect(instance?.id).toBe(id)
      expect(instance?.shell).toBe('powershell.exe')
      expect(instance?.cwd).toBe('C:\\Users\\TestUser')
    })

    it('should return undefined for non-existent terminal', () => {
      const instance = manager.get('nonexistent-id')

      expect(instance).toBeUndefined()
    })
  })

  describe('getAll', () => {
    it('should return all active terminal instances', () => {
      const id1 = spawnHelper(manager)
      const id2 = spawnHelper(manager)

      const all = manager.getAll()

      expect(all).toHaveLength(2)
      expect(all.map((t) => t.id)).toContain(id1)
      expect(all.map((t) => t.id)).toContain(id2)
    })

    it('should return empty array when no terminals', () => {
      const all = manager.getAll()

      expect(all).toEqual([])
    })
  })

  describe('getAllIds', () => {
    it('should return all active terminal IDs', () => {
      const id1 = spawnHelper(manager)
      const id2 = spawnHelper(manager)

      const ids = manager.getAllIds()

      expect(ids).toHaveLength(2)
      expect(ids).toContain(id1)
      expect(ids).toContain(id2)
    })
  })

  describe('onData', () => {
    it('should register data callback', () => {
      const callback = vi.fn()
      let capturedDataHandler: ((data: string) => void) | null = null

      mockPtyProcess.onData.mockImplementation((handler: (data: string) => void) => {
        capturedDataHandler = handler
      })

      manager.onData(callback)
      const id = spawnHelper(manager)

      if (capturedDataHandler) {
        ;(capturedDataHandler as (data: string) => void)('test output')
      }

      expect(callback).toHaveBeenCalledWith(id, 'test output')
    })

    it('should return unsubscribe function', () => {
      const callback = vi.fn()

      const unsubscribe = manager.onData(callback)
      unsubscribe()

      let capturedDataHandler: ((data: string) => void) | null = null
      mockPtyProcess.onData.mockImplementation((handler: (data: string) => void) => {
        capturedDataHandler = handler
      })

      manager.spawn()
      if (capturedDataHandler) {
        ;(capturedDataHandler as (data: string) => void)('test output')
      }

      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('onExit', () => {
    it('should register exit callback', () => {
      const callback = vi.fn()
      let capturedExitHandler: ((data: { exitCode: number; signal?: number }) => void) | null =
        null

      mockPtyProcess.onExit.mockImplementation(
        (handler: (data: { exitCode: number; signal?: number }) => void) => {
          capturedExitHandler = handler
        }
      )

      manager.onExit(callback)
      const id = spawnHelper(manager)

      if (capturedExitHandler) {
        ;(capturedExitHandler as (data: { exitCode: number; signal?: number }) => void)({
          exitCode: 0,
          signal: undefined
        })
      }

      expect(callback).toHaveBeenCalledWith(id, 0, undefined)
    })
  })

  describe('killAll', () => {
    it('should kill all active terminals', () => {
      manager.spawn()
      manager.spawn()
      manager.spawn()

      manager.killAll()

      expect(manager.getAll()).toEqual([])
      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(3)
    })
  })

  describe('multiple simultaneous terminals', () => {
    it('should handle multiple terminals independently', () => {
      const id1 = spawnHelper(manager, { shell: 'cmd.exe' })
      const id2 = spawnHelper(manager, { shell: 'powershell.exe' })

      expect(manager.getAll()).toHaveLength(2)

      manager.write(id1, 'command1')
      manager.write(id2, 'command2')

      expect(mockPtyProcess.write).toHaveBeenCalledWith('command1')
      expect(mockPtyProcess.write).toHaveBeenCalledWith('command2')

      manager.kill(id1)

      expect(manager.getAll()).toHaveLength(1)
      expect(manager.get(id1)).toBeUndefined()
      expect(manager.get(id2)).toBeDefined()
    })
  })
})

describe('getDefaultPtyManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPtyProcess.onData.mockImplementation(() => {})
    mockPtyProcess.onExit.mockImplementation(() => {})
  })

  afterEach(() => {
    resetDefaultPtyManager()
  })

  it('should return a singleton PtyManager instance', () => {
    const manager1 = getDefaultPtyManager()
    const manager2 = getDefaultPtyManager()

    expect(manager1).toBe(manager2)
    expect(manager1).toBeInstanceOf(PtyManager)
  })
})

describe('resetDefaultPtyManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPtyProcess.onData.mockImplementation(() => {})
    mockPtyProcess.onExit.mockImplementation(() => {})
  })

  afterEach(() => {
    resetDefaultPtyManager()
  })

  it('should reset the default manager', () => {
    const manager1 = getDefaultPtyManager()
    spawnHelper(manager1)

    resetDefaultPtyManager()

    const manager2 = getDefaultPtyManager()
    expect(manager2).not.toBe(manager1)
    expect(manager2.getAll()).toHaveLength(0)
  })
})
