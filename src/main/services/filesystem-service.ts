import { readdir, readFile, stat, writeFile, mkdir, unlink, rename, access, constants, open } from 'fs/promises'
import { join, extname, basename, normalize } from 'path'
import { watch } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type {
  DirectoryEntry,
  FileContent,
  FileInfo,
  FileChangeEvent,
  ReadDirectoryOptions
} from '../../shared/types/filesystem.types'

const MAX_FILE_SIZE = 1 * 1024 * 1024 // 1MB
const BINARY_CHECK_SIZE = 8192

const HARDCODED_IGNORES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.DS_Store',
  'Thumbs.db',
  '.next',
  '.nuxt',
  '__pycache__',
  '.cache'
])

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE)
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0x00) return true
  }
  return false
}

function parseGitignorePatterns(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

function matchesGitignorePattern(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const cleanPattern = pattern.replace(/\/$/, '')
    if (cleanPattern === name) return true
    if (cleanPattern.startsWith('*') && name.endsWith(cleanPattern.slice(1))) return true
    if (cleanPattern.endsWith('*') && name.startsWith(cleanPattern.slice(0, -1))) return true
  }
  return false
}

export type FileChangeCallback = (event: FileChangeEvent) => void

export class FilesystemService {
  private watchers = new Map<string, FSWatcher>()
  private changeCallbacks: FileChangeCallback[] = []

  async readDirectory(
    dirPath: string,
    options?: ReadDirectoryOptions
  ): Promise<DirectoryEntry[]> {
    const normalizedDir = normalize(dirPath)
    const entries = await readdir(normalizedDir, { withFileTypes: true })

    // Load .gitignore patterns from directory
    let gitignorePatterns: string[] = []
    try {
      const gitignoreContent = await readFile(join(normalizedDir, '.gitignore'), 'utf-8')
      gitignorePatterns = parseGitignorePatterns(gitignoreContent)
    } catch {
      // No .gitignore or can't read it
    }

    const results: DirectoryEntry[] = []

    for (const entry of entries) {
      const name = entry.name

      // Skip hardcoded ignores
      if (HARDCODED_IGNORES.has(name)) continue

      // Skip gitignore patterns
      if (matchesGitignorePattern(name, gitignorePatterns)) continue

      const fullPath = join(normalizedDir, name)
      const isDir = entry.isDirectory()

      try {
        const stats = await stat(fullPath)
        results.push({
          name,
          path: normalizePath(fullPath),
          type: isDir ? 'directory' : 'file',
          extension: isDir ? null : extname(name).slice(1) || null,
          size: stats.size,
          modifiedAt: stats.mtimeMs
        })
      } catch {
        // Skip entries we can't stat
      }
    }

    // Sort: directories first, then files, alphabetical
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    return results
  }

