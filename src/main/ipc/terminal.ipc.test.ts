import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerTerminalIpc, unregisterTerminalIpc } from './terminal.ipc'
import { PtyManager } from '../services/pty-manager'
import { IpcErrorCodes } from '../../shared/types/ipc.types'

// Mock pty-manager
vi.mock('../services/pty-manager', () => ({
  PtyManager: vi.fn(),
  getDefaultPtyManager: vi.fn()
}))

// Mock cwd-tracker
vi.mock('../services/cwd-tracker', () => ({
  getDefaultCwdTracker: () => ({
    onCwdChanged: vi.fn(() => () => {}),
    getCwd: vi.fn()
  }),
  registerTerminalForCwdTracking: vi.fn(),
  unregisterTerminalFromCwdTracking: vi.fn()
}))

// Mock git-tracker
vi.mock('../services/git-tracker', () => ({
  getDefaultGitTracker: () => ({
    initializeTerminal: vi.fn(),
    removeTerminal: vi.fn(),
    onGitBranchChanged: vi.fn(() => () => {}),
    onGitStatusChanged: vi.fn(() => () => {}),
    getBranch: vi.fn(),
    getStatus: vi.fn()
  })
}))

// Mock exit-code-tracker
vi.mock('../services/exit-code-tracker', () => ({
  getDefaultExitCodeTracker: () => ({
    initializeTerminal: vi.fn(),
    removeTerminal: vi.fn(),
    onExitCodeChanged: vi.fn(() => () => {}),
    getExitCode: vi.fn()
  })
}))

