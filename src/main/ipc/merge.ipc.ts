/**
 * Merge IPC handlers
 *
 * Bridges renderer merge API calls to MergeManager service in main process.
 * All handlers use IpcResult<T> pattern for consistent error handling.
 * Source: Story 2.1 - Task 3: Create IPC Channels
 */

import { ipcMain } from 'electron'
import { MergeManager } from '../services/merge-manager'
import { projectRegistry } from '../services/project-registry'
import type { IpcResult } from '../../shared/types/ipc.types'
import type {
  ConflictDetectionResult,
  MergePreview,
  MergeResult,
  ConflictedFile,
  MergeValidationResult,
  DetectConflictsDto,
  MergePreviewDto,
  ExecuteMergeDto,
  ValidateMergeDto,
  MergePreference,
  DetectionMode,
  MergeErrorCodeType
} from '../../shared/types/merge.types'

/**
 * Merge error codes for IPC
 */
const MergeErrorCodes = {
  GIT_NOT_FOUND: 'GIT_NOT_FOUND',
  REPOSITORY_NOT_FOUND: 'REPOSITORY_NOT_FOUND',
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  MERGE_CONFLICTS: 'MERGE_CONFLICTS',
  MERGE_FAILED: 'MERGE_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INSUFFICIENT_DISK_SPACE: 'INSUFFICIENT_DISK_SPACE',
  UNCOMMITTED_CHANGES: 'UNCOMMITTED_CHANGES'
} as const

/**
 * Map MergeManager errors to IpcResult format
 */
function mapErrorToIpcResult(error: unknown, defaultMessage: string): IpcResult<never> {
  return {
    success: false,
    error: error instanceof Error ? error.message : defaultMessage,
    code: (error as { code?: string })?.code || 'MERGE_FAILED'
  }
}

/**
 * Get project root from project ID
 * Uses project registry to lookup actual filesystem path
 */
function getProjectRoot(projectId: string): string {
  const projectRoot = projectRegistry.get(projectId)
  if (!projectRoot) {
    throw new Error(`Project ${projectId} not found in registry. Was it registered via project:register?`)
  }
  return projectRoot
}

/**
 * Get/set merge preferences from config
 * Task 3.7: Implement merge:get-preference and merge:set-preference IPC handlers
 */
const PREFERENCE_KEY = 'merge:preference'

async function getMergePreference(): Promise<MergePreference> {
  // Return default preference
  // TODO: Load from ~/.pecutan/config.json when persistence is integrated
  return {
    detectionMode: 'accurate',
    strategy: undefined
  }
}

async function setMergePreference(pref: MergePreference): Promise<void> {
  // TODO: Save to ~/.pecutan/config.json when persistence is integrated
  // For now, preferences are stored in-memory only
  console.log('[Merge IPC] Setting preference:', pref)
}

/**
 * Register merge IPC handlers
 *
 * Handler registration must happen before app.ready() to prevent timing issues.
 * Task 3.1: Create electron/main/ipc/merge.ipc.ts file
 */
export function registerMergeIpc(): void {
  // Task 3.2: Implement merge:detect-conflicts IPC handler
  ipcMain.handle(
    'merge:detect-conflicts',
    async (_event, dto: DetectConflictsDto): Promise<IpcResult<ConflictDetectionResult>> => {
      try {
        const projectRoot = getProjectRoot(dto.projectId)
        const manager = new MergeManager(projectRoot, dto.projectId)

        let result: ConflictDetectionResult

        if (dto.mode === 'accurate') {
          result = await manager.detectConflictsAccurate(dto)
        } else {
          result = await manager.detectConflictsFast(dto)
        }

        return {
          success: true,
          data: result
        }
      } catch (error) {
        return mapErrorToIpcResult(error, 'Failed to detect conflicts')
      }
    }
  )

  // Task 3.3: Implement merge:get-preview IPC handler
  ipcMain.handle(
    'merge:get-preview',
    async (_event, dto: MergePreviewDto): Promise<IpcResult<MergePreview>> => {
      try {
        const projectRoot = getProjectRoot(dto.projectId)
        const manager = new MergeManager(projectRoot, dto.projectId)
        const preview = await manager.getMergePreview(dto)

        return {
          success: true,
          data: preview
        }
      } catch (error) {
        return mapErrorToIpcResult(error, 'Failed to get merge preview')
      }
    }
  )

  // Task 3.4: Implement merge:execute IPC handler
  ipcMain.handle(
    'merge:execute',
    async (_event, dto: ExecuteMergeDto): Promise<IpcResult<MergeResult>> => {
      try {
        const projectRoot = getProjectRoot(dto.projectId)
        const manager = new MergeManager(projectRoot, dto.projectId)
        const result = await manager.executeMerge(dto)

        return {
          success: true,
          data: result
        }
      } catch (error) {
        return mapErrorToIpcResult(error, 'Failed to execute merge')
      }
    }
  )

  // Task 3.5: Implement merge:get-conflicted-files IPC handler
  ipcMain.handle(
    'merge:get-conflicted-files',
    async (_event, projectId: string): Promise<IpcResult<ConflictedFile[]>> => {
      try {
        const projectRoot = getProjectRoot(projectId)
        const manager = new MergeManager(projectRoot, projectId)
        const conflictedFiles = await manager.getConflictedFiles(projectId)

        return {
          success: true,
          data: conflictedFiles
        }
      } catch (error) {
        return mapErrorToIpcResult(error, 'Failed to get conflicted files')
      }
    }
  )

  // Task 3.6: Implement merge:validate IPC handler
  ipcMain.handle(
    'merge:validate',
    async (_event, dto: ValidateMergeDto): Promise<IpcResult<MergeValidationResult>> => {
      try {
        const projectRoot = getProjectRoot(dto.projectId)
        const manager = new MergeManager(projectRoot, dto.projectId)
        const validation = await manager.validateMerge(dto)

        return {
          success: true,
          data: validation
        }
      } catch (error) {
        return mapErrorToIpcResult(error, 'Failed to validate merge')
      }
    }
  )

  // Task 3.7: Implement merge:get-preference IPC handler
  ipcMain.handle('merge:get-preference', async (): Promise<IpcResult<MergePreference>> => {
    try {
      const preference = await getMergePreference()

      return {
        success: true,
        data: preference
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to get merge preference')
    }
  })

  // Task 3.7: Implement merge:set-preference IPC handler
  ipcMain.handle('merge:set-preference', async (_event, pref: MergePreference): Promise<IpcResult<void>> => {
    try {
      await setMergePreference(pref)

      return {
        success: true,
        data: undefined
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to set merge preference')
    }
  })

  // Branch fetching handler
  ipcMain.handle(
    'merge:get-branches',
    async (_event, projectId: string): Promise<IpcResult<string[]>> => {
      try {
        // Now uses the fixed getProjectRoot()
        const projectRoot = getProjectRoot(projectId)
        const manager = new MergeManager(projectRoot, projectId)
        const branches = await manager.getLocalBranches()

        return {
          success: true,
          data: branches
        }
      } catch (error) {
        return mapErrorToIpcResult(error, 'Failed to fetch branches')
      }
    }
  )
}