  async readFile(filePath: string): Promise<FileContent> {
    const normalizedPath = normalize(filePath)
    const stats = await stat(normalizedPath)

    if (stats.size > MAX_FILE_SIZE) {
      throw new FilesystemError('File too large (>1MB)', 'FILE_TOO_LARGE')
    }

    const buffer = await readFile(normalizedPath)

    if (isBinaryBuffer(buffer)) {
      throw new FilesystemError('Binary file cannot be displayed', 'BINARY_FILE')
    }

    // Detect BOM and encoding
    let content: string
    let encoding = 'utf-8'
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      content = buffer.toString('utf-8').slice(1) // Remove BOM
      encoding = 'utf-8-bom'
    } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      content = buffer.toString('utf16le').slice(1)
      encoding = 'utf-16le'
    } else {
      content = buffer.toString('utf-8')
    }

    return {
      content,
      encoding,
      size: stats.size,
      modifiedAt: stats.mtimeMs
    }
  }

  async getFileInfo(filePath: string): Promise<FileInfo> {
    const normalizedPath = normalize(filePath)
    const stats = await stat(normalizedPath)

    let isReadOnly = false
    try {
      await access(normalizedPath, constants.W_OK)
    } catch {
      isReadOnly = true
    }

    let isBinary = false
    if (stats.isFile() && stats.size > 0) {
      try {
        const fd = await open(normalizedPath, 'r')
        try {
          const buffer = Buffer.alloc(Math.min(stats.size, BINARY_CHECK_SIZE))
          await fd.read(buffer, 0, buffer.length, 0)
          isBinary = isBinaryBuffer(buffer)
        } finally {
          await fd.close()
        }
      } catch {
        // Can't determine, default false
      }
    }

    return {
      path: normalizePath(normalizedPath),
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      isReadOnly,
      isBinary
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const normalizedPath = normalize(filePath)
    await writeFile(normalizedPath, content, 'utf-8')
  }

  async createFile(filePath: string, content?: string): Promise<void> {
    const normalizedPath = normalize(filePath)

    // Check if file already exists
    try {
      await access(normalizedPath)
      throw new FilesystemError('File already exists', 'FILE_EXISTS')
    } catch (err) {
      if (err instanceof FilesystemError) throw err
      // File doesn't exist, good
    }

    // Ensure parent directory exists
    const dir = join(normalizedPath, '..')
    await mkdir(dir, { recursive: true })

    await writeFile(normalizedPath, content ?? '', 'utf-8')
  }

  async createDirectory(dirPath: string): Promise<void> {
    const normalizedPath = normalize(dirPath)
    await mkdir(normalizedPath, { recursive: true })
  }

  async deleteFile(filePath: string): Promise<void> {
    const normalizedPath = normalize(filePath)
    const stats = await stat(normalizedPath)

    if (stats.isDirectory()) {
      // Only delete empty directories
      const entries = await readdir(normalizedPath)
      if (entries.length > 0) {
        throw new FilesystemError('Directory is not empty', 'DELETE_FAILED')
      }
      const { rmdir } = await import('fs/promises')
      await rmdir(normalizedPath)
    } else {
      await unlink(normalizedPath)
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalize(oldPath)
    const normalizedNew = normalize(newPath)
    await rename(normalizedOld, normalizedNew)
  }

  watchDirectory(dirPath: string): void {
    const normalizedPath = normalize(dirPath)

    // Don't watch if already watching
    if (this.watchers.has(normalizedPath)) return

    const watcher = watch(normalizedPath, {
      ignoreInitial: true,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/__pycache__/**',
        '**/.cache/**',
        '**/.DS_Store',
        '**/Thumbs.db'
      ],
      depth: 0
    })

    watcher.on('all', (eventType, filePath) => {
      const event: FileChangeEvent = {
        type: eventType as FileChangeEvent['type'],
        path: normalizePath(filePath)
      }

      for (const callback of this.changeCallbacks) {
        callback(event)
      }
    })

    this.watchers.set(normalizedPath, watcher)
  }

  async unwatchDirectory(dirPath: string): Promise<void> {
    const normalizedPath = normalize(dirPath)
    const watcher = this.watchers.get(normalizedPath)
    if (watcher) {
      await watcher.close()
      this.watchers.delete(normalizedPath)
    }
  }

  onFileChange(callback: FileChangeCallback): () => void {
    this.changeCallbacks.push(callback)
    return () => {
      const index = this.changeCallbacks.indexOf(callback)
      if (index !== -1) this.changeCallbacks.splice(index, 1)
    }
  }

  async destroy(): Promise<void> {
    const closePromises: Promise<void>[] = []
    this.watchers.forEach((watcher) => {
      closePromises.push(watcher.close())
    })
    await Promise.all(closePromises)
    this.watchers.clear()
    this.changeCallbacks = []
  }
}

export class FilesystemError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message)
    this.name = 'FilesystemError'
  }
}

// Singleton
let defaultService: FilesystemService | null = null

export function getDefaultFilesystemService(): FilesystemService {
  if (!defaultService) {
    defaultService = new FilesystemService()
  }
  return defaultService
}

export async function resetDefaultFilesystemService(): Promise<void> {
  if (defaultService) {
    await defaultService.destroy()
    defaultService = null
  }
}
