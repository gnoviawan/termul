/**
 * Worktree IPC handlers
 *
 * Bridges renderer worktree API calls to WorktreeManager service in main process.
 * All handlers use IpcResult<T> pattern for consistent error handling.
 * Story 1.6 - Task 6: Update IPC Channels for Archive/Delete
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
      // TODO: Get projectRoot from project registry using projectId
      // For now, use current working directory as placeholder
      const projectRoot = process.cwd()

      const manager = new WorktreeManager(projectRoot, projectId)
      const worktrees = await manager.list(projectId)

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
      const projectRoot = process.cwd()
      const projectId = worktreeId.split('-')[0] // Extract projectId from worktreeId

      const manager = new WorktreeManager(projectRoot, projectId)

      const deleteOptions: DeleteWorktreeOptions = {
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

  // Archive a worktree
  // Story 1.6 - Task 6.1: Add worktree:archive IPC channel
  ipcMain.handle('worktree:archive', async (_event, worktreeId: string): Promise<IpcResult<ArchivedWorktree>> => {
    try {
      // TODO: Get projectRoot from worktree metadata
      const projectRoot = process.cwd()
      const projectId = worktreeId.split('-')[0]

      const manager = new WorktreeManager(projectRoot, projectId)
      const archivedWorktree = await manager.archive(worktreeId)

      // Emit event to renderer
      ipcMain.emit('worktree:archived', worktreeId, archivedWorktree)

      return {
        success: true,
        data: archivedWorktree
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to archive worktree')
    }
  })

  // Restore an archived worktree
  // Story 1.6 - Task 6.2: Add worktree:restore IPC channel
  ipcMain.handle('worktree:restore', async (_event, archiveId: string, projectId: string): Promise<IpcResult<WorktreeMetadata>> => {
    try {
      // TODO: Get projectRoot from project registry using projectId
      const projectRoot = process.cwd()

      const manager = new WorktreeManager(projectRoot, projectId)
      const restoredWorktree = await manager.restore(archiveId)

      // Emit event to renderer
      ipcMain.emit('worktree:restored', archiveId, restoredWorktree)

      return {
        success: true,
        data: restoredWorktree
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to restore worktree')
    }
  })

  // List archived worktrees
  // Story 1.6 - Task 6.4: Add worktree:list-archived IPC channel
  ipcMain.handle('worktree:list-archived', async (_event, projectId: string): Promise<IpcResult<ArchivedWorktree[]>> => {
    try {
      // TODO: Get projectRoot from project registry using projectId
      const projectRoot = process.cwd()

      const manager = new WorktreeManager(projectRoot, projectId)
      const archivedWorktrees = await manager.listArchived()

      return {
        success: true,
        data: archivedWorktrees
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to list archived worktrees')
    }
  })

  // Delete an archive
  // Story 1.6 - Task 2: Archive Management UI
  ipcMain.handle('worktree:delete-archive', async (_event, archiveId: string, projectId: string): Promise<IpcResult<void>> => {
    try {
      // TODO: Get projectRoot from project registry using projectId
      const projectRoot = process.cwd()

      const manager = new WorktreeManager(projectRoot, projectId)
      await manager.deleteArchive(archiveId)

      return {
        success: true,
        data: undefined
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to delete archive')
    }
  })

  // Cleanup expired archives
  // Story 1.6 - Task 2.4: Add auto-cleanup for archives older than 30 days
  ipcMain.handle('worktree:cleanup-archives', async (_event, projectId: string): Promise<IpcResult<{ cleaned: number }>> => {
    try {
      // TODO: Get projectRoot from project registry using projectId
      const projectRoot = process.cwd()

      const manager = new WorktreeManager(projectRoot, projectId)
      const cleaned = await manager.cleanupExpiredArchives()

      return {
        success: true,
        data: { cleaned }
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to cleanup archives')
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
