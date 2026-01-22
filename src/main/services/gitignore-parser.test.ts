/**
 * Unit tests for Gitignore Parser Service
 *
 * Tests .gitignore parsing, pattern categorization, and security detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseGitignore,
  getRelatedPatterns,
  getSecurityWarnings,
  isSecuritySensitive,
  PATTERN_CATEGORIES
} from './gitignore-parser'

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

// Mock micromatch
vi.mock('micromatch', () => ({
  micromatch: vi.fn((pattern: string, globPattern: string) => {
    // Simple mock implementation for pattern matching
    // This handles basic glob patterns for testing
    const regexPattern = globPattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    return new RegExp(regexPattern).test(pattern)
  }),
}))

describe('Gitignore Parser', () => {
  const mockProjectRoot = '/Users/test/my-project'

  beforeEach(async () => {
    vi.clearAllMocks()
  })

  describe('parseGitignore', () => {
    it('should parse empty .gitignore file', async () => {
      const fs = await import('node:fs/promises')
      vi.mocked(fs.readFile).mockResolvedValue('# Comment\n\n')

      const result = await parseGitignore(mockProjectRoot)

      expect(result.patterns).toHaveLength(0)
      expect(result.groupedPatterns.size).toBe(0)
      expect(result.securityPatterns).toHaveLength(0)
    })

    it('should parse and categorize patterns', async () => {
      const fs = await import('node:fs/promises')
      const gitignoreContent = `# Dependencies
node_modules/

# Build
dist/
build/

# Environment
.env
.env.local

# Cache
.eslintcache
`

      vi.mocked(fs.readFile).mockResolvedValue(gitignoreContent)

      const result = await parseGitignore(mockProjectRoot)

      expect(result.patterns).toHaveLength(6)
      expect(result.groupedPatterns.has('dependencies')).toBe(true)
      expect(result.groupedPatterns.has('build')).toBe(true)
      expect(result.groupedPatterns.has('env')).toBe(true)
      expect(result.groupedPatterns.has('cache')).toBe(true)
    })

    it('should detect security-sensitive patterns', async () => {
      const fs = await import('node:fs/promises')
      const gitignoreContent = `.env
.env.local
*.pem
secrets.*
`

      vi.mocked(fs.readFile).mockResolvedValue(gitignoreContent)

      const result = await parseGitignore(mockProjectRoot)

      expect(result.securityPatterns).toHaveLength(4)
      expect(result.securityPatterns[0].isSecuritySensitive).toBe(true)
    })

    it('should handle missing .gitignore file', async () => {
      const fs = await import('node:fs/promises')
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      vi.mocked(fs.readFile).mockRejectedValue(error)

      const result = await parseGitignore(mockProjectRoot)

      expect(result.patterns).toHaveLength(0)
      expect(result.groupedPatterns.size).toBe(0)
    })

    it('should reject on other errors', async () => {
      const fs = await import('node:fs/promises')
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Permission denied'))

      await expect(parseGitignore(mockProjectRoot)).rejects.toThrow()
    })
  })

  describe('getRelatedPatterns', () => {
    it('should return related patterns for node_modules/', () => {
      const related = getRelatedPatterns('node_modules/')

      expect(related).toContain('package-lock.json')
      expect(related).toContain('yarn.lock')
    })

    it('should return empty array for unknown pattern', () => {
      const related = getRelatedPatterns('unknown-pattern/')

      expect(related).toHaveLength(0)
    })
  })

  describe('getSecurityWarnings', () => {
    it('should detect .env patterns', () => {
      const warnings = getSecurityWarnings(['.env', '.env.local', '*.pem'])

      expect(warnings).toHaveLength(3)
    })

    it('should return empty array for safe patterns', () => {
      const warnings = getSecurityWarnings(['node_modules/', 'dist/', '.cache/'])

      expect(warnings).toHaveLength(0)
    })
  })

  describe('isSecuritySensitive', () => {
    it('should detect .env as sensitive', () => {
      expect(isSecuritySensitive('.env')).toBe(true)
    })

    it('should detect *.pem as sensitive', () => {
      expect(isSecuritySensitive('*.pem')).toBe(true)
    })

    it('should not detect safe patterns as sensitive', () => {
      expect(isSecuritySensitive('node_modules/')).toBe(false)
      expect(isSecuritySensitive('dist/')).toBe(false)
    })
  })
})
