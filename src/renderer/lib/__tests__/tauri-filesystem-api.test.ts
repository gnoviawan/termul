/**
 * Unit tests for tauri-filesystem-api.ts
 * Tests the tauriFilesystemApi implementation using Tauri plugin-fs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FileInfo } from '@tauri-apps/plugin-fs'

type WatchCallback = (event: unknown) => void

const defaultStat: FileInfo = {
  isFile: true,
  isDirectory: false,
  isSymlink: false,
  size: 1024,
  mtime: new Date(),
  atime: null,
  birthtime: null,
  readonly: false,
  fileAttributes: null,
  dev: null,
  ino: null,
  mode: null,
  nlink: null,
  uid: null,
  gid: null,
  rdev: null,
  blksize: null,
  blocks: null
}

// Mock @tauri-apps/plugin-fs BEFORE importing
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(async () => []),
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  stat: vi.fn(async () => defaultStat),
  watchImmediate: vi.fn(async (_paths: string[], _callback: WatchCallback) => vi.fn())
}))

import {
  readDir, readTextFile, writeTextFile,
  mkdir, remove, rename, stat, watchImmediate
} from '@tauri-apps/plugin-fs'
import type { DirEntry } from '@tauri-apps/plugin-fs'
import { tauriFilesystemApi, _resetFilesystemStateForTesting } from '../tauri-filesystem-api'

function makeFileInfo(overrides: Partial<FileInfo>): FileInfo {
  return {
    ...defaultStat,
    ...overrides
  }
}

describe('tauriFilesystemApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetFilesystemStateForTesting()

    // Restore default mocks after clearing
    vi.mocked(readDir).mockResolvedValue([])
    vi.mocked(readTextFile).mockResolvedValue('')
    vi.mocked(writeTextFile).mockResolvedValue(undefined)
    vi.mocked(mkdir).mockResolvedValue(undefined)
    vi.mocked(remove).mockResolvedValue(undefined)
    vi.mocked(rename).mockResolvedValue(undefined)
    vi.mocked(stat).mockResolvedValue(defaultStat)
    vi.mocked(watchImmediate).mockResolvedValue(vi.fn())
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('readDirectory', () => {
    it('should successfully read directory entries', async () => {
      const mockEntries: DirEntry[] = [
        { name: 'file1.txt', isDirectory: false, isFile: true, isSymlink: false },
        { name: 'dir1', isDirectory: true, isFile: false, isSymlink: false }
      ]
      vi.mocked(readDir).mockResolvedValue(mockEntries)

      const result = await tauriFilesystemApi.readDirectory('/test')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(2)
        expect(result.data![0].name).toBe('file1.txt')
        expect(result.data![0].type).toBe('file')
        expect(result.data![1].name).toBe('dir1')
        expect(result.data![1].type).toBe('directory')
      }
    })

    it('should filter ALWAYS_IGNORE patterns', async () => {
      const mockEntries: DirEntry[] = [
        { name: 'file1.txt', isDirectory: false, isFile: true, isSymlink: false },
        { name: 'node_modules', isDirectory: true, isFile: false, isSymlink: false },
        { name: '.git', isDirectory: true, isFile: false, isSymlink: false },
        { name: 'dist', isDirectory: true, isFile: false, isSymlink: false }
      ]
      vi.mocked(readDir).mockResolvedValue(mockEntries)

      const result = await tauriFilesystemApi.readDirectory('/test')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(1)
        expect(result.data![0].name).toBe('file1.txt')
      }
    })

    it('should handle errors', async () => {
      vi.mocked(readDir).mockRejectedValue(new Error('Permission denied'))

      const result = await tauriFilesystemApi.readDirectory('/test')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('READ_DIR_ERROR')
      }
    })
  })

  describe('readFile', () => {
    it('should successfully read file content', async () => {
      const testDate = new Date('2024-01-01')
      vi.mocked(readTextFile).mockResolvedValue('Hello, World!')
      vi.mocked(stat).mockResolvedValue(makeFileInfo({ size: 13, mtime: testDate }))

      const result = await tauriFilesystemApi.readFile('/test/file.txt')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.content).toBe('Hello, World!')
        expect(result.data.size).toBe(13)
        expect(result.data.encoding).toBe('utf-8')
      }
    })

    it('should reject files larger than MAX_FILE_SIZE', async () => {
      vi.mocked(stat).mockResolvedValue(makeFileInfo({ size: 2 * 1024 * 1024 }))

      const result = await tauriFilesystemApi.readFile('/test/large.bin')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('FILE_TOO_LARGE')
      }
    })

    it('should handle errors', async () => {
      vi.mocked(stat).mockRejectedValue(new Error('File not found'))

      const result = await tauriFilesystemApi.readFile('/test/nonexistent.txt')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('READ_ERROR')
      }
    })
  })

  describe('getFileInfo', () => {
    it('should return file metadata', async () => {
      const testDate = new Date('2024-01-01T00:00:00Z')
      vi.mocked(stat).mockResolvedValue(makeFileInfo({ size: 2048, mtime: testDate }))
      vi.mocked(readTextFile).mockResolvedValue('some content')

      const result = await tauriFilesystemApi.getFileInfo('/test/file.txt')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.size).toBe(2048)
        expect(result.data.path).toBe('/test/file.txt')
        expect(result.data.isReadOnly).toBe(false)
        expect(result.data.isBinary).toBe(false)
      }
    })

    it('should detect binary files', async () => {
      const testDate = new Date('2024-01-01T00:00:00Z')
      vi.mocked(stat).mockResolvedValue(makeFileInfo({ size: 10, mtime: testDate }))
      vi.mocked(readTextFile).mockResolvedValue('Hello\x00World')

      const result = await tauriFilesystemApi.getFileInfo('/test/binary.bin')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.isBinary).toBe(true)
      }
    })

    it('should handle errors', async () => {
      vi.mocked(stat).mockRejectedValue(new Error('Stat failed'))

      const result = await tauriFilesystemApi.getFileInfo('/test/file.txt')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('STAT_ERROR')
      }
    })
  })

  describe('writeFile', () => {
    it('should successfully write file', async () => {
      const result = await tauriFilesystemApi.writeFile('/test/file.txt', 'content')

      expect(result.success).toBe(true)
      expect(vi.mocked(writeTextFile)).toHaveBeenCalledWith('/test/file.txt', 'content')
    })

    it('should handle errors', async () => {
      vi.mocked(writeTextFile).mockRejectedValue(new Error('Write failed'))

      const result = await tauriFilesystemApi.writeFile('/test/file.txt', 'content')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('WRITE_ERROR')
      }
    })
  })

  describe('createFile', () => {
    it('should successfully create new file', async () => {
      const result = await tauriFilesystemApi.createFile('/test/new.txt', 'content')

      expect(result.success).toBe(true)
      expect(vi.mocked(writeTextFile)).toHaveBeenCalledWith('/test/new.txt', 'content')
    })

    it('should handle errors', async () => {
      vi.mocked(writeTextFile).mockRejectedValue(new Error('Create failed'))

      const result = await tauriFilesystemApi.createFile('/test/new.txt', 'content')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('CREATE_ERROR')
      }
    })
  })

  describe('createDirectory', () => {
    it('should successfully create directory', async () => {
      const result = await tauriFilesystemApi.createDirectory('/test/new-dir')

      expect(result.success).toBe(true)
      expect(vi.mocked(mkdir)).toHaveBeenCalledWith('/test/new-dir', { recursive: true })
    })

    it('should handle errors', async () => {
      vi.mocked(mkdir).mockRejectedValue(new Error('Mkdir failed'))

      const result = await tauriFilesystemApi.createDirectory('/test/new-dir')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('MKDIR_ERROR')
      }
    })
  })

  describe('deleteFile', () => {
    it('should successfully delete file', async () => {
      const result = await tauriFilesystemApi.deleteFile('/test/file.txt')

      expect(result.success).toBe(true)
      expect(vi.mocked(remove)).toHaveBeenCalledWith('/test/file.txt')
    })

    it('should handle errors', async () => {
      vi.mocked(remove).mockRejectedValue(new Error('Delete failed'))

      const result = await tauriFilesystemApi.deleteFile('/test/file.txt')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('DELETE_ERROR')
      }
    })
  })

  describe('renameFile', () => {
    it('should successfully rename file', async () => {
      const result = await tauriFilesystemApi.renameFile('/test/old.txt', '/test/new.txt')

      expect(result.success).toBe(true)
      expect(vi.mocked(rename)).toHaveBeenCalledWith('/test/old.txt', '/test/new.txt')
    })

    it('should handle errors', async () => {
      vi.mocked(rename).mockRejectedValue(new Error('Rename failed'))

      const result = await tauriFilesystemApi.renameFile('/test/old.txt', '/test/new.txt')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('RENAME_ERROR')
      }
    })
  })

  describe('watchDirectory', () => {
    it('should successfully watch directory', async () => {
      const mockUnlisten = vi.fn()
      vi.mocked(watchImmediate).mockResolvedValue(mockUnlisten)

      const result = await tauriFilesystemApi.watchDirectory('/test')

      expect(result.success).toBe(true)
      expect(vi.mocked(watchImmediate)).toHaveBeenCalled()
    })

    it('should handle errors', async () => {
      vi.mocked(watchImmediate).mockRejectedValue(new Error('Watch failed'))

      const result = await tauriFilesystemApi.watchDirectory('/test')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('WATCH_ERROR')
      }
    })

    it('should return success if already watching', async () => {
      const mockUnlisten = vi.fn()
      vi.mocked(watchImmediate).mockResolvedValue(mockUnlisten)

      // First watch
      await tauriFilesystemApi.watchDirectory('/test')
      // Second watch on same path
      const result = await tauriFilesystemApi.watchDirectory('/test')

      expect(result.success).toBe(true)
      // watchImmediate should only be called once
      expect(vi.mocked(watchImmediate)).toHaveBeenCalledTimes(1)
    })
  })

  describe('unwatchDirectory', () => {
    it('should successfully unwatch directory', async () => {
      const mockUnlisten = vi.fn()
      vi.mocked(watchImmediate).mockResolvedValue(mockUnlisten)

      // First watch
      await tauriFilesystemApi.watchDirectory('/test')
      // Then unwatch
      const result = await tauriFilesystemApi.unwatchDirectory('/test')

      expect(result.success).toBe(true)
      expect(mockUnlisten).toHaveBeenCalled()
    })

    it('should handle unwatching non-watched directory gracefully', async () => {
      const result = await tauriFilesystemApi.unwatchDirectory('/non-existent')

      expect(result.success).toBe(true) // Should succeed even if not watching
    })

    it('should handle errors', async () => {
      // Force an error by making unlisten throw
      const badUnlisten = () => {
        throw new Error('Unlisten failed')
      }
      vi.mocked(watchImmediate).mockResolvedValue(badUnlisten)

      await tauriFilesystemApi.watchDirectory('/test')
      const result = await tauriFilesystemApi.unwatchDirectory('/test')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('UNWATCH_ERROR')
      }
    })
  })

  describe('onFileChanged', () => {
    it('should return cleanup function', () => {
      const cleanup = tauriFilesystemApi.onFileChanged(vi.fn())

      expect(typeof cleanup).toBe('function')
    })

    it('should register callback for watched directories', async () => {
      const mockUnlisten = vi.fn()
      vi.mocked(watchImmediate).mockResolvedValue(mockUnlisten)

      const callback = vi.fn()
      await tauriFilesystemApi.watchDirectory('/test')
      tauriFilesystemApi.onFileChanged(callback)

      // Cleanup should remove callback
      const cleanup = tauriFilesystemApi.onFileChanged(callback)
      cleanup()
    })
  })
})
