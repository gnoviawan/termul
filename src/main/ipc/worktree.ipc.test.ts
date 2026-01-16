/**
 * Unit tests for Worktree IPC types and structures
 *
 * Tests type definitions and error codes.
 * Note: Full IPC handler testing requires Electron environment.
 */

import { describe, it, expect } from 'vitest'
import type { IpcResult } from '../../shared/types/ipc.types'

describe('Worktree IPC Types', () => {
  describe('IpcResult type', () => {
    it('should have success type structure', () => {
      const successResult: IpcResult<string> = {
        success: true,
        data: 'test'
      }

      expect(successResult.success).toBe(true)
      expect(successResult.data).toBe('test')
    })

    it('should have error type structure', () => {
      const errorResult: IpcResult<never> = {
        success: false,
        error: 'Test error',
        code: 'TEST_ERROR'
      }

      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toBe('Test error')
      expect(errorResult.code).toBe('TEST_ERROR')
    })
  })

  describe('error codes', () => {
    it('should define worktree error codes', async () => {
      const { WorktreeErrorCode } = await import('../../shared/types/ipc.types')

      expect(WorktreeErrorCode.BRANCH_NOT_FOUND).toBe('BRANCH_NOT_FOUND')
      expect(WorktreeErrorCode.NOT_IMPLEMENTED).toBe('NOT_IMPLEMENTED')
      expect(WorktreeErrorCode.GIT_VERSION_TOO_OLD).toBe('GIT_VERSION_TOO_OLD')
    })
  })
})
