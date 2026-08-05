import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn()
}))

vi.mock('./tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

import type { WorkspaceManifest } from '@shared/types/workspace-manifest.types'
import { webWorkspaceManifestApi } from './web-workspace-manifest-api'

describe('web-workspace-manifest-api (fetch client)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: () => Promise.resolve(body)
    } as unknown as Response
  }

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

  describe('getManifest', () => {
    it('rejects empty projectId with VALIDATION_ERROR (Patch 14)', async () => {
      const result = await webWorkspaceManifestApi.getManifest('')

      expect(result).toEqual({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('GETs /workspace/:projectId and returns success on a populated manifest', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: sampleManifest }))

      const result = await webWorkspaceManifestApi.getManifest('project-1')

      expect(mockFetch).toHaveBeenCalledWith(`${window.location.origin}/workspace/project-1`, {
        method: 'GET'
      })
      expect(result).toEqual({ success: true, data: sampleManifest })
    })

    it('returns success with null data when the host has no manifest', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: null }))

      const result = await webWorkspaceManifestApi.getManifest('project-1')

      expect(result).toEqual({ success: true, data: null })
    })

    it('encodes the projectId so separators are not URL-special', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: null }))

      await webWorkspaceManifestApi.getManifest('proj/with/slashes')

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/workspace/proj%2Fwith%2Fslashes`,
        { method: 'GET' }
      )
    })

    it('maps a non-2xx response to NETWORK_ERROR', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))

      const result = await webWorkspaceManifestApi.getManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('500'),
        code: 'NETWORK_ERROR'
      })
    })

    it('maps a network throw to NETWORK_ERROR', async () => {
      mockFetch.mockRejectedValueOnce(new Error('failed to fetch'))

      const result = await webWorkspaceManifestApi.getManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: 'failed to fetch',
        code: 'NETWORK_ERROR'
      })
    })

    it('maps invalid JSON to NETWORK_ERROR', async () => {
      const res: Partial<Response> = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.reject(new Error('invalid JSON'))
      }
      mockFetch.mockResolvedValueOnce(res as Response)

      const result = await webWorkspaceManifestApi.getManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: 'invalid JSON',
        code: 'NETWORK_ERROR'
      })
    })
  })

  describe('writeManifest', () => {
    it('rejects empty projectId with VALIDATION_ERROR (Patch 14)', async () => {
      const result = await webWorkspaceManifestApi.writeManifest('', null, sampleManifest)

      expect(result).toEqual({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('POSTs to /workspace/:projectId/write with basedRevision + manifest and returns Updated', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { status: 'updated', revision: 1, updatedAt: 1_700_000_000_000 }
        })
      )

      const result = await webWorkspaceManifestApi.writeManifest('project-1', null, sampleManifest)

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/workspace/project-1/write`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ basedRevision: null, manifest: sampleManifest })
        })
      )
      expect(result).toEqual({
        success: true,
        data: { status: 'updated', revision: 1, updatedAt: 1_700_000_000_000 }
      })
    })

    it('propagates a Conflict outcome (success-body variant, NOT an error code)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            status: 'conflict',
            currentRevision: 3,
            currentUpdatedAt: 1_700_000_000_001,
            currentUpdateIdentity: 'conn-2'
          }
        })
      )

      const result = await webWorkspaceManifestApi.writeManifest('project-1', 1, sampleManifest)

      expect(result.success).toBe(true)
      if (result.success && result.data.status === 'conflict') {
        expect(result.data.currentRevision).toBe(3)
        expect(result.data.currentUpdateIdentity).toBe('conn-2')
      } else {
        throw new Error('expected conflict outcome')
      }
    })

    it('surfaces a success-body VALIDATION_ERROR code verbatim from a 200 response (Patch 1)', async () => {
      // Patch 1: the HTTP `write` handler manually deserializes the body so a
      // `deny_unknown_fields` rejection surfaces as 200 + IpcBody::err(
      // VALIDATION_ERROR) — NOT a 4xx JsonRejection (which the renderer would
      // map to NETWORK_ERROR, masking the validation failure). The web adapter
      // parses the 200 response body and surfaces the VALIDATION_ERROR code.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: false,
          error: 'payload validation failed: unknown field `envVars`',
          code: 'VALIDATION_ERROR'
        })
      )

      const result = await webWorkspaceManifestApi.writeManifest('project-1', null, sampleManifest)

      expect(result).toEqual({
        success: false,
        error: 'payload validation failed: unknown field `envVars`',
        code: 'VALIDATION_ERROR'
      })
    })

    it('maps a non-2xx write response to NETWORK_ERROR', async () => {
      // A genuine transport-level failure (e.g. 500 from a crashed handler,
      // 502 from a proxy) maps to NETWORK_ERROR. (Patch 10: the previous
      // version of this test was mislabeled — it tested a 200 response with
      // `code: 'FORBIDDEN'` surfacing verbatim, NOT a non-2xx → NETWORK_ERROR
      // mapping. The VALIDATION_ERROR case is now covered by the
      // success-body test above.)
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))

      const result = await webWorkspaceManifestApi.writeManifest('project-1', null, sampleManifest)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('NETWORK_ERROR')
      }
    })

    it('maps a network throw to NETWORK_ERROR', async () => {
      mockFetch.mockRejectedValueOnce(new Error('failed to fetch'))

      const result = await webWorkspaceManifestApi.writeManifest('project-1', null, sampleManifest)

      expect(result).toEqual({
        success: false,
        error: 'failed to fetch',
        code: 'NETWORK_ERROR'
      })
    })

    it('encodes the projectId in the URL', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { status: 'updated', revision: 1, updatedAt: 0 }
        })
      )

      await webWorkspaceManifestApi.writeManifest('proj/with/slashes', null, sampleManifest)

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/workspace/proj%2Fwith%2Fslashes/write`,
        expect.anything()
      )
    })
  })

  describe('deleteManifest', () => {
    it('rejects empty projectId with VALIDATION_ERROR (Patch 14)', async () => {
      const result = await webWorkspaceManifestApi.deleteManifest('')

      expect(result).toEqual({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('POSTs to /workspace/:projectId/delete and returns Ok(())', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

      const result = await webWorkspaceManifestApi.deleteManifest('project-1')

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/workspace/project-1/delete`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({})
        })
      )
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('idempotent delete returns Ok(()) for a missing file', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

      const result = await webWorkspaceManifestApi.deleteManifest('project-1')

      expect(result.success).toBe(true)
    })

    it('surfaces a success-body FORBIDDEN code verbatim from a 200 response (Patch 10)', async () => {
      // Patch 10: this test was previously named "maps a non-2xx response
      // (e.g. loopback FORBIDDEN) to NETWORK_ERROR" but actually tested a
      // 200 + IpcBody::err(FORBIDDEN) surfacing verbatim (NOT mapped to
      // NETWORK_ERROR). Renamed for accuracy; the real non-2xx →
      // NETWORK_ERROR mapping is covered by the test below.
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'workspace manifest write/delete routes are localhost-only',
            code: 'FORBIDDEN'
          },
          200
        )
      )

      const result = await webWorkspaceManifestApi.deleteManifest('project-1')

      // The IpcBody shape mirrors IpcResult — a `success: false` body maps
      // straight through (the FORBIDDEN code surfaces verbatim).
      expect(result).toEqual({
        success: false,
        error: 'workspace manifest write/delete routes are localhost-only',
        code: 'FORBIDDEN'
      })
    })

    it('maps a non-2xx delete response to NETWORK_ERROR (Patch 10)', async () => {
      // The real non-2xx → NETWORK_ERROR mapping for `deleteManifest`. A
      // genuine transport-level failure (e.g. 403/500) maps to NETWORK_ERROR.
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 403))

      const result = await webWorkspaceManifestApi.deleteManifest('project-1')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('NETWORK_ERROR')
      }
    })

    it('maps a network throw to NETWORK_ERROR', async () => {
      mockFetch.mockRejectedValueOnce(new Error('failed to fetch'))

      const result = await webWorkspaceManifestApi.deleteManifest('project-1')

      expect(result).toEqual({
        success: false,
        error: 'failed to fetch',
        code: 'NETWORK_ERROR'
      })
    })
  })
})
