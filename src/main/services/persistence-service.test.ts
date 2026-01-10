import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'

// Use vi.hoisted to create mock functions that are accessible in vi.mock factories
const { mockMkdir, mockReadFile, mockWriteFile, mockUnlink, mockRename, mockAccess } = vi.hoisted(
  () => ({
    mockMkdir: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockUnlink: vi.fn(),
    mockRename: vi.fn(),
    mockAccess: vi.fn()
  })
)

// Mock modules
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data')
  }
}))

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
    it('should return correct path for simple key', () => {
      const path = getFilePath('projects')
      expect(path).toBe(join('/mock/user/data', 'projects.json'))
    })

    it('should return correct path for nested key', () => {
      const path = getFilePath('terminals/project-1')
      expect(path).toBe(join('/mock/user/data', 'terminals/project-1.json'))
    })

    it('should throw error for path traversal attempt', () => {
      expect(() => getFilePath('../etc/passwd')).toThrow('Invalid storage key')
      expect(() => getFilePath('projects/../secrets')).toThrow('Invalid storage key')
    })

    it('should throw error for empty key', () => {
      expect(() => getFilePath('')).toThrow('Invalid storage key')
    })

    it('should throw error for invalid characters', () => {
      expect(() => getFilePath('projects;rm -rf')).toThrow('Invalid storage key')
      expect(() => getFilePath('projects$(evil)')).toThrow('Invalid storage key')
    })
  })

  describe('getBackupPath', () => {
    it('should append .backup to file path', () => {
      const path = getBackupPath('/mock/path/file.json')
      expect(path).toBe('/mock/path/file.json.backup')
    })
  })

  describe('read', () => {
    it('should return parsed JSON data on success', async () => {
      const testData = { name: 'test', value: 123 }
      mockReadFile.mockResolvedValue(JSON.stringify(testData))

      const result = await read<typeof testData>('test-key')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(testData)
      }
    })

    it('should return FILE_NOT_FOUND error when file does not exist', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      mockReadFile.mockRejectedValue(error)

      const result = await read('missing-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('FILE_NOT_FOUND')
      }
    })

    it('should return PARSE_ERROR for invalid JSON', async () => {
      mockReadFile.mockResolvedValue('not valid json')

      const result = await read('invalid-json')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('PARSE_ERROR')
      }
    })
  })

  describe('write', () => {
    it('should write JSON data atomically', async () => {
      mockMkdir.mockResolvedValue(undefined)
      mockWriteFile.mockResolvedValue(undefined)
      mockAccess.mockRejectedValue(new Error('File not found'))
      mockRename.mockResolvedValue(undefined)

      const testData = { name: 'test' }
      const result = await write('test-key', testData)

      expect(result.success).toBe(true)
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        JSON.stringify(testData, null, 2),
        'utf-8'
      )
      expect(mockRename).toHaveBeenCalled()
    })

    it('should create backup of existing file', async () => {
      mockMkdir.mockResolvedValue(undefined)
      mockWriteFile.mockResolvedValue(undefined)
      mockAccess.mockResolvedValue(undefined) // File exists
      mockRename.mockResolvedValue(undefined)

      const result = await write('existing-key', { data: 'new' })

      expect(result.success).toBe(true)
      // Should have been called twice: once for backup, once for atomic rename
      expect(mockRename).toHaveBeenCalledTimes(2)
    })

    it('should return WRITE_ERROR on failure', async () => {
      mockMkdir.mockResolvedValue(undefined)
      mockWriteFile.mockRejectedValue(new Error('Disk full'))
      mockUnlink.mockResolvedValue(undefined)

      const result = await write('fail-key', { data: 'test' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('WRITE_ERROR')
      }
    })
  })

  describe('remove', () => {
    it('should delete file successfully', async () => {
      mockUnlink.mockResolvedValue(undefined)

      const result = await remove('delete-key')

      expect(result.success).toBe(true)
    })

    it('should succeed if file does not exist', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      mockUnlink.mockRejectedValue(error)

      const result = await remove('missing-key')

      expect(result.success).toBe(true)
    })

    it('should return DELETE_ERROR on other failures', async () => {
      mockUnlink.mockRejectedValue(new Error('Permission denied'))

      const result = await remove('protected-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('DELETE_ERROR')
      }
    })
  })

  describe('writeDebounced', () => {
    it('should not write immediately', () => {
      writeDebounced('debounce-key', { data: 'test' })

      expect(mockWriteFile).not.toHaveBeenCalled()
      expect(getPendingWriteCount()).toBe(1)
    })

    it('should write after debounce delay', async () => {
      mockMkdir.mockResolvedValue(undefined)
      mockWriteFile.mockResolvedValue(undefined)
      mockAccess.mockRejectedValue(new Error('File not found'))
      mockRename.mockResolvedValue(undefined)

      writeDebounced('debounce-key', { data: 'test' })

      await vi.advanceTimersByTimeAsync(500)

      expect(mockWriteFile).toHaveBeenCalled()
      expect(getPendingWriteCount()).toBe(0)
    })

    it('should coalesce multiple writes to same key', async () => {
      mockMkdir.mockResolvedValue(undefined)
      mockWriteFile.mockResolvedValue(undefined)
      mockAccess.mockRejectedValue(new Error('File not found'))
      mockRename.mockResolvedValue(undefined)

      writeDebounced('coalesce-key', { version: 1 })
      writeDebounced('coalesce-key', { version: 2 })
      writeDebounced('coalesce-key', { version: 3 })

      expect(getPendingWriteCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(500)

      expect(mockWriteFile).toHaveBeenCalledTimes(1)
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify({ version: 3 }, null, 2),
        'utf-8'
      )
    })
  })

  describe('flushPendingWrites', () => {
    it('should write all pending data immediately', async () => {
      mockMkdir.mockResolvedValue(undefined)
      mockWriteFile.mockResolvedValue(undefined)
      mockAccess.mockRejectedValue(new Error('File not found'))
      mockRename.mockResolvedValue(undefined)

      writeDebounced('key1', { data: 1 })
      writeDebounced('key2', { data: 2 })

      expect(getPendingWriteCount()).toBe(2)

      await flushPendingWrites()

      expect(getPendingWriteCount()).toBe(0)
      expect(mockWriteFile).toHaveBeenCalledTimes(2)
    })
  })
})
