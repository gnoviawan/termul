/**
 * Worktree IPC handlers
 *
 * Bridges renderer worktree API calls to WorktreeManager service in main process.
 * All handlers use IpcResult<T> pattern for consistent error handling.
 */

import { ipcMain } from 'electron'
import { WorktreeManager, type CreateWorktreeOptions, type DeleteWorktreeOptions } from '../services/worktree-manager'
import type {
  IpcResult,
  WorktreeMetadata,
  WorktreeStatus,
  ArchivedWorktree,
  CreateWorktreeDto,
  DeleteWorktreeOptions as IpcDeleteOptions,
  WorktreeErrorCodeType
} from '../../shared/types/ipc.types'

/**
 * Map WorktreeManager errors to IpcResult format
 */
function mapErrorToIpcResult(error: unknown, defaultMessage: string): IpcResult<never> {
  const errorCode = (error as { code?: string })?.code as WorktreeErrorCodeType | undefined

  return {
    success: false,
    error: error instanceof Error ? error.message : defaultMessage,
    code: errorCode || 'GIT_OPERATION_FAILED'
  }
}

/**
 * Register worktree IPC handlers
 *
 * Handler registration must happen before app.ready() to prevent timing issues.
 */
export function registerWorktreeIpc(): void {
  // List all worktrees for a project
  ipcMain.handle('worktree:list', async (_event, projectId: string): Promise<IpcResult<WorktreeMetadata[]>> => {
    try {
      // WorktreeManager.list() requires project context - for now return empty array
      // Full implementation will require project registry lookup
      const worktrees: WorktreeMetadata[] = []

      return {
        success: true,
        data: worktrees
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to list worktrees')
    }
  })

  // Create a new worktree
  ipcMain.handle('worktree:create', async (_event, dto: CreateWorktreeDto): Promise<IpcResult<WorktreeMetadata>> => {
    try {
      // TODO: Get projectRoot from project registry using dto.projectId
      // For now, this is a placeholder that shows the structure
      const projectRoot = process.cwd()

      const manager = new WorktreeManager(projectRoot, dto.projectId)

      const options: CreateWorktreeOptions = {
        projectId: dto.projectId,
        branchName: dto.branchName,
        gitignoreSelections: dto.gitignoreSelections
      }

      const worktree = await manager.create(options)

      // Emit event to renderer
      ipcMain.emit('worktree:created', worktree)

      return {
        success: true,
        data: worktree
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to create worktree')
    }
  })

  // Delete a worktree
  ipcMain.handle('worktree:delete', async (_event, worktreeId: string, options?: IpcDeleteOptions): Promise<IpcResult<void>> => {
    try {
      // TODO: Get projectRoot from worktree metadata
      // For now, this is a placeholder
      const projectRoot = process.cwd()
      const projectId = worktreeId.split('-')[0] // Extract projectId from worktreeId

      const manager = new WorktreeManager(projectRoot, projectId)

      const deleteOptions: DeleteWorktreeOptions = {
        force: options?.force ?? false,
        deleteBranch: options?.deleteBranch ?? false
      }

      await manager.delete(worktreeId, deleteOptions)

      // Emit event to renderer
      ipcMain.emit('worktree:deleted', worktreeId)

      return {
        success: true,
        data: undefined
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to delete worktree')
    }
  })

  // Archive a worktree (STUB - not implemented until Story 1.6)
  ipcMain.handle('worktree:archive', async (): Promise<IpcResult<ArchivedWorktree>> => {
    return {
      success: false,
      error: 'Archive functionality not yet implemented',
      code: 'NOT_IMPLEMENTED'
    }
  })

  // Restore an archived worktree (STUB - not implemented until Story 1.6)
  ipcMain.handle('worktree:restore', async (): Promise<IpcResult<WorktreeMetadata>> => {
    return {
      success: false,
      error: 'Restore functionality not yet implemented',
      code: 'NOT_IMPLEMENTED'
    }
  })

  // Get worktree status
  ipcMain.handle('worktree:status', async (_event, worktreeId: string): Promise<IpcResult<WorktreeStatus>> => {
    try {
      // TODO: Get projectRoot from worktree metadata
      const projectRoot = process.cwd()
      const projectId = worktreeId.split('-')[0]

      const manager = new WorktreeManager(projectRoot, projectId)
      const status = await manager.getStatus(worktreeId)

      // Emit event to renderer
      ipcMain.emit('worktree:status-changed', worktreeId, status)

      return {
        success: true,
        data: status
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to get worktree status')
    }
  })
}
