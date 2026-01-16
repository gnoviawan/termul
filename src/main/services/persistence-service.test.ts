import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'

// Create mock functions outside of vi.hoisted
const mockMkdir = vi.fn()
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockUnlink = vi.fn()
const mockRename = vi.fn()
const mockAccess = vi.fn()

// Mock fs/promises
vi.mock('fs/promises', () => {
  return {
    default: {
      mkdir: mockMkdir,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      unlink: mockUnlink,
      rename: mockRename,
      access: mockAccess
    },
    mkdir: mockMkdir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    unlink: mockUnlink,
    rename: mockRename,
    access: mockAccess
  }
})

// Import the service after mocks are set up
import {
  getStorageDir,
  getFilePath,
  getBackupPath,
  read,
  write,
  remove,
  writeDebounced,
  flushPendingWrites,
  getPendingWriteCount,
  clearPendingWrites
} from './persistence-service'

describe('persistence-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPendingWrites()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getStorageDir', () => {
    it('should return the user data directory', () => {
      const dir = getStorageDir()
      expect(dir).toBe('/mock/user/data')
    })
  })

  describe('getFilePath', () => {
    it('should return correct file path', () => {
      const path = getFilePath('test-project', 'test.json')
      expect(path).toContain('test-project')
      expect(path).toContain('test.json')
    })
  })

  describe('getBackupPath', () => {
    it('should return correct backup path', () => {
      const path = getBackupPath('test.json')
      expect(path).toContain('.backup')
      expect(path).toContain('test.json')
    })
  })

  describe('read', () => {
    it('should read file successfully', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ test: 'data' }))
      const result = await read('test-project', 'test.json')
      expect(result).toEqual({ success: true, data: { test: 'data' } })
    })

    it('should return null on file not found', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      mockReadFile.mockRejectedValue(error)
      const result = await read('test-project', 'test.json')
      expect(result).toEqual({ success: true, data: null })
    })

    it('should return error on read failure', async () => {
      mockReadFile.mockRejectedValue(new Error('Read failed'))
      const result = await read('test-project', 'test.json')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Read failed')
    })
  })

  describe('write', () => {
    it('should write file successfully', async () => {
      mockWriteFile.mockResolvedValue(undefined)
      const result = await write('test-project', 'test.json', { test: 'data' })
      expect(result).toEqual({ success: true, data: undefined })
      expect(mockWriteFile).toHaveBeenCalled()
    })

    it('should create backup if file exists', async () => {
      mockAccess.mockResolvedValue(undefined)
      mockReadFile.mockResolvedValue('old data')
      mockRename.mockResolvedValue(undefined)
      mockWriteFile.mockResolvedValue(undefined)

      await write('test-project', 'test.json', { test: 'data' })

      expect(mockRename).toHaveBeenCalled()
    })
  })

  describe('remove', () => {
    it('should remove file successfully', async () => {
      mockUnlink.mockResolvedValue(undefined)
      const result = await remove('test-project', 'test.json')
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('should ignore file not found errors', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      mockUnlink.mockRejectedValue(error)
      const result = await remove('test-project', 'test.json')
      expect(result).toEqual({ success: true, data: undefined })
    })
  })

  describe('writeDebounced', () => {
    it('should debounce writes', async () => {
      mockWriteFile.mockResolvedValue(undefined)

      writeDebounced('test-project', 'test.json', { test: 'data1' })
      writeDebounced('test-project', 'test.json', { test: 'data2' })
      writeDebounced('test-project', 'test.json', { test: 'data3' })

      // Should not have written yet
      expect(mockWriteFile).not.toHaveBeenCalled()

      // Fast forward past debounce time
      vi.advanceTimersByTime(600)

      // Should have written once
      expect(mockWriteFile).toHaveBeenCalledTimes(1)
    })

    it('should track pending writes', () => {
      writeDebounced('test-project', 'test.json', { test: 'data' })
      expect(getPendingWriteCount()).toBe(1)

      vi.advanceTimersByTime(600)
      expect(getPendingWriteCount()).toBe(0)
    })

    it('should handle multiple files independently', async () => {
      mockWriteFile.mockResolvedValue(undefined)

      writeDebounced('test-project', 'test1.json', { test: 'data1' })
      writeDebounced('test-project', 'test2.json', { test: 'data2' })

      vi.advanceTimersByTime(600)

      expect(mockWriteFile).toHaveBeenCalledTimes(2)
    })
  })

  describe('flushPendingWrites', () => {
    it('should flush all pending writes immediately', async () => {
      mockWriteFile.mockResolvedValue(undefined)

      writeDebounced('test-project', 'test.json', { test: 'data' })
      expect(getPendingWriteCount()).toBe(1)

      await flushPendingWrites()
      expect(getPendingWriteCount()).toBe(0)
      expect(mockWriteFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('clearPendingWrites', () => {
    it('should clear all pending writes', () => {
      writeDebounced('test-project', 'test.json', { test: 'data' })
      expect(getPendingWriteCount()).toBe(1)

      clearPendingWrites()
      expect(getPendingWriteCount()).toBe(0)
    })
  })
})
