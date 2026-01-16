/**
 * Unit tests for WorktreeManager service
 *
 * Tests follow red-green-refactor cycle:
 * 1. Write failing test first
 * 2. Implement minimal code to pass
 * 3. Refactor while keeping tests green
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorktreeManager } from './worktree-manager'
import type { WorktreeMetadata, WorktreeStatus, ArchivedWorktree } from '../../shared/types/ipc.types'

import simpleGit from 'simple-git'

// Store mock instances for test control
const mockGitInstances = new Map<string, any>()

// Mock simple-git factory
vi.mock('simple-git', () => ({
  default: vi.fn((path?: string) => {
    const key = path || 'default'
    if (!mockGitInstances.has(key)) {
      mockGitInstances.set(key, {
        version: vi.fn(),
        worktreeAdd: vi.fn(),
        worktreeList: vi.fn(),
        worktreeRemove: vi.fn(),
        status: vi.fn(),
        raw: vi.fn(),
      })
    }
    return mockGitInstances.get(key)
  }),
}))

// Mock glob module
vi.mock('glob', () => ({
  glob: vi.fn(),
}))

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  stat: vi.fn(),
  statfs: vi.fn(),
  readdir: vi.fn(),
}))

// Mock node:path
vi.mock('node:path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
}))

describe('WorktreeManager', () => {
  let worktreeManager: WorktreeManager
  let mockGit: any

  const mockProjectRoot = '/Users/test/my-project'
  const mockProjectId = 'project-123'

  beforeEach(() => {
    mockGitInstances.clear()
    mockGit = simpleGit(mockProjectRoot)
    worktreeManager = new WorktreeManager(mockProjectRoot, mockProjectId)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('validateGitVersion', () => {
    it('should validate Git version >= 2.17.0 as valid', async () => {
      mockGit.version.mockResolvedValue({ git: '2.40.0' })

      const result = await worktreeManager.validateGitVersion()

      expect(result.valid).toBe(true)
      expect(result.version).toBe('2.40.0')
      expect(mockGit.version).toHaveBeenCalledTimes(1)
    })

    it('should reject Git version < 2.17.0', async () => {
      mockGit.version.mockResolvedValue({ git: '2.15.0' })

      const result = await worktreeManager.validateGitVersion()

      expect(result.valid).toBe(false)
      expect(result.version).toBe('2.15.0')
    })

    it('should handle version 2.17.0 as valid (boundary)', async () => {
      mockGit.version.mockResolvedValue({ git: '2.17.0' })

      const result = await worktreeManager.validateGitVersion()

      expect(result.valid).toBe(true)
      expect(result.version).toBe('2.17.0')
    })

    it('should parse version strings correctly', async () => {
      const testCases = [
        { version: '2.43.0', expected: true },
        { version: '2.30.1', expected: true },
        { version: '2.17.1', expected: true },
        { version: '2.16.9', expected: false },
        { version: '2.0.0', expected: false },
        { version: '1.9.0', expected: false },
      ]

      for (const testCase of testCases) {
        mockGit.version.mockResolvedValue({ git: testCase.version })
        const result = await worktreeManager.validateGitVersion()
        expect(result.valid).toBe(testCase.expected)
      }
    })

    it('should handle Git command errors gracefully', async () => {
      mockGit.version.mockRejectedValue(new Error('Git not found'))

      await expect(worktreeManager.validateGitVersion()).rejects.toThrow()
    })
  })

  describe('sanitizeBranchName', () => {
    it('should sanitize branch names for folder usage', () => {
      const testCases = [
        { input: 'feature/auth', expected: 'feature-auth' },
        { input: 'hotfix/bug-123', expected: 'hotfix-bug-123' },
        { input: 'release/v1.2.3', expected: 'release-v1-2-3' },
        { input: 'main', expected: 'main' },
        { input: 'develop', expected: 'develop' },
      ]

      for (const testCase of testCases) {
        const result = (worktreeManager as any).sanitizeBranchName(testCase.input)
        expect(result).toBe(testCase.expected)
      }
    })

    it('should handle Windows MAX_PATH by limiting to 50 chars', () => {
      const longBranch = 'feature/very-long-branch-name-that-exceeds-fifty-characters-limit'
      const result = (worktreeManager as any).sanitizeBranchName(longBranch)
      expect(result.length).toBeLessThanOrEqual(50)
    })

    it('should remove special characters', () => {
      const testCases = [
        { input: 'feature@test#1', expected: 'feature-test-1' },
        { input: 'bugfix$%^fix', expected: 'bugfix-fix' },
        { input: 'branch&name', expected: 'branch-name' },
      ]

      for (const testCase of testCases) {
        const result = (worktreeManager as any).sanitizeBranchName(testCase.input)
        expect(result).toBe(testCase.expected)
      }
    })
  })

  describe('generateWorktreePath', () => {
    it('should generate correct worktree path', () => {
      const sanitizedBranch = 'feature-auth'
      const result = (worktreeManager as any).generateWorktreePath(sanitizedBranch)

      expect(result).toContain('.termul/worktrees')
      expect(result).toContain('feature-auth')
    })

    it('should use project root from constructor', () => {
      const sanitizedBranch = 'test-branch'
      const result = (worktreeManager as any).generateWorktreePath(sanitizedBranch)

      expect(result).toContain(mockProjectRoot)
    })
  })

  describe('create', () => {
    it('should create worktree with valid branch', async () => {
      const branchName = 'feature/test'
      const options = {
        projectId: mockProjectId,
        branchName,
        gitignoreSelections: ['node_modules/', '.env'],
      }

      mockGit.worktreeAdd.mockResolvedValue(undefined)
      mockGit.version.mockResolvedValue({ git: '2.40.0' })

      const result = await worktreeManager.create(options)

      expect(result).toMatchObject({
        projectId: mockProjectId,
        branchName,
        isArchived: false,
      })
      expect(mockGit.worktreeAdd).toHaveBeenCalledTimes(1)
      expect(result.id).toBeDefined()
      expect(result.createdAt).toBeDefined()
    })

    it('should sanitize branch name for path generation', async () => {
      const branchName = 'feature/auth-test'
      const options = {
        projectId: mockProjectId,
        branchName,
        gitignoreSelections: [],
      }

      mockGit.worktreeAdd.mockResolvedValue(undefined)
      mockGit.version.mockResolvedValue({ git: '2.40.0' })

      await worktreeManager.create(options)

      const worktreePath = mockGit.worktreeAdd.mock.calls[0][0]
      expect(worktreePath).toContain('feature-auth-test')
      // Path can contain forward slashes (Git accepts them on all platforms)
      expect(worktreePath).toContain('.termul/worktrees')
    })

    it('should throw error for Git version too old', async () => {
      mockGit.version.mockResolvedValue({ git: '2.15.0' })

      const options = {
        projectId: mockProjectId,
        branchName: 'feature/test',
        gitignoreSelections: [],
      }

      await expect(worktreeManager.create(options)).rejects.toThrow('Git version')
    })

    it('should handle worktree add failures', async () => {
      mockGit.version.mockResolvedValue({ git: '2.40.0' })
      mockGit.worktreeAdd.mockRejectedValue(new Error('Branch not found'))

      const options = {
        projectId: mockProjectId,
        branchName: 'nonexistent-branch',
        gitignoreSelections: [],
      }

      await expect(worktreeManager.create(options)).rejects.toThrow()
    })
  })

  describe('list', () => {
    it('should list all worktrees for project', async () => {
      const mockWorktrees = {
        all: [
          { branch: 'feature-test', path: '/project/.termul/worktrees/feature-test' },
          { branch: 'main', path: '/project' },
        ],
      }

      mockGit.worktreeList.mockResolvedValue(mockWorktrees)

      const result = await worktreeManager.list(mockProjectId)

      expect(result).toBeInstanceOf(Array)
      expect(mockGit.worktreeList).toHaveBeenCalledTimes(1)
    })
  })

  describe('getStatus', () => {
    it('should return worktree status with all fields', async () => {
      // Worktree ID format: projectId-branchName
      // getWorktreePathById extracts: parts.slice(1).join('-')
      // For 'project-123-feature-test' -> '123-feature-test'
      const worktreeId = 'project-123-feature-test'
      const worktreePath = `${mockProjectRoot}/.termul/worktrees/123-feature-test`
      const worktreeGit = simpleGit(worktreePath) as unknown as { status: ReturnType<typeof vi.fn> }


      const mockStatus = {
        files: [],
        created: 0,
        modified: 0,
        deleted: 0,
        conflicted: 0,
        ahead: 5,
        behind: 0,
        current: 'feature-test',
        tracking: 'origin/feature-test',
      }

      worktreeGit.status.mockResolvedValue(mockStatus)

      const result = await worktreeManager.getStatus(worktreeId)

      expect(result).toMatchObject({
        dirty: false,
        ahead: 5,
        behind: 0,
        conflicted: false,
        currentBranch: 'feature-test',
      })
    })

    it('should detect dirty status when files modified', async () => {
      const worktreeId = 'project-123-feature-test'
      const worktreePath = `${mockProjectRoot}/.termul/worktrees/123-feature-test`
      const worktreeGit = simpleGit(worktreePath) as unknown as { status: ReturnType<typeof vi.fn> }


      const mockStatus = {
        files: [{ path: 'test.ts', index: 'M', working_dir: 'M' }],
        created: 0,
        modified: 1,
        deleted: 0,
        conflicted: 0,
        ahead: 0,
        behind: 0,
        current: 'feature-test',
      }

      worktreeGit.status.mockResolvedValue(mockStatus)

      const result = await worktreeManager.getStatus(worktreeId)

      expect(result.dirty).toBe(true)
    })
  })

  describe('copyGitignoreFiles', () => {
    it('should copy files matching .gitignore patterns to worktree', async () => {
      // @ts-expect-error glob types not available in node tsconfig
      const { glob } = await import('glob')
      const fs = await import('node:fs/promises')


      const worktreePath = '/Users/test/my-project/.termul/worktrees/test'
      const patterns = ['node_modules/', '.env']

      // Mock glob to return matching files
      vi.mocked(glob).mockResolvedValue(['package.json', 'package-lock.json'])

      // Mock fs operations
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.copyFile).mockResolvedValue(undefined)

      await worktreeManager.copyGitignoreFiles(worktreePath, patterns)

      expect(glob).toHaveBeenCalledTimes(2) // Once per pattern
      expect(fs.copyFile).toHaveBeenCalled()
    })

    it('should throw WorktreeError with FILE_COPY_FAILED code on error', async () => {
      // @ts-expect-error glob types not available in node tsconfig
      const { glob } = await import('glob')

      const worktreePath = '/Users/test/my-project/.termul/worktrees/test'
      const patterns = ['node_modules/']

      // Mock glob to throw error
      vi.mocked(glob).mockRejectedValue(new Error('Permission denied'))

      try {
        await worktreeManager.copyGitignoreFiles(worktreePath, patterns)
        expect.fail('Should have thrown WorktreeError')
      } catch (error) {
        expect(error).toHaveProperty('code', 'FILE_COPY_FAILED')
      }
    })
  })

  describe('validateDiskSpace', () => {
    it('should pass when sufficient disk space available', async () => {
      const fs = await import('node:fs/promises')

      // Mock statfs to return 1GB available
      vi.mocked(fs.statfs).mockResolvedValue({
        bavail: 1000000,
        bsize: 1024,
      } as any)

      const requiredSpace = 100 * 1024 * 1024 // 100MB

      await expect(worktreeManager.validateDiskSpace(requiredSpace)).resolves.not.toThrow()
      expect(fs.statfs).toHaveBeenCalledWith(mockProjectRoot)
    })

    it('should throw INSUFFICIENT_DISK_SPACE when not enough space', async () => {
      const fs = await import('node:fs/promises')

      // Mock statfs to return only 100MB available
      vi.mocked(fs.statfs).mockResolvedValue({
        bavail: 100000,
        bsize: 1024,
      } as any)

      const requiredSpace = 500 * 1024 * 1024 // 500MB

      try {
        await worktreeManager.validateDiskSpace(requiredSpace)
        expect.fail('Should have thrown WorktreeError')
      } catch (error) {
        expect(error).toHaveProperty('code', 'INSUFFICIENT_DISK_SPACE')
      }
    })

    it('should use custom buffer when provided', async () => {
      const fs = await import('node:fs/promises')

      // Mock statfs to return 800MB available (enough for 100MB required + 500MB buffer)
      vi.mocked(fs.statfs).mockResolvedValue({
        bavail: 800000,
        bsize: 1024,
      } as any)

      const requiredSpace = 100 * 1024 * 1024 // 100MB
      const customBuffer = 500 * 1024 * 1024 // 500MB buffer

      await expect(worktreeManager.validateDiskSpace(requiredSpace, customBuffer)).resolves.not.toThrow()
    })
  })

  describe('calculateProjectSize', () => {
    it('should calculate total project size excluding .git and .termul', async () => {
      const fs = await import('node:fs/promises')

      // Create a mock Dirent factory
      const createMockDirent = (name: string, isDir: boolean) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      })

      // Mock readdir to return directory entries
      vi.mocked(fs.readdir).mockImplementation(async (dirPath: any, options?: any) => {
        if (dirPath === mockProjectRoot) {

          return [
            createMockDirent('.git', true),
            createMockDirent('.termul', true),
            createMockDirent('src', true),
            createMockDirent('package.json', false),
          ] as any
        }
        if (String(dirPath).endsWith('src')) {
          return [
            createMockDirent('index.ts', false),
            createMockDirent('utils.ts', false),
          ] as any
        }
        return [] as any
      })

      // Mock stat to return file sizes
      vi.mocked(fs.stat).mockImplementation(async (filePath: any) => {
        if (String(filePath).endsWith('package.json')) {

          return { size: 1024 } as any
        }
        if (String(filePath).endsWith('index.ts')) {
          return { size: 2048 } as any
        }
        if (String(filePath).endsWith('utils.ts')) {
          return { size: 512 } as any
        }
        return { size: 0 } as any
      })

      const size = await worktreeManager.calculateProjectSize()

      // Should include package.json (1024) + index.ts (2048) + utils.ts (512) = 3584
      // Should exclude .git and .termul directories
      expect(size).toBe(3584)
      expect(fs.readdir).toHaveBeenCalled()
    })
  })
})
