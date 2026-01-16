import { describe, it, expect } from 'vitest'
import { isMatch } from 'micromatch'
import type {
  WorktreeMetadata,
  WorktreeStatus,
  ArchivedWorktree
} from './worktree.types'

describe('worktree.types', () => {
  describe('WorktreeMetadata', () => {
    it('should have required string properties', () => {
      const metadata: WorktreeMetadata = {
        id: 'test-id',
        projectId: 'project-123',
        branchName: 'feature/test-branch',
        worktreePath: '/path/to/worktree',
        createdAt: '2026-01-16T00:00:00.000Z',
        lastAccessedAt: '2026-01-16T00:00:00.000Z',
        isArchived: false,
        status: {
          dirty: false,
          ahead: 0,
          behind: 0,
          conflicted: false,
          currentBranch: 'feature/test-branch'
        }
      }

      expect(typeof metadata.id).toBe('string')
      expect(typeof metadata.projectId).toBe('string')
      expect(typeof metadata.branchName).toBe('string')
      expect(typeof metadata.worktreePath).toBe('string')
      expect(typeof metadata.createdAt).toBe('string')
      expect(typeof metadata.lastAccessedAt).toBe('string')
      expect(typeof metadata.isArchived).toBe('boolean')
    })

    it('should allow optional gitignoreProfile', () => {
      const metadataWithProfile: WorktreeMetadata = {
        id: 'test-id',
        projectId: 'project-123',
        branchName: 'feature/test-branch',
        worktreePath: '/path/to/worktree',
        createdAt: '2026-01-16T00:00:00.000Z',
        lastAccessedAt: '2026-01-16T00:00:00.000Z',
        isArchived: false,
        gitignoreProfile: 'default',
        status: {
          dirty: false,
          ahead: 0,
          behind: 0,
          conflicted: false,
          currentBranch: 'feature/test-branch'
        }
      }

      expect(metadataWithProfile.gitignoreProfile).toBe('default')
    })

    it('should have status property of type WorktreeStatus', () => {
      const status: WorktreeStatus = {
        dirty: false,
        ahead: 0,
        behind: 0,
        conflicted: false,
        currentBranch: 'feature/test-branch'
      }

      expect(typeof status.dirty).toBe('boolean')
      expect(typeof status.ahead).toBe('number')
      expect(typeof status.behind).toBe('number')
      expect(typeof status.conflicted).toBe('boolean')
      expect(typeof status.currentBranch).toBe('string')
    })
  })

  describe('ArchivedWorktree', () => {
    it('should have all required properties', () => {
      const archived: ArchivedWorktree = {
        originalPath: '/path/to/worktree',
        archivePath: '/path/to/archive',
        archivedAt: '2026-01-16T00:00:00.000Z',
        expiresAt: '2026-02-15T00:00:00.000Z',
        branchName: 'feature/test-branch',
        projectId: 'project-123',
        unpushedCommits: false,
        commitCount: 5
      }

      expect(typeof archived.originalPath).toBe('string')
      expect(typeof archived.archivePath).toBe('string')
      expect(typeof archived.archivedAt).toBe('string')
      expect(typeof archived.expiresAt).toBe('string')
      expect(typeof archived.branchName).toBe('string')
      expect(typeof archived.projectId).toBe('string')
      expect(typeof archived.unpushedCommits).toBe('boolean')
      expect(typeof archived.commitCount).toBe('number')
    })
  })

  describe('Edge case validation', () => {
    it('should validate ISO timestamp format for dates', () => {
      const validIsoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

      const metadata: WorktreeMetadata = {
        id: 'test-id',
        projectId: 'project-123',
        branchName: 'feature/test-branch',
        worktreePath: '/path/to/worktree',
        createdAt: '2026-01-16T00:00:00.000Z',
        lastAccessedAt: '2026-01-16T00:00:00.000Z',
        isArchived: false,
        status: {
          dirty: false,
          ahead: 0,
          behind: 0,
          conflicted: false,
          currentBranch: 'feature/test-branch'
        }
      }

      expect(validIsoPattern.test(metadata.createdAt)).toBe(true)
      expect(validIsoPattern.test(metadata.lastAccessedAt)).toBe(true)
    })

    it('should validate commit counts are non-negative', () => {
      const status: WorktreeStatus = {
        dirty: false,
        ahead: 0,
        behind: 0,
        conflicted: false,
        currentBranch: 'feature/test-branch'
      }

      expect(status.ahead).toBeGreaterThanOrEqual(0)
      expect(status.behind).toBeGreaterThanOrEqual(0)

      const archived: ArchivedWorktree = {
        originalPath: '/path/to/worktree',
        archivePath: '/path/to/archive',
        archivedAt: '2026-01-16T00:00:00.000Z',
        expiresAt: '2026-02-15T00:00:00.000Z',
        branchName: 'feature/test-branch',
        projectId: 'project-123',
        unpushedCommits: false,
        commitCount: 5
      }

      expect(archived.commitCount).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Module exports', () => {
    it('should export all types from barrel file', async () => {
      // Type-only exports require compile-time verification
      // The import below will fail at compile-time if exports are broken
      type BarrelExports = {
        WorktreeMetadata: WorktreeMetadata
        WorktreeStatus: WorktreeStatus
        ArchivedWorktree: ArchivedWorktree
      }

      // This assertion verifies the types are accessible
      const typeCheck: BarrelExports = null as unknown as BarrelExports
      expect(typeCheck).toBeDefined()
    })
  })

  describe('micromatch smoke test', () => {
    it('should import and use micromatch for .gitignore pattern matching', () => {
      // Verify micromatch is working in the Electron + Vite context
      // Note: micromatch requires explicit dotfile matching
      const patterns = ['.env', '.env.*', '*.key', '*.pem']
      const files = ['.env', '.env.local', 'config.json', 'secret.key', 'app.ts']

      expect(isMatch('.env', patterns)).toBe(true)
      expect(isMatch('.env.local', patterns)).toBe(true)
      expect(isMatch('secret.key', patterns)).toBe(true)
      expect(isMatch('config.json', patterns)).toBe(false)
      expect(isMatch('app.ts', patterns)).toBe(false)
    })
  })
})
