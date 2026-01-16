/**
 * Gitignore IPC Handlers
 *
 * IPC handlers for .gitignore parsing and profile management.
 *
 * Source: Story 1.4 - Task 4: Extend IPC for Gitignore Operations
 */

import { ipcMain } from 'electron'
import type { IpcResult } from '../../shared/types/ipc.types'
import type {
  ParseGitignoreDto,
  SaveProfileDto,
  DeleteProfileDto,
  LoadProfilesDto,
  GitignoreProfile,
  GitignoreParseResult,
  GitignoreErrorCodeType
} from '../../shared/types/ipc.types'
import { parseGitignore } from '../services/gitignore-parser'
import { GitignoreProfileManager } from '../services/gitignore-profiles'
import { GitignoreErrorCode } from '../../shared/types/ipc.types'

/**
 * Convert Map to plain object for IPC serialization
 */
function mapToObject<K extends string, V>(map: Map<K, V>): Record<K, V[]> {
  const obj: Record<string, V[]> = {}
  map.forEach((value, key) => {
    obj[key] = value
  })
  return obj as Record<K, V[]>
}

/**
 * Convert plain object to Map for IPC deserialization
 */
function objectToMap<K extends string, V>(obj: Record<K, V[]>): Map<K, V[]> {
  const map = new Map<K, V[]>()
  Object.entries(obj).forEach(([key, value]) => {
    map.set(key as K, value as V[])
  })
  return map
}

/**
 * Register gitignore IPC handlers
 */
export function registerGitignoreHandlers(): void {
  /**
   * Parse .gitignore file
   */
  ipcMain.handle('gitignore:parse', async (_event, dto: ParseGitignoreDto): Promise<IpcResult<GitignoreParseResult>> => {
    try {
      const result = await parseGitignore(dto.projectRoot)

      // Convert Map to object for serialization
      const serializedResult = {
        patterns: result.patterns,
        groupedPatterns: mapToObject(result.groupedPatterns),
        securityPatterns: result.securityPatterns
      }

      return { success: true, data: serializedResult as any }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        code: GitignoreErrorCode.GITIGNORE_PARSE_FAILED
      }
    }
  })

  /**
   * Save gitignore profile
   */
  ipcMain.handle('gitignore:profiles:save', async (_event, dto: SaveProfileDto): Promise<IpcResult<void>> => {
    try {
      const manager = new GitignoreProfileManager(dto.projectRoot)
      await manager.saveProfile(dto.name, dto.patterns)

      return { success: true, data: undefined }
    } catch (error) {
      let code: GitignoreErrorCodeType = GitignoreErrorCode.INVALID_PROFILE_DATA

      if (error instanceof Error) {
        if (error.message.includes('already exists')) {
          code = GitignoreErrorCode.PROFILE_ALREADY_EXISTS
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        code
      }
    }
  })

  /**
   * Load all gitignore profiles
   */
  ipcMain.handle('gitignore:profiles:list', async (_event, dto: LoadProfilesDto): Promise<IpcResult<GitignoreProfile[]>> => {
    try {
      const manager = new GitignoreProfileManager(dto.projectRoot)
      const profiles = await manager.loadProfiles()

      return { success: true, data: profiles }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        code: GitignoreErrorCode.INVALID_PROFILE_DATA
      }
    }
  })

  /**
   * Delete gitignore profile
   */
  ipcMain.handle('gitignore:profiles:delete', async (_event, dto: DeleteProfileDto): Promise<IpcResult<void>> => {
    try {
      const manager = new GitignoreProfileManager(dto.projectRoot)
      await manager.deleteProfile(dto.name)

      return { success: true, data: undefined }
    } catch (error) {
      let code: GitignoreErrorCodeType = GitignoreErrorCode.INVALID_PROFILE_DATA

      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          code = GitignoreErrorCode.PROFILE_NOT_FOUND
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        code
      }
    }
  })
}
