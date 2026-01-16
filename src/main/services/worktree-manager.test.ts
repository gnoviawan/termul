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
import type { WorktreeMetadata, WorktreeStatus, ArchivedWorktree } from '../../renderer/src/features/worktrees/worktree.types'
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
      // Worktree ID format: projectId-branchName-timestamp
      // getWorktreePathById extracts: parts.slice(1, -1).join('-')
      // For 'project-123-feature-test-12345' -> '123-feature-test'
      const worktreeId = 'project-123-feature-test-12345'
      const worktreePath = `${mockProjectRoot}/.termul/worktrees/123-feature-test`
      const worktreeGit = simpleGit(worktreePath)

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
      const worktreeId = 'project-123-feature-test-12345'
      const worktreePath = `${mockProjectRoot}/.termul/worktrees/123-feature-test`
      const worktreeGit = simpleGit(worktreePath)

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
})
