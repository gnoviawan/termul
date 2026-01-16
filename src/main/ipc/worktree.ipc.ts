/**
 * Worktree IPC handlers
 *
 * Bridges renderer worktree API calls to WorktreeManager service in main process.
 * All handlers use IpcResult<T> pattern for consistent error handling.
 * Story 1.6 - Task 6: Update IPC Channels for Archive/Delete
 */

import { BrowserWindow, ipcMain } from 'electron'
import { WorktreeManager, type CreateWorktreeOptions, type DeleteWorktreeOptions } from '../services/worktree-manager'
import { read } from '../services/persistence-service'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import type {
  IpcResult,
  WorktreeMetadata,
  WorktreeStatus,
  ArchivedWorktree,
  CreateWorktreeDto,
  DeleteWorktreeOptions as IpcDeleteOptions,
  WorktreeErrorCodeType
} from '../../shared/types/ipc.types'
import type { PersistedProjectData } from '../../shared/types/persistence.types'


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

function broadcastWorktreeEvent(channel: string, ...payload: unknown[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...payload)
    }
  })
}

async function getProjectRoot(projectId: string): Promise<IpcResult<string>> {
  const persisted = await read<PersistedProjectData>(PersistenceKeys.projects)

  if (!persisted.success || !persisted.data) {
    return {
      success: false,
      error: !persisted.success ? persisted.error : 'Failed to load projects data',
      code: !persisted.success ? persisted.code : 'PROJECTS_NOT_FOUND'
    }
  }

  const project = persisted.data.projects.find((item) => item.id === projectId)

  if (!project?.path) {
    return {
      success: false,
      error: `Project path not found for project ${projectId}`,
      code: 'PROJECT_PATH_NOT_FOUND'
    }
  }

  return {
    success: true,
    data: project.path
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
      const projectRootResult = await getProjectRoot(projectId)
      if (!projectRootResult.success) {
        return projectRootResult
      }

      const manager = new WorktreeManager(projectRootResult.data, projectId)
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
      console.log('[worktree:create] Received DTO:', dto)

      // Use projectPath from DTO - this is the actual Git repository path
      const projectRoot = dto.projectPath
      console.log('[worktree:create] Using projectRoot:', projectRoot)

      const manager = new WorktreeManager(projectRoot, dto.projectId)

      const options: CreateWorktreeOptions = {
        projectId: dto.projectId,
        branchName: dto.branchName,
        gitignoreSelections: dto.gitignoreSelections
      }

      const worktree = await manager.create(options)

      // Emit event to renderer
      broadcastWorktreeEvent('worktree:created', worktree)


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
      const projectId = worktreeId.split('-')[0] // Extract projectId from worktreeId
      const projectRootResult = await getProjectRoot(projectId)
      if (!projectRootResult.success) {
        return projectRootResult
      }

      const manager = new WorktreeManager(projectRootResult.data, projectId)


      const deleteOptions: DeleteWorktreeOptions = {
        deleteBranch: options?.deleteBranch ?? false
      }

      await manager.delete(worktreeId, deleteOptions)

      // Emit event to renderer
      broadcastWorktreeEvent('worktree:deleted', worktreeId)


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
      const projectId = worktreeId.split('-')[0]
      const projectRootResult = await getProjectRoot(projectId)
      if (!projectRootResult.success) {
        return projectRootResult
      }

      const manager = new WorktreeManager(projectRootResult.data, projectId)
      const archivedWorktree = await manager.archive(worktreeId)

      // Emit event to renderer
      broadcastWorktreeEvent('worktree:archived', worktreeId, archivedWorktree)

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
      const projectRootResult = await getProjectRoot(projectId)
      if (!projectRootResult.success) {
        return projectRootResult
      }

      const manager = new WorktreeManager(projectRootResult.data, projectId)
      const restoredWorktree = await manager.restore(archiveId)

      // Emit event to renderer
      broadcastWorktreeEvent('worktree:restored', archiveId, restoredWorktree)

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
      const projectRootResult = await getProjectRoot(projectId)
      if (!projectRootResult.success) {
        return projectRootResult
      }

      const manager = new WorktreeManager(projectRootResult.data, projectId)
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
      const projectRootResult = await getProjectRoot(projectId)
      if (!projectRootResult.success) {
        return projectRootResult
      }

      const manager = new WorktreeManager(projectRootResult.data, projectId)
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
      const projectRootResult = await getProjectRoot(projectId)
      if (!projectRootResult.success) {
        return projectRootResult
      }

      const manager = new WorktreeManager(projectRootResult.data, projectId)
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
      const projectId = worktreeId.split('-')[0]
      const projectRootResult = await getProjectRoot(projectId)
      if (!projectRootResult.success) {
        return projectRootResult
      }

      const manager = new WorktreeManager(projectRootResult.data, projectId)
      const status = await manager.getStatus(worktreeId)

      // Emit event to renderer
      broadcastWorktreeEvent('worktree:status-changed', worktreeId, status)

      return {
        success: true,
        data: status
      }
    } catch (error) {
      return mapErrorToIpcResult(error, 'Failed to get worktree status')
    }
  })

}
