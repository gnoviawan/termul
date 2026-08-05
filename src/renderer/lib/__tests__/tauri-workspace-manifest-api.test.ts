import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

import type { WorkspaceManifest } from '@shared/types/workspace-manifest.types'
import { createTauriWorkspaceManifestApi } from '../tauri-workspace-manifest-api'

describe('tauri-workspace-manifest-api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  const sampleManifest: WorkspaceManifest = {
    projectId: 'project-1',
    revision: 0,
    updateIdentity: 'conn-1',
    updatedAt: 0,
    topology: {
      type: 'leaf',
      id: 'leaf-1',
      terminalIds: ['terminal-1'],
      editorIds: [],
      activeTabId: 'tab-1'
    },
    activePaneId: 'leaf-1',
    focusedSessionId: 'session-1',
    terminals: [
      {
        terminalId: 'terminal-1',
        projectId: 'project-1',
        shell: 'pwsh',
        cwd: '/dev/proj',
        name: 'main',
        worktreeId: 'wt-1',
        claimHandle: 'handle-1'
      }
    ],
    editors: []
  }

  function enableTauriContext(): void {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  }

  describe('getManifest', () => {
    it('invokes workspace_manifest_get with projectId and returns IpcResult<Option<WorkspaceManifest>>', async () => {
      enableTauriContext()
      mockInvoke.mockResolvedValue({ success: true, data: sampleManifest })

      const api = createTauriWorkspaceManifestApi()
      const result = await api.getManifest('project-1')

      expect(mockInvoke).toHaveBeenCalledTimes(1)
      const [command, args] = mockInvoke.mock.calls[0]
      expect(command).toBe('workspace_manifest_get')
      expect(args).toEqual({ projectId: 'project-1' })
      expect(result).toEqual({ success: true, data: sampleManifest })
    })

    it('rejects empty projectId with VALIDATION_ERROR (Patch 14)', async () => {
      const api = createTauriWorkspaceManifestApi()
      const result = await api.getManifest('')

      expect(result).toEqual({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('returns Ok(None) when the host has no manifest', async () => {
      enableTauriContext()
      mockInvoke.mockResolvedValue({ success: true, data: null })

      const api = createTauriWorkspaceManifestApi()
      const result = await api.getManifest('project-1')

      expect(result).toEqual({ success: true, data: null })
    })

    it('propagates the host IpcResult error verbatim (e.g. WORKSPACE_MANIFEST_GET_FAILED)', async () => {
      enableTauriContext()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'io error: permission denied',
        code: 'WORKSPACE_MANIFEST_GET_FAILED'
      })

      const api = createTauriWorkspaceManifestApi()
      const result = await api.getManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: 'io error: permission denied',
        code: 'WORKSPACE_MANIFEST_GET_FAILED'
      })
    })

    it('maps an invoke throw to INVOKE_ERROR (never throws)', async () => {
      enableTauriContext()
      mockInvoke.mockRejectedValue(new Error('renderer crashed'))

      const api = createTauriWorkspaceManifestApi()
      const result = await api.getManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: 'renderer crashed',
        code: 'INVOKE_ERROR'
      })
    })

    it('returns INVOKE_ERROR outside a Tauri context (no invoke attempted)', async () => {
      const api = createTauriWorkspaceManifestApi()
      const result = await api.getManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: 'workspace_manifest_get requires the Tauri runtime',
        code: 'INVOKE_ERROR'
      })
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  describe('writeManifest', () => {
    it('rejects empty projectId with VALIDATION_ERROR (Patch 14)', async () => {
      const api = createTauriWorkspaceManifestApi()
      const result = await api.writeManifest('', null, sampleManifest)

      expect(result).toEqual({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('invokes workspace_manifest_write with projectId + basedRevision + manifest and returns Updated', async () => {
      enableTauriContext()
      const updated = {
        success: true,
        data: { status: 'updated', revision: 1, updatedAt: 1_700_000_000_000 }
      }
      mockInvoke.mockResolvedValue(updated)

      const api = createTauriWorkspaceManifestApi()
      const result = await api.writeManifest('project-1', null, sampleManifest)

      expect(mockInvoke).toHaveBeenCalledTimes(1)
      const [command, args] = mockInvoke.mock.calls[0]
      expect(command).toBe('workspace_manifest_write')
      expect(args).toEqual({
        projectId: 'project-1',
        basedRevision: null,
        manifest: sampleManifest
      })
      expect(result).toEqual(updated)
    })

    it('passes through a Conflict outcome (success-body variant, NOT an error code)', async () => {
      enableTauriContext()
      const conflict = {
        success: true,
        data: {
          status: 'conflict',
          currentRevision: 3,
          currentUpdatedAt: 1_700_000_000_001,
          currentUpdateIdentity: 'conn-2'
        }
      }
      mockInvoke.mockResolvedValue(conflict)

      const api = createTauriWorkspaceManifestApi()
      const result = await api.writeManifest('project-1', 1, sampleManifest)

      expect(result).toEqual(conflict)
      if (result.success && result.data.status === 'conflict') {
        expect(result.data.currentRevision).toBe(3)
        expect(result.data.currentUpdateIdentity).toBe('conn-2')
      } else {
        throw new Error('expected conflict outcome')
      }
    })

    it('subsequent write presents the latest revision as basedRevision', async () => {
      enableTauriContext()
      mockInvoke.mockResolvedValue({
        success: true,
        data: { status: 'updated', revision: 2, updatedAt: 1_700_000_000_002 }
      })

      const api = createTauriWorkspaceManifestApi()
      const result = await api.writeManifest('project-1', 1, sampleManifest)

      const [, args] = mockInvoke.mock.calls[0]
      expect(args.basedRevision).toBe(1)
      if (result.success && result.data.status === 'updated') {
        expect(result.data.revision).toBe(2)
      }
    })

    it('maps an invoke throw to INVOKE_ERROR (never throws)', async () => {
      enableTauriContext()
      mockInvoke.mockRejectedValue(new Error('renderer crashed'))

      const api = createTauriWorkspaceManifestApi()
      const result = await api.writeManifest('project-1', null, sampleManifest)

      expect(result).toEqual({
        success: false,
        error: 'renderer crashed',
        code: 'INVOKE_ERROR'
      })
    })

    it('surfaces the host VALIDATION_ERROR for an excluded-field payload (Patch 1)', async () => {
      // Patch 1: the Rust `workspace_manifest_write` command accepts the
      // manifest as `serde_json::Value` and manually deserializes so a
      // `deny_unknown_fields` rejection (envVars / raw claim /
      // fullscreenPaneId / agentLauncherPaneId) surfaces as
      // `IpcResult::error(VALIDATION_ERROR)` — NOT a thrown IPC error
      // (`INVOKE_ERROR`) that would mask the validation failure. The adapter
      // is a passthrough; it surfaces the host's response verbatim.
      enableTauriContext()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'payload validation failed: unknown field `envVars`',
        code: 'VALIDATION_ERROR'
      })

      const api = createTauriWorkspaceManifestApi()
      const payloadWithEnvVars = {
        ...sampleManifest,
        // @ts-expect-error — deliberately inject an excluded field.
        envVars: { SECRET: 'leaked' }
      }
      const result = await api.writeManifest('project-1', null, payloadWithEnvVars)

      expect(result).toEqual({
        success: false,
        error: 'payload validation failed: unknown field `envVars`',
        code: 'VALIDATION_ERROR'
      })
    })

    it('returns INVOKE_ERROR outside a Tauri context (no invoke attempted)', async () => {
      const api = createTauriWorkspaceManifestApi()
      const result = await api.writeManifest('project-1', null, sampleManifest)

      expect(result).toEqual({
        success: false,
        error: 'workspace_manifest_write requires the Tauri runtime',
        code: 'INVOKE_ERROR'
      })
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  describe('deleteManifest', () => {
    it('rejects empty projectId with VALIDATION_ERROR (Patch 14)', async () => {
      const api = createTauriWorkspaceManifestApi()
      const result = await api.deleteManifest('')

      expect(result).toEqual({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('invokes workspace_manifest_delete with projectId and returns Ok(())', async () => {
      enableTauriContext()
      mockInvoke.mockResolvedValue({ success: true, data: undefined })

      const api = createTauriWorkspaceManifestApi()
      const result = await api.deleteManifest('project-1')

      expect(mockInvoke).toHaveBeenCalledTimes(1)
      const [command, args] = mockInvoke.mock.calls[0]
      expect(command).toBe('workspace_manifest_delete')
      expect(args).toEqual({ projectId: 'project-1' })
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('idempotent delete returns Ok(()) for a missing file', async () => {
      enableTauriContext()
      mockInvoke.mockResolvedValue({ success: true, data: undefined })

      const api = createTauriWorkspaceManifestApi()
      const result = await api.deleteManifest('project-1')

      expect(result.success).toBe(true)
    })

    it('maps an invoke throw to INVOKE_ERROR (never throws)', async () => {
      enableTauriContext()
      mockInvoke.mockRejectedValue(new Error('renderer crashed'))

      const api = createTauriWorkspaceManifestApi()
      const result = await api.deleteManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: 'renderer crashed',
        code: 'INVOKE_ERROR'
      })
    })

    it('returns INVOKE_ERROR outside a Tauri context (no invoke attempted)', async () => {
      const api = createTauriWorkspaceManifestApi()
      const result = await api.deleteManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: 'workspace_manifest_delete requires the Tauri runtime',
        code: 'INVOKE_ERROR'
      })
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })
})
