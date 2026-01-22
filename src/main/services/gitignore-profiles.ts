/**
 * Gitignore Profile Storage Service
 *
 * Manages persistent storage for .gitignore pattern profiles.
 * Profiles allow users to save and reuse common pattern selections.
 *
 * Source: Story 1.4 - Task 3: Gitignore Profile Storage
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Gitignore profile data structure
 */
export interface GitignoreProfile {
  name: string
  patterns: string[]
  createdAt: string
}

/**
 * Profile storage data structure
 */
interface ProfileStorage {
  profiles: GitignoreProfile[]
}

/**
 * Default profiles storage location
 */
const DEFAULT_PROFILES_DIR = '.termul/profiles'
const PROFILES_FILE = 'gitignore-profiles.json'

/**
 * Gitignore Profile Manager
 *
 * Manages CRUD operations for .gitignore pattern profiles.
 * Profiles are stored in JSON format at .termul/profiles/gitignore-profiles.json
 */
export class GitignoreProfileManager {
  private readonly projectRoot: string
  private readonly profilesPath: string

  /**
   * Create a new GitignoreProfileManager instance
   *
   * @param projectRoot - Absolute path to the Git repository root
   */
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
    this.profilesPath = path.join(projectRoot, DEFAULT_PROFILES_DIR, PROFILES_FILE)
  }

  /**
   * Save a new profile
   *
   * @param name - Profile name
   * @param patterns - Array of .gitignore patterns
   * @throws Error if profile with same name exists or save fails
   */
  async saveProfile(name: string, patterns: string[]): Promise<void> {
    const storage = await this.loadStorage()

    // Check for duplicate profile names
    if (storage.profiles.some(p => p.name === name)) {
      throw new Error(`Profile "${name}" already exists`)
    }

    // Add new profile
    const newProfile: GitignoreProfile = {
      name,
      patterns,
      createdAt: new Date().toISOString(),
    }

    storage.profiles.push(newProfile)
    await this.saveStorage(storage)
  }

  /**
   * Load all profiles
   *
   * @returns Array of all saved profiles
   */
  async loadProfiles(): Promise<GitignoreProfile[]> {
    const storage = await this.loadStorage()
    return storage.profiles
  }

  /**
   * Delete a profile by name
   *
   * @param name - Profile name to delete
   * @throws Error if profile not found or delete fails
   */
  async deleteProfile(name: string): Promise<void> {
    const storage = await this.loadStorage()

    // Filter out the profile to delete
    const filteredProfiles = storage.profiles.filter(p => p.name !== name)

    // Check if profile was found
    if (filteredProfiles.length === storage.profiles.length) {
      throw new Error(`Profile "${name}" not found`)
    }

    storage.profiles = filteredProfiles
    await this.saveStorage(storage)
  }

  /**
   * Get a single profile by name
   *
   * @param name - Profile name
   * @returns Profile if found, undefined otherwise
   */
  async getProfile(name: string): Promise<GitignoreProfile | undefined> {
    const storage = await this.loadStorage()
    return storage.profiles.find(p => p.name === name)
  }

  /**
   * Update an existing profile
   *
   * @param name - Profile name to update
   * @param patterns - New patterns array
   * @throws Error if profile not found or update fails
   */
  async updateProfile(name: string, patterns: string[]): Promise<void> {
    const storage = await this.loadStorage()

    const profileIndex = storage.profiles.findIndex(p => p.name === name)
    if (profileIndex === -1) {
      throw new Error(`Profile "${name}" not found`)
    }

    // Update profile while preserving createdAt
    storage.profiles[profileIndex].patterns = patterns
    await this.saveStorage(storage)
  }

  /**
   * Load storage from disk
   *
   * @returns Profile storage data
   */
  private async loadStorage(): Promise<ProfileStorage> {
    try {
      const content = await fs.readFile(this.profilesPath, 'utf-8')
      return JSON.parse(content) as ProfileStorage
    } catch (error) {
      // If file doesn't exist, return empty storage
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { profiles: [] }
      }
      throw error
    }
  }

  /**
   * Save storage to disk
   *
   * @param storage - Profile storage data to save
   */
  private async saveStorage(storage: ProfileStorage): Promise<void> {
    // Ensure profiles directory exists
    const profilesDir = path.dirname(this.profilesPath)
    await fs.mkdir(profilesDir, { recursive: true })

    // Write storage to file
    await fs.writeFile(this.profilesPath, JSON.stringify(storage, null, 2), 'utf-8')
  }

  /**
   * Export profiles to JSON string
   *
   * @returns JSON string representation of all profiles
   */
  async exportProfiles(): Promise<string> {
    const storage = await this.loadStorage()
    return JSON.stringify(storage, null, 2)
  }

  /**
   * Import profiles from JSON string
   *
   * @param jsonString - JSON string to import
   * @param merge - Whether to merge with existing profiles (default: false)
   * @throws Error if JSON is invalid
   */
  async importProfiles(jsonString: string, merge: boolean = false): Promise<void> {
    const imported = JSON.parse(jsonString) as ProfileStorage

    // Validate imported data
    if (!Array.isArray(imported?.profiles)) {
      throw new Error('Invalid profiles data: missing profiles array')
    }

    if (merge) {
      // Merge with existing profiles
      const storage = await this.loadStorage()
      const existingNames = new Set(storage.profiles.map(p => p.name))

      for (const profile of imported.profiles) {
        if (!existingNames.has(profile.name)) {
          storage.profiles.push(profile)
        }
      }

      await this.saveStorage(storage)
    } else {
      // Replace all profiles
      await this.saveStorage(imported)
    }
  }
}

/**
 * Create a profile manager for a project
 *
 * @param projectRoot - Absolute path to the Git repository root
 * @returns GitignoreProfileManager instance
 */
export function createProfileManager(projectRoot: string): GitignoreProfileManager {
  return new GitignoreProfileManager(projectRoot)
}
