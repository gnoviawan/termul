/**
 * Web-branch tests for worktree-api.ts.
 *
 * Pins `isTauriContext()` to FALSE and asserts the worktree facade returns an
 * explicit `WEB_UNSUPPORTED` result for representative methods (list, create,
 * remove, checkDirty) instead of letting the stubbed `invoke()` reject with
 * `tauriUnavailable`. Worktree mutation is desktop-only until a separate
 * product/security decision.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockInvoke } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

import { worktreeApi } from '../worktree-api'

describe('worktreeApi (web branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    mockInvoke.mockReset()
  })

  it('list returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.list('/project')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
      expect(result.error).toContain('not available')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('create returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.create({
      projectPath: '/project',
      name: 'wt-1',
      branch: 'main',
      isNewBranch: true
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('remove returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.remove('/project', '/wt', false)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('checkDirty returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.checkDirty('/wt')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
