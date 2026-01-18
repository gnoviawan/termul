/**
 * Project IPC Handlers
 *
 * Handles project registration and path lookup operations.
 * These must be called from the renderer before any merge/worktree operations.
 */

import { ipcMain } from 'electron'
import { projectRegistry } from '../services/project-registry'
import type { IpcResult } from '../../shared/types/ipc.types'

/**
 * Register all project IPC handlers
 */
export function registerProjectIpc(): void {
  // Register a project with its filesystem path
  ipcMain.handle(
    'project:register',
    (_event, projectId: string, projectPath: string): IpcResult<void> => {
      try {
        projectRegistry.register(projectId, projectPath)
        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to register project',
          code: 'PROJECT_REGISTER_FAILED'
        }
      }
    }
  )

  // Get a project's registered path
  ipcMain.handle(
    'project:get-path',
    (_event, projectId: string): IpcResult<string> => {
      try {
        const path = projectRegistry.get(projectId)
        if (!path) {
          return {
            success: false,
            error: `Project ${projectId} not found in registry`,
            code: 'PROJECT_NOT_REGISTERED'
          }
        }
        return { success: true, data: path }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get project path',
          code: 'PROJECT_GET_FAILED'
        }
      }
    }
  )

  // Unregister a project (call when project is deleted)
  ipcMain.handle(
    'project:unregister',
    (_event, projectId: string): IpcResult<void> => {
      try {
        projectRegistry.unregister(projectId)
        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to unregister project',
          code: 'PROJECT_UNREGISTER_FAILED'
        }
      }
    }
  )
}
