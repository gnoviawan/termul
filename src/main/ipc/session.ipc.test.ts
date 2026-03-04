/**
 * Unit tests for session.ipc.ts
 * Tests Electron IPC session handlers still work (compatibility path validation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerSessionIpc, resetSessionIpc } from './session.ipc'
import type { SessionData } from '../../shared/types/ipc.types'
import type { IpcResult } from '../../shared/types/ipc.types'

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

// Mock session-persistence service
const mockSessionService = {
  saveSession: vi.fn(),
  restoreSession: vi.fn(),
  clearSession: vi.fn(),
  hasSavedSession: vi.fn(),
  flushPendingAutoSave: vi.fn()
}

vi.mock('../services/session-persistence', () => ({
  getDefaultSessionPersistenceService: () => mockSessionService,
  resetSessionPersistenceService: vi.fn()
}))

describe('session.ipc (Electron compatibility)', () => {
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

    // Setup default mock responses
    mockSessionService.saveSession.mockResolvedValue({ success: true, data: undefined })
    mockSessionService.restoreSession.mockResolvedValue({ success: true, data: null })
    mockSessionService.clearSession.mockResolvedValue({ success: true, data: undefined })
    mockSessionService.hasSavedSession.mockResolvedValue(true)
    mockSessionService.flushPendingAutoSave.mockResolvedValue(undefined)
  })

  afterEach(() => {
    // Reset IPC handlers after each test
    resetSessionIpc()
  })

  describe('registerSessionIpc', () => {
    it('should register all session IPC handlers', () => {
      registerSessionIpc()

      expect(ipcMain.handle).toHaveBeenCalledWith('session:save', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('session:restore', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('session:clear', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('session:flush', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('session:hasSession', expect.any(Function))
    })

    it('should use the default session persistence service', () => {
      registerSessionIpc()

      // The handlers should be registered
      expect(handlers.size).toBe(5)
    })
  })

  describe('session:save handler', () => {
    const createValidSessionData = (): SessionData => ({
      timestamp: new Date().toISOString(),
      terminals: [
        {
          id: 'terminal-123',
          shell: 'bash',
          cwd: '/home/user',
          history: ['ls -la', 'cd /tmp'],
          env: { PATH: '/usr/bin' }
        }
      ],
      workspaces: [
        {
          projectId: 'project-abc',
          activeTerminalId: 'terminal-123',
          terminals: [
            { id: 'terminal-123', shell: 'bash', cwd: '/home/user', history: [] }
          ]
        }
      ]
    })

    it('should save session data successfully', async () => {
      const sessionData = createValidSessionData()
      mockSessionService.saveSession.mockResolvedValue({ success: true, data: undefined })

      registerSessionIpc()

      const handler = handlers.get('session:save')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, sessionData)

      expect(mockSessionService.saveSession).toHaveBeenCalledWith(sessionData)
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('should propagate errors from session service', async () => {
      const sessionData = createValidSessionData()
      mockSessionService.saveSession.mockResolvedValue({
        success: false,
        error: 'Failed to save session',
        code: 'SESSION_SAVE_FAILED'
      })

      registerSessionIpc()

      const handler = handlers.get('session:save')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, sessionData) as IpcResult<void>

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Failed to save session')
        expect(result.code).toBe('SESSION_SAVE_FAILED')
      }
    })
  })

  describe('session:restore handler', () => {
    it('should restore session data successfully', async () => {
      const mockRestoredData: SessionData = {
        timestamp: '2024-01-01T00:00:00Z',
        terminals: [
          {
            id: 'terminal-456',
            shell: 'zsh',
            cwd: '/home/user/projects',
            history: ['npm install'],
            env: undefined
          }
        ],
        workspaces: []
      }

      mockSessionService.restoreSession.mockResolvedValue({
        success: true,
        data: mockRestoredData
      })

      registerSessionIpc()

      const handler = handlers.get('session:restore')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({
        success: true,
        data: mockRestoredData
      })
    })

    it('should handle no saved session', async () => {
      mockSessionService.restoreSession.mockResolvedValue({
        success: false,
        error: 'No saved session found',
        code: 'SESSION_NOT_FOUND'
      })

      registerSessionIpc()

      const handler = handlers.get('session:restore')
      const result = await handler!({} as Electron.IpcMainInvokeEvent) as IpcResult<SessionData>

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_NOT_FOUND')
      }
    })
  })

  describe('session:clear handler', () => {
    it('should clear session successfully', async () => {
      mockSessionService.clearSession.mockResolvedValue({ success: true, data: undefined })

      registerSessionIpc()

      const handler = handlers.get('session:clear')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(mockSessionService.clearSession).toHaveBeenCalled()
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('should propagate clear errors', async () => {
      mockSessionService.clearSession.mockResolvedValue({
        success: false,
        error: 'Failed to clear session',
        code: 'SESSION_CLEAR_FAILED'
      })

      registerSessionIpc()

      const handler = handlers.get('session:clear')
      const result = await handler!({} as Electron.IpcMainInvokeEvent) as IpcResult<void>

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_CLEAR_FAILED')
      }
    })
  })

  describe('session:flush handler', () => {
    it('should flush pending auto-save successfully', async () => {
      mockSessionService.flushPendingAutoSave.mockResolvedValue(undefined)

      registerSessionIpc()

      const handler = handlers.get('session:flush')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(mockSessionService.flushPendingAutoSave).toHaveBeenCalled()
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('should handle flush errors', async () => {
      const error = new Error('Disk full')
      mockSessionService.flushPendingAutoSave.mockRejectedValue(error)

      registerSessionIpc()

      const handler = handlers.get('session:flush')
      const result = await handler!({} as Electron.IpcMainInvokeEvent) as IpcResult<void>

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Disk full')
        expect(result.code).toBe('SESSION_FLUSH_FAILED')
      }
    })
  })

  describe('session:hasSession handler', () => {
    it('should return true when session exists', async () => {
      mockSessionService.hasSavedSession.mockResolvedValue(true)

      registerSessionIpc()

      const handler = handlers.get('session:hasSession')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({ success: true, data: true })
    })

    it('should return false when no session exists', async () => {
      mockSessionService.hasSavedSession.mockResolvedValue(false)

      registerSessionIpc()

      const handler = handlers.get('session:hasSession')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({ success: true, data: false })
    })

    it('should handle check errors', async () => {
      const error = new Error('Permission denied')
      mockSessionService.hasSavedSession.mockRejectedValue(error)

      registerSessionIpc()

      const handler = handlers.get('session:hasSession')
      const result = await handler!({} as Electron.IpcMainInvokeEvent) as IpcResult<boolean>

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Permission denied')
        expect(result.code).toBe('SESSION_CHECK_FAILED')
      }
    })
  })

  describe('Regression: Compatibility with Tauri session-api.ts', () => {
    /**
     * REGRESSION TEST: Ensure Electron IPC handlers maintain compatibility
     * with the legacy session-api.ts that uses window.api.session
     *
     * This validates that the Electron compatibility path still works
     * when running in Electron context.
     */

    it('should maintain IpcResult<T> pattern for all handlers', async () => {
      // Setup all handlers to return success
      mockSessionService.saveSession.mockResolvedValue({ success: true, data: undefined })
      mockSessionService.restoreSession.mockResolvedValue({ success: true, data: null })
      mockSessionService.clearSession.mockResolvedValue({ success: true, data: undefined })
      mockSessionService.hasSavedSession.mockResolvedValue(true)
      mockSessionService.flushPendingAutoSave.mockResolvedValue(undefined)

      registerSessionIpc()

      // session:save returns IpcResult<void>
      const saveHandler = handlers.get('session:save')
      const saveResult = await saveHandler!({} as Electron.IpcMainInvokeEvent, {
        timestamp: new Date().toISOString(),
        terminals: [],
        workspaces: []
      })
      expect(typeof (saveResult as IpcResult<void>).success).toBe('boolean')

      // session:restore returns IpcResult<SessionData>
      const restoreHandler = handlers.get('session:restore')
      const restoreResult = await restoreHandler!({} as Electron.IpcMainInvokeEvent)
      expect(typeof (restoreResult as IpcResult<SessionData>).success).toBe('boolean')

      // session:clear returns IpcResult<void>
      const clearHandler = handlers.get('session:clear')
      const clearResult = await clearHandler!({} as Electron.IpcMainInvokeEvent)
      expect(typeof (clearResult as IpcResult<void>).success).toBe('boolean')

      // session:flush returns IpcResult<void>
      const flushHandler = handlers.get('session:flush')
      const flushResult = await flushHandler!({} as Electron.IpcMainInvokeEvent)
      expect(typeof (flushResult as IpcResult<void>).success).toBe('boolean')

      // session:hasSession returns IpcResult<boolean>
      const hasSessionHandler = handlers.get('session:hasSession')
      const hasSessionResult = await hasSessionHandler!({} as Electron.IpcMainInvokeEvent)
      expect(typeof (hasSessionResult as IpcResult<boolean>).success).toBe('boolean')
    })

    it('should use same method names as session-api.ts facade', () => {
      registerSessionIpc()

      // Verify the channel names match the facade method names
      const expectedChannels = [
        'session:save',
        'session:restore',
        'session:clear',
        'session:flush',
        'session:hasSession'
      ]

      expectedChannels.forEach(channel => {
        expect(handlers.has(channel)).toBe(true)
      })
    })
  })
})
