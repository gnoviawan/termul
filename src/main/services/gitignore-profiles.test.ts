/**
 * Unit tests for Gitignore Profile Storage Service
 *
 * Tests profile CRUD operations, persistence, and import/export.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GitignoreProfileManager, createProfileManager } from './gitignore-profiles'

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

// Mock node:path
vi.mock('node:path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
}))

describe('GitignoreProfileManager', () => {
  let profileManager: GitignoreProfileManager
  let mockFs: any
  const mockProjectRoot = '/Users/test/my-project'

  beforeEach(async () => {
    vi.clearAllMocks()

    // Initialize profile manager
    profileManager = new GitignoreProfileManager(mockProjectRoot)

    // Get mocked fs module
    const fs = await import('node:fs/promises')
    mockFs = vi.mocked(fs)

    // Default mock implementations
    vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: [] }))
    vi.mocked(mockFs.mkdir).mockResolvedValue(undefined)
    vi.mocked(mockFs.writeFile).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('saveProfile', () => {
    it('should save a new profile', async () => {
      const profileName = 'frontend-basic'
      const patterns = ['node_modules/', 'dist/', '.env']

      await profileManager.saveProfile(profileName, patterns)

      expect(mockFs.mkdir).toHaveBeenCalled()
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('gitignore-profiles.json'),
        expect.stringContaining('"name": "frontend-basic"'),
        'utf-8'
      )
    })

    it('should reject duplicate profile names', async () => {
      const profileName = 'frontend-basic'
      const patterns = ['node_modules/']

      // Mock existing profile
      vi.mocked(mockFs.readFile).mockResolvedValue(
        JSON.stringify({
          profiles: [{ name: profileName, patterns: ['node_modules/'], createdAt: new Date().toISOString() }],
        })
      )

      await expect(profileManager.saveProfile(profileName, patterns)).rejects.toThrow('already exists')
    })

    it('should create profiles directory if it does not exist', async () => {
      const profileName = 'test-profile'
      const patterns = ['*.log']

      await profileManager.saveProfile(profileName, patterns)

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('.termul/profiles'),
        { recursive: true }
      )
    })
  })

  describe('loadProfiles', () => {
    it('should return empty array when no profiles exist', async () => {
      // Mock file not found
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      vi.mocked(mockFs.readFile).mockRejectedValue(error)

      const profiles = await profileManager.loadProfiles()

      expect(profiles).toEqual([])
    })

    it('should load all saved profiles', async () => {
      const existingProfiles = [
        { name: 'frontend', patterns: ['node_modules/'], createdAt: '2024-01-01T00:00:00.000Z' },
        { name: 'python', patterns: ['__pycache__/', '*.pyc'], createdAt: '2024-01-02T00:00:00.000Z' },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      const profiles = await profileManager.loadProfiles()

      expect(profiles).toHaveLength(2)
      expect(profiles[0].name).toBe('frontend')
      expect(profiles[1].name).toBe('python')
    })

    it('should return profiles in correct order', async () => {
      const existingProfiles = [
        { name: 'profile-1', patterns: ['pattern1'], createdAt: '2024-01-01T00:00:00.000Z' },
        { name: 'profile-2', patterns: ['pattern2'], createdAt: '2024-01-02T00:00:00.000Z' },
        { name: 'profile-3', patterns: ['pattern3'], createdAt: '2024-01-03T00:00:00.000Z' },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      const profiles = await profileManager.loadProfiles()

      expect(profiles).toHaveLength(3)
      expect(profiles[0].name).toBe('profile-1')
      expect(profiles[1].name).toBe('profile-2')
      expect(profiles[2].name).toBe('profile-3')
    })
  })

  describe('deleteProfile', () => {
    it('should delete an existing profile', async () => {
      const existingProfiles = [
        { name: 'frontend', patterns: ['node_modules/'], createdAt: '2024-01-01T00:00:00.000Z' },
        { name: 'python', patterns: ['__pycache__/'], createdAt: '2024-01-02T00:00:00.000Z' },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      await profileManager.deleteProfile('frontend')

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"python"'),
        'utf-8'
      )
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('"frontend"'),
        'utf-8'
      )
    })

    it('should throw error when deleting non-existent profile', async () => {
      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: [] }))

      await expect(profileManager.deleteProfile('non-existent')).rejects.toThrow('not found')
    })
  })

  describe('getProfile', () => {
    it('should return profile when found', async () => {
      const existingProfiles = [
        { name: 'frontend', patterns: ['node_modules/'], createdAt: '2024-01-01T00:00:00.000Z' },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      const profile = await profileManager.getProfile('frontend')

      expect(profile).toBeDefined()
      expect(profile?.name).toBe('frontend')
      expect(profile?.patterns).toEqual(['node_modules/'])
    })

    it('should return undefined when profile not found', async () => {
      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: [] }))

      const profile = await profileManager.getProfile('non-existent')

      expect(profile).toBeUndefined()
    })
  })

  describe('updateProfile', () => {
    it('should update an existing profile', async () => {
      const existingProfiles = [
        { name: 'frontend', patterns: ['node_modules/'], createdAt: '2024-01-01T00:00:00.000Z' },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      const newPatterns = ['node_modules/', 'dist/', '.env']
      await profileManager.updateProfile('frontend', newPatterns)

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"dist/"'),
        'utf-8'
      )
    })

    it('should preserve createdAt timestamp when updating', async () => {
      const originalTimestamp = '2024-01-01T00:00:00.000Z'
      const existingProfiles = [
        { name: 'frontend', patterns: ['node_modules/'], createdAt: originalTimestamp },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      await profileManager.updateProfile('frontend', ['dist/'])

      const writtenData = vi.mocked(mockFs.writeFile).mock.calls[0][1] as string
      const savedProfiles = JSON.parse(writtenData)

      expect(savedProfiles.profiles[0].createdAt).toBe(originalTimestamp)
    })

    it('should throw error when updating non-existent profile', async () => {
      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: [] }))

      await expect(profileManager.updateProfile('non-existent', ['patterns'])).rejects.toThrow('not found')
    })
  })

  describe('exportProfiles', () => {
    it('should export profiles as JSON string', async () => {
      const existingProfiles = [
        { name: 'frontend', patterns: ['node_modules/'], createdAt: '2024-01-01T00:00:00.000Z' },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      const exported = await profileManager.exportProfiles()

      expect(exported).toContain('"frontend"')
      expect(exported).toContain('"node_modules/"')
    })

    it('should export empty array when no profiles exist', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      vi.mocked(mockFs.readFile).mockRejectedValue(error)

      const exported = await profileManager.exportProfiles()

      expect(exported).toContain('"profiles": []')
    })
  })

  describe('importProfiles', () => {
    it('should import profiles from JSON string', async () => {
      const importData = {
        profiles: [
          { name: 'imported', patterns: ['*.log'], createdAt: '2024-01-01T00:00:00.000Z' },
        ],
      }

      await profileManager.importProfiles(JSON.stringify(importData))

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"imported"'),
        'utf-8'
      )
    })

    it('should merge profiles when merge option is true', async () => {
      const existingProfiles = [
        { name: 'existing', patterns: ['node_modules/'], createdAt: '2024-01-01T00:00:00.000Z' },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      const importData = {
        profiles: [
          { name: 'imported', patterns: ['*.log'], createdAt: '2024-01-02T00:00:00.000Z' },
        ],
      }

      await profileManager.importProfiles(JSON.stringify(importData), true)

      const writtenData = vi.mocked(mockFs.writeFile).mock.calls[0][1] as string
      const savedProfiles = JSON.parse(writtenData)

      expect(savedProfiles.profiles).toHaveLength(2)
      expect(savedProfiles.profiles.some((p: any) => p.name === 'existing')).toBe(true)
      expect(savedProfiles.profiles.some((p: any) => p.name === 'imported')).toBe(true)
    })

    it('should replace profiles when merge option is false', async () => {
      const existingProfiles = [
        { name: 'existing', patterns: ['node_modules/'], createdAt: '2024-01-01T00:00:00.000Z' },
      ]

      vi.mocked(mockFs.readFile).mockResolvedValue(JSON.stringify({ profiles: existingProfiles }))

      const importData = {
        profiles: [
          { name: 'imported', patterns: ['*.log'], createdAt: '2024-01-02T00:00:00.000Z' },
        ],
      }

      await profileManager.importProfiles(JSON.stringify(importData), false)

      const writtenData = vi.mocked(mockFs.writeFile).mock.calls[0][1] as string
      const savedProfiles = JSON.parse(writtenData)

      expect(savedProfiles.profiles).toHaveLength(1)
      expect(savedProfiles.profiles[0].name).toBe('imported')
    })

    it('should throw error on invalid JSON', async () => {
      await expect(profileManager.importProfiles('invalid json')).rejects.toThrow()
    })

    it('should throw error on invalid data structure', async () => {
      const invalidData = { invalid: 'data' }

      await expect(profileManager.importProfiles(JSON.stringify(invalidData))).rejects.toThrow('missing profiles array')
    })
  })

  describe('createProfileManager', () => {
    it('should create a GitignoreProfileManager instance', () => {
      const manager = createProfileManager(mockProjectRoot)

      expect(manager).toBeInstanceOf(GitignoreProfileManager)
    })
  })
})