describe('terminal.ipc', () => {
  let mockPtyManager: {
    spawn: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    onData: ReturnType<typeof vi.fn>
    onExit: ReturnType<typeof vi.fn>
  }

  let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>

  beforeEach(() => {
    vi.clearAllMocks()

    handlers = new Map()

    // Capture handlers when registered
    vi.mocked(ipcMain.handle).mockImplementation(
      (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>)
        return undefined as unknown as Electron.IpcMain
      }
    )

    mockPtyManager = {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      get: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn())
    }
  })

  afterEach(() => {
    unregisterTerminalIpc()
  })

  describe('registerTerminalIpc', () => {
    it('should register all terminal IPC handlers', () => {
      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      expect(ipcMain.handle).toHaveBeenCalledWith('terminal:spawn', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('terminal:write', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('terminal:resize', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('terminal:kill', expect.any(Function))
    })

    it('should set up data and exit event forwarding', () => {
      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      expect(mockPtyManager.onData).toHaveBeenCalled()
      expect(mockPtyManager.onExit).toHaveBeenCalled()
    })
  })

  describe('terminal:spawn handler', () => {
    it('should return success with terminal info on successful spawn', async () => {
      mockPtyManager.spawn.mockReturnValue('terminal-123')
      mockPtyManager.get.mockReturnValue({
        id: 'terminal-123',
        shell: 'bash',
        cwd: '/home/user'
      })

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:spawn')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, { cwd: '/home/user' })

      expect(result).toEqual({
        success: true,
        data: {
          id: 'terminal-123',
          shell: 'bash',
          cwd: '/home/user'
        }
      })
    })

    it('should return error when spawn fails to create instance', async () => {
      mockPtyManager.spawn.mockReturnValue('terminal-123')
      mockPtyManager.get.mockReturnValue(undefined)

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:spawn')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, {})

      expect(result).toEqual({
        success: false,
        error: 'Failed to create terminal instance',
        code: IpcErrorCodes.SPAWN_FAILED
      })
    })

    it('should return error when spawn throws exception', async () => {
      mockPtyManager.spawn.mockImplementation(() => {
        throw new Error('Shell not found')
      })

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:spawn')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, {})

      expect(result).toEqual({
        success: false,
        error: 'Shell not found',
        code: IpcErrorCodes.SPAWN_FAILED
      })
    })
  })

  describe('terminal:write handler', () => {
    it('should return success when write succeeds', async () => {
      mockPtyManager.write.mockReturnValue(true)

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:write')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123', 'test data')

      expect(mockPtyManager.write).toHaveBeenCalledWith('terminal-123', 'test data')
      expect(result).toEqual({
        success: true,
        data: undefined
      })
    })

    it('should return error when terminal not found', async () => {
      mockPtyManager.write.mockReturnValue(false)

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:write')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123', 'test data')

      expect(result).toEqual({
        success: false,
        error: 'Terminal terminal-123 not found',
        code: IpcErrorCodes.TERMINAL_NOT_FOUND
      })
    })
  })

  describe('terminal:resize handler', () => {
    it('should return success when resize succeeds', async () => {
      mockPtyManager.resize.mockReturnValue(true)

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:resize')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123', 120, 40)

      expect(mockPtyManager.resize).toHaveBeenCalledWith('terminal-123', 120, 40)
      expect(result).toEqual({
        success: true,
        data: undefined
      })
    })

    it('should return error when terminal not found', async () => {
      mockPtyManager.resize.mockReturnValue(false)

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:resize')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123', 120, 40)

      expect(result).toEqual({
        success: false,
        error: 'Terminal terminal-123 not found',
        code: IpcErrorCodes.TERMINAL_NOT_FOUND
      })
    })

    it('should return error for invalid dimensions', async () => {
      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:resize')

      // Test negative dimensions
      const result1 = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123', -1, 40)
      expect(result1).toEqual({
        success: false,
        error: 'Invalid dimensions: cols and rows must be positive integers',
        code: IpcErrorCodes.RESIZE_FAILED
      })

      // Test zero dimensions
      const result2 = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123', 0, 40)
      expect(result2).toEqual({
        success: false,
        error: 'Invalid dimensions: cols and rows must be positive integers',
        code: IpcErrorCodes.RESIZE_FAILED
      })

      // Test non-integer dimensions
      const result3 = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123', 80.5, 24)
      expect(result3).toEqual({
        success: false,
        error: 'Invalid dimensions: cols and rows must be positive integers',
        code: IpcErrorCodes.RESIZE_FAILED
      })

      // Manager should not be called for invalid dimensions
      expect(mockPtyManager.resize).not.toHaveBeenCalled()
    })
  })

  describe('terminal:kill handler', () => {
    it('should return success when kill succeeds', async () => {
      mockPtyManager.kill.mockReturnValue(true)

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:kill')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123')

      expect(mockPtyManager.kill).toHaveBeenCalledWith('terminal-123')
      expect(result).toEqual({
        success: true,
        data: undefined
      })
    })

    it('should return error when terminal not found', async () => {
      mockPtyManager.kill.mockReturnValue(false)

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      const handler = handlers.get('terminal:kill')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, 'terminal-123')

      expect(result).toEqual({
        success: false,
        error: 'Terminal terminal-123 not found',
        code: IpcErrorCodes.TERMINAL_NOT_FOUND
      })
    })
  })

  describe('event forwarding', () => {
    it('should forward data events to all windows', () => {
      const mockWindow = {
        webContents: {
          send: vi.fn()
        }
      }
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow as unknown as BrowserWindow])

      let dataCallback: ((terminalId: string, data: string) => void) | null = null
      mockPtyManager.onData.mockImplementation((cb: (terminalId: string, data: string) => void) => {
        dataCallback = cb
        return vi.fn()
      })

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      // Simulate data event
      dataCallback!('terminal-123', 'output data')

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'terminal:data',
        'terminal-123',
        'output data'
      )
    })

    it('should forward exit events to all windows', () => {
      const mockWindow = {
        webContents: {
          send: vi.fn()
        }
      }
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow as unknown as BrowserWindow])

      let exitCallback: ((terminalId: string, exitCode: number, signal?: number) => void) | null = null
      mockPtyManager.onExit.mockImplementation((cb: (terminalId: string, exitCode: number, signal?: number) => void) => {
        exitCallback = cb
        return vi.fn()
      })

      registerTerminalIpc(mockPtyManager as unknown as PtyManager)

      // Simulate exit event
      exitCallback!('terminal-123', 0, 15)

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'terminal:exit',
        'terminal-123',
        0,
        15
      )
    })
  })

  describe('unregisterTerminalIpc', () => {
    it('should remove all handlers', () => {
      unregisterTerminalIpc()

      expect(ipcMain.removeHandler).toHaveBeenCalledWith('terminal:spawn')
      expect(ipcMain.removeHandler).toHaveBeenCalledWith('terminal:write')
      expect(ipcMain.removeHandler).toHaveBeenCalledWith('terminal:resize')
      expect(ipcMain.removeHandler).toHaveBeenCalledWith('terminal:kill')
    })
  })
})
