/**
 * Unit tests for tauri-filesystem-api.ts
 * Tests the tauriFilesystemApi implementation using Tauri plugin-fs
 */

import type { FileInfo } from '@tauri-apps/plugin-fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  open: vi.fn(async () => ({
    read: vi.fn(async () => 0),
    close: vi.fn(async () => {})
  })),
  readDir: vi.fn(async () => []),
  readFile: vi.fn(async () => new Uint8Array()),
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  stat: vi.fn(async () => defaultStat),
  watchImmediate: vi.fn(async (_paths: string[], _callback: WatchCallback) => vi.fn())
}))

import type { DirEntry } from '@tauri-apps/plugin-fs'
import {
  mkdir,
  open,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  stat,
  watchImmediate,
  writeTextFile
} from '@tauri-apps/plugin-fs'
import { _resetFilesystemStateForTesting, tauriFilesystemApi } from '../tauri-filesystem-api'

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
    vi.mocked(open).mockResolvedValue({
      read: vi.fn(async () => 0),
      close: vi.fn(async () => {})
    } as never)
    vi.mocked(readDir).mockResolvedValue([])
    vi.mocked(readFile).mockResolvedValue(new Uint8Array())
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
    it('should successfully read directory entries with folders-first sorting', async () => {
      const mockEntries: DirEntry[] = [
        {
          name: 'file1.txt',
          isDirectory: false,
          isFile: true,
          isSymlink: false
        },
        { name: 'dir1', isDirectory: true, isFile: false, isSymlink: false }
      ]
      vi.mocked(readDir).mockResolvedValue(mockEntries)

      const result = await tauriFilesystemApi.readDirectory('/test')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(2)
        // Directories come first with folders-first sorting
        expect(result.data![0].name).toBe('dir1')
        expect(result.data![0].type).toBe('directory')
        expect(result.data![1].name).toBe('file1.txt')
        expect(result.data![1].type).toBe('file')
      }
    })

    it('should flag ALWAYS_IGNORE patterns as ignored but still include them', async () => {
      const mockEntries: DirEntry[] = [
        {
          name: 'file1.txt',
          isDirectory: false,
          isFile: true,
          isSymlink: false
        },
        { name: 'src', isDirectory: true, isFile: false, isSymlink: false },
        {
          name: 'node_modules',
          isDirectory: true,
          isFile: false,
          isSymlink: false
        },
        { name: '.git', isDirectory: true, isFile: false, isSymlink: false },
        { name: 'dist', isDirectory: true, isFile: false, isSymlink: false }
      ]
      vi.mocked(readDir).mockResolvedValue(mockEntries)

      const result = await tauriFilesystemApi.readDirectory('/test')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(5)
        const byName = Object.fromEntries(result.data!.map((e) => [e.name, e]))
        // Ignored entries are flagged, not removed
        expect(byName.node_modules.ignored).toBe(true)
        expect(byName['.git'].ignored).toBe(true)
        expect(byName.dist.ignored).toBe(true)
        // Non-ignored entries are not flagged
        expect(byName.src.ignored).toBe(false)
        expect(byName['file1.txt'].ignored).toBe(false)
        // Non-ignored directory sorts before ignored directories
        expect(result.data![0].name).toBe('src')
        // Ignored directories still precede files
        expect(result.data!.map((e) => e.name)).toEqual([
          'src',
          '.git',
          'dist',
          'node_modules',
          'file1.txt'
        ])
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
      const close = vi.fn(async () => {})
      vi.mocked(stat).mockResolvedValue(makeFileInfo({ size: 2048, mtime: testDate }))
      vi.mocked(open).mockResolvedValue({
        read: vi.fn(async (buffer: Uint8Array) => {
          buffer.set(new TextEncoder().encode('some content'))
          return 12
        }),
        close
      } as never)

      const result = await tauriFilesystemApi.getFileInfo('/test/file.txt')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.size).toBe(2048)
        expect(result.data.path).toBe('/test/file.txt')
        expect(result.data.type).toBe('file')
        expect(result.data.isReadOnly).toBe(false)
        expect(result.data.isBinary).toBe(false)
      }
      expect(open).toHaveBeenCalledWith('/test/file.txt', { read: true })
      expect(close).toHaveBeenCalled()
      expect(readTextFile).not.toHaveBeenCalled()
    })

    it('should not read directory contents when returning directory metadata', async () => {
      const testDate = new Date('2024-01-01T00:00:00Z')
      vi.mocked(stat).mockResolvedValue(
        makeFileInfo({ isFile: false, isDirectory: true, size: 0, mtime: testDate })
      )

      const result = await tauriFilesystemApi.getFileInfo('/test/folder')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('directory')
        expect(result.data.isBinary).toBe(false)
      }
      expect(open).not.toHaveBeenCalled()
      expect(readTextFile).not.toHaveBeenCalled()
    })

    it('should detect binary files from a bounded byte sample', async () => {
      const testDate = new Date('2024-01-01T00:00:00Z')
      const close = vi.fn(async () => {})
      vi.mocked(stat).mockResolvedValue(makeFileInfo({ size: 10, mtime: testDate }))
      vi.mocked(open).mockResolvedValue({
        read: vi.fn(async (buffer: Uint8Array) => {
          buffer.set(new Uint8Array([72, 101, 108, 108, 111, 0, 87, 111, 114, 108, 100]))
          return 11
        }),
        close
      } as never)

      const result = await tauriFilesystemApi.getFileInfo('/test/binary.bin')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.isBinary).toBe(true)
      }
      expect(open).toHaveBeenCalledWith('/test/binary.bin', { read: true })
      expect(close).toHaveBeenCalled()
      expect(readTextFile).not.toHaveBeenCalled()
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
      expect(vi.mocked(mkdir)).toHaveBeenCalledWith('/test/new-dir', {
        recursive: true
      })
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

  describe('deletePath', () => {
    it('should successfully delete file', async () => {
      const result = await tauriFilesystemApi.deletePath('/test/file.txt')

      expect(result.success).toBe(true)
      expect(vi.mocked(remove)).toHaveBeenCalledWith('/test/file.txt', {
        recursive: false
      })
    })

    it('should recursively delete directory', async () => {
      const result = await tauriFilesystemApi.deletePath('/test/folder', {
        recursive: true
      })

      expect(result.success).toBe(true)
      expect(vi.mocked(remove)).toHaveBeenCalledWith('/test/folder', {
        recursive: true
      })
    })

    it('should handle errors', async () => {
      vi.mocked(remove).mockRejectedValue(new Error('Delete failed'))

      const result = await tauriFilesystemApi.deletePath('/test/file.txt')

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

      await tauriFilesystemApi.watchDirectory('/test')
      const result = await tauriFilesystemApi.watchDirectory('/test')

      expect(result.success).toBe(true)
      expect(vi.mocked(watchImmediate)).toHaveBeenCalledTimes(1)
    })
  })

  describe('unwatchDirectory', () => {
    it('should successfully unwatch directory', async () => {
      const mockUnlisten = vi.fn()
      vi.mocked(watchImmediate).mockResolvedValue(mockUnlisten)

      await tauriFilesystemApi.watchDirectory('/test')
      const result = await tauriFilesystemApi.unwatchDirectory('/test')

      expect(result.success).toBe(true)
      expect(mockUnlisten).toHaveBeenCalled()
    })

    it('should handle unwatching non-watched directory gracefully', async () => {
      const result = await tauriFilesystemApi.unwatchDirectory('/non-existent')

      expect(result.success).toBe(true)
    })

    it('should handle errors', async () => {
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
      const cleanupFirst = tauriFilesystemApi.onFileChanged(callback)

      const cleanup = tauriFilesystemApi.onFileChanged(callback)
      cleanupFirst()
      cleanup()
    })
  })
})
