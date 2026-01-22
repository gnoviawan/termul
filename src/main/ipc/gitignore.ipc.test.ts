/**
 * Unit tests for Gitignore IPC Handlers
 *
 * Tests IPC channel registration and handler logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerGitignoreHandlers } from './gitignore.ipc'
import * as gitignoreParser from '../services/gitignore-parser'

// Mock gitignore parser
vi.mock('../services/gitignore-parser', () => ({
  parseGitignore: vi.fn(),
}))

describe('Gitignore IPC Handlers', () => {
  let mockIpcMain: any
  let mockManager: any

  beforeEach(async () => {
    vi.clearAllMocks()

    // Create mock manager
    mockManager = {
      saveProfile: vi.fn(),
      loadProfiles: vi.fn(),
      deleteProfile: vi.fn(),
    }

    // Mock gitignore profile manager to return our mock manager
    vi.doMock('../services/gitignore-profiles', () => ({
      GitignoreProfileManager: vi.fn(() => mockManager),
    }))

    // Get the mocked ipcMain
    const electron = await import('electron')
    mockIpcMain = (electron as any).ipcMain
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('registerGitignoreHandlers', () => {
    it('should register all gitignore IPC handlers', () => {
      registerGitignoreHandlers()

      expect(mockIpcMain.handle).toHaveBeenCalledWith('gitignore:parse', expect.any(Function))
      expect(mockIpcMain.handle).toHaveBeenCalledWith('gitignore:profiles:save', expect.any(Function))
      expect(mockIpcMain.handle).toHaveBeenCalledWith('gitignore:profiles:list', expect.any(Function))
      expect(mockIpcMain.handle).toHaveBeenCalledWith('gitignore:profiles:delete', expect.any(Function))
    })

    it('should register 4 handlers', () => {
      registerGitignoreHandlers()

      expect(mockIpcMain.handle).toHaveBeenCalledTimes(4)
    })
  })

  describe('gitignore:parse handler', () => {
    it('should parse .gitignore file successfully', async () => {
      const mockParseResult = {
        patterns: [
          { pattern: 'node_modules/', category: 'dependencies' as const, isSecuritySensitive: false, relatedPatterns: [] },
        ],
        groupedPatterns: new Map([['dependencies', []]]),
        securityPatterns: [],
      }

      ;(gitignoreParser.parseGitignore as ReturnType<typeof vi.fn>).mockResolvedValue(mockParseResult)

      registerGitignoreHandlers()

      // Get the handler function
      const handlerCalls = mockIpcMain.handle.mock.calls
      const parseHandlerCall = handlerCalls.find(call => call[0] === 'gitignore:parse')
      const handler = parseHandlerCall![1]

      // Call the handler
      const result = await handler!(null, { projectRoot: '/test/project' })

      expect(result).toEqual({
        success: true,
        data: {
          patterns: mockParseResult.patterns,
          groupedPatterns: { dependencies: [] },
          securityPatterns: []
        }
      })
    })

    it('should return error on parse failure', async () => {
      (gitignoreParser.parseGitignore as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Parse failed'))

      registerGitignoreHandlers()

      const handlerCalls = mockIpcMain.handle.mock.calls
      const parseHandlerCall = handlerCalls.find(call => call[0] === 'gitignore:parse')
      const handler = parseHandlerCall![1]

      const result = await handler!(null, { projectRoot: '/test/project' })

      expect(result).toEqual({
        success: false,
        error: 'Parse failed',
        code: 'GITIGNORE_PARSE_FAILED'
      })
    })
  })

  describe('gitignore:profiles:save handler', () => {
    it('should save profile successfully', async () => {
      mockManager.saveProfile.mockResolvedValue(undefined)

      registerGitignoreHandlers()

      const handlerCalls = mockIpcMain.handle.mock.calls
      const saveHandlerCall = handlerCalls.find(call => call[0] === 'gitignore:profiles:save')
      const handler = saveHandlerCall![1]

      const result = await handler!(null, {
        projectRoot: '/test/project',
        name: 'test-profile',
        patterns: ['node_modules/']
      })

      expect(result).toEqual({
        success: true,
        data: undefined
      })
      expect(mockManager.saveProfile).toHaveBeenCalledWith('test-profile', ['node_modules/'])
    })

    it('should return PROFILE_ALREADY_EXISTS error on duplicate', async () => {
      mockManager.saveProfile.mockRejectedValue(new Error('Profile "test-profile" already exists'))

      registerGitignoreHandlers()

      const handlerCalls = mockIpcMain.handle.mock.calls
      const saveHandlerCall = handlerCalls.find(call => call[0] === 'gitignore:profiles:save')
      const handler = saveHandlerCall![1]

      const result = await handler!(null, {
        projectRoot: '/test/project',
        name: 'test-profile',
        patterns: ['node_modules/']
      })

      expect(result).toEqual({
        success: false,
        error: 'Profile "test-profile" already exists',
        code: 'PROFILE_ALREADY_EXISTS'
      })
    })
  })

  describe('gitignore:profiles:list handler', () => {
    it('should load profiles successfully', async () => {
      const mockProfiles = [
        { name: 'frontend', patterns: ['node_modules/'], createdAt: '2024-01-01T00:00:00.000Z' },
      ]

      mockManager.loadProfiles.mockResolvedValue(mockProfiles)

      registerGitignoreHandlers()

      const handlerCalls = mockIpcMain.handle.mock.calls
      const listHandlerCall = handlerCalls.find(call => call[0] === 'gitignore:profiles:list')
      const handler = listHandlerCall![1]

      const result = await handler!(null, { projectRoot: '/test/project' })

      expect(result).toEqual({
        success: true,
        data: mockProfiles
      })
    })
  })

  describe('gitignore:profiles:delete handler', () => {
    it('should delete profile successfully', async () => {
      mockManager.deleteProfile.mockResolvedValue(undefined)

      registerGitignoreHandlers()

      const handlerCalls = mockIpcMain.handle.mock.calls
      const deleteHandlerCall = handlerCalls.find(call => call[0] === 'gitignore:profiles:delete')
      const handler = deleteHandlerCall![1]

      const result = await handler!(null, {
        projectRoot: '/test/project',
        name: 'test-profile'
      })

      expect(result).toEqual({
        success: true,
        data: undefined
      })
      expect(mockManager.deleteProfile).toHaveBeenCalledWith('test-profile')
    })

    it('should return PROFILE_NOT_FOUND error when profile missing', async () => {
      mockManager.deleteProfile.mockRejectedValue(new Error('Profile "test-profile" not found'))

      registerGitignoreHandlers()

      const handlerCalls = mockIpcMain.handle.mock.calls
      const deleteHandlerCall = handlerCalls.find(call => call[0] === 'gitignore:profiles:delete')
      const handler = deleteHandlerCall![1]

      const result = await handler!(null, {
        projectRoot: '/test/project',
        name: 'test-profile'
      })

      expect(result).toEqual({
        success: false,
        error: 'Profile "test-profile" not found',
        code: 'PROFILE_NOT_FOUND'
      })
    })
  })
})
