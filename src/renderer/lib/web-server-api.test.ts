import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn()
}))

vi.mock('./tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

import {
  webServerDialog,
  webServerFilesystem,
  webServerGit,
  webServerShell
} from './web-server-api'

describe('web-server-api (fetch client)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    // jsdom provides window.location.origin
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

  describe('webServerFilesystem.createDirectory', () => {
    it('POSTs /fs/mkdir with { path } and returns success', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

      const result = await webServerFilesystem.createDirectory('C:/proj/foo')

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/fs/mkdir`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'C:/proj/foo' })
        })
      )
      expect(result.success).toBe(true)
    })

    it('returns a failed IpcResult when the server reports MKDIR_ERROR', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'permission denied', code: 'MKDIR_ERROR' })
      )

      const result = await webServerFilesystem.createDirectory('/bad')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('permission denied')
        expect(result.code).toBe('MKDIR_ERROR')
      }
    })

    it('maps a network throw to NETWORK_ERROR', async () => {
      mockFetch.mockRejectedValueOnce(new Error('failed to fetch'))

      const result = await webServerFilesystem.createDirectory('/x')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('NETWORK_ERROR')
        expect(result.error).toBe('failed to fetch')
      }
    })

    it('maps a non-2xx response to NETWORK_ERROR', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))

      const result = await webServerFilesystem.createDirectory('/x')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('NETWORK_ERROR')
        expect(result.error).toContain('500')
      }
    })
  })

  describe('webServerFilesystem.createFile', () => {
    it('POSTs /fs/write with { path, content } (defaults content to empty)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

      const result = await webServerFilesystem.createFile('/proj/README.md')

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/fs/write`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/proj/README.md', content: '' })
        })
      )
      expect(result.success).toBe(true)
    })

    it('passes provided content', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

      await webServerFilesystem.createFile('/p/f.txt', 'hello')

      const call = mockFetch.mock.calls[0]?.[1] as RequestInit
      expect(JSON.parse(call.body as string)).toEqual({ path: '/p/f.txt', content: 'hello' })
    })
  })

  describe('webServerFilesystem.readDirectory', () => {
    it('GETs /fs/ls?path=<encoded> and returns data', async () => {
      const entries = [
        { name: 'a', path: '/x/a', type: 'directory', extension: null, size: 0, modifiedAt: 1 }
      ]
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: entries }))

      const result = await webServerFilesystem.readDirectory('C:/my dir')

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/fs/ls?path=${encodeURIComponent('C:/my dir')}`,
        expect.objectContaining({ method: 'GET' })
      )
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(entries)
      }
    })

    it('returns a failed IpcResult with READ_ERROR code when server reports it', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'not found', code: 'READ_ERROR' })
      )

      const result = await webServerFilesystem.readDirectory('/missing')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('READ_ERROR')
      }
    })
  })

  describe('webServerDialog.browseDirectory', () => {
    it('GETs /fs/browse?path=<encoded> and returns data', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))

      const result = await webServerDialog.browseDirectory('/')

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/fs/browse?path=${encodeURIComponent('/')}`,
        expect.objectContaining({ method: 'GET' })
      )
      expect(result.success).toBe(true)
    })
  })

  describe('webServerGit.init', () => {
    it('POSTs /git/init with { cwd } and resolves on success', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

      await expect(webServerGit.init('/proj')).resolves.toBeUndefined()
      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/git/init`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ cwd: '/proj' })
        })
      )
    })

    it('throws when the server reports GIT_INIT_ERROR', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'git not installed', code: 'GIT_INIT_ERROR' })
      )

      await expect(webServerGit.init('/proj')).rejects.toThrow('git not installed')
    })

    it('throws a NETWORK_ERROR-derived message on fetch failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('offline'))

      await expect(webServerGit.init('/proj')).rejects.toThrow('offline')
    })
  })

  describe('webServerShell.getAvailableShells', () => {
    it('GETs /shells and returns DetectedShells', async () => {
      const shells = {
        default: { name: 'powershell', path: 'C:/pwsh', displayName: 'PowerShell' },
        available: [{ name: 'powershell', path: 'C:/pwsh', displayName: 'PowerShell' }]
      }
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: shells }))

      const result = await webServerShell.getAvailableShells()

      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/shells`,
        expect.objectContaining({ method: 'GET' })
      )
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(shells)
      }
    })

    it('maps invalid JSON to NETWORK_ERROR', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.reject(new Error('unexpected token'))
      } as unknown as Response)

      const result = await webServerShell.getAvailableShells()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('NETWORK_ERROR')
      }
    })
  })

  // Patch J (cross-runtime contract): the Rust `DirectoryEntryDto` serializes
  // with `#[serde(rename_all = "camelCase")]`, producing wire keys `modifiedAt`
  // + `type` (NOT `modified_at`). The TS `IpcBody`/`DirectoryEntry` asserts
  // this separately, but no test round-trips the EXACT Rust-handler JSON
  // through `webServerFilesystem.readDirectory` → `parseBody`. A field rename
  // (e.g. `modified_at` ↔ `modifiedAt`) would pass both sides. This test pins
  // the contract: the captured Rust-handler body parses into the TS
  // `DirectoryEntry` shape with the expected camelCase fields.
  describe('cross-runtime IpcResult-shape round-trip (Patch J)', () => {
    it('parses the exact Rust DirectoryEntryDto wire JSON into DirectoryEntry', async () => {
      // This is the byte-for-byte shape `entry_dto` serializes to: camelCase
      // `modifiedAt` + `type` + `extension` + `size` + `name` + `path` +
      // optional `ignored`. If the Rust side regressed to `modified_at`, this
      // body would NOT have the `modifiedAt` key the TS type expects.
      const rustHandlerBody = {
        success: true,
        data: [
          {
            name: 'README.md',
            path: 'C:/proj/README.md',
            type: 'file',
            extension: '.md',
            size: 42,
            modifiedAt: 1_700_000_000_000,
            ignored: undefined
          },
          {
            name: 'src',
            path: 'C:/proj/src',
            type: 'directory',
            extension: null,
            size: 0,
            modifiedAt: 1_700_000_000_001
            // `ignored` omitted (None on the Rust side; skip_serializing_if).
          }
        ]
      }
      mockFetch.mockResolvedValueOnce(jsonResponse(rustHandlerBody))

      const result = await webServerFilesystem.readDirectory('C:/proj')

      expect(result.success).toBe(true)
      if (!result.success) return // narrowing only; the above expect is the real assertion

      // The parsed DirectoryEntry fields match the wire body. The key being
      // `modifiedAt` (not `modified_at`) round-trips into `result.data` here
      // because the TS type is camelCase. If the Rust side ever regressed to
      // snake_case, the wire key would be `modified_at` and `result.data[0]`
      // would have `modified_at` while `modifiedAt` would be `undefined` —
      // the field assertion below catches it.
      expect(result.data).toHaveLength(2)
      const [readme, src] = result.data
      expect(readme.name).toBe('README.md')
      expect(readme.path).toBe('C:/proj/README.md')
      expect(readme.type).toBe('file')
      expect(readme.extension).toBe('.md')
      expect(readme.size).toBe(42)
      expect(readme.modifiedAt).toBe(1_700_000_000_000)
      expect(readme.ignored).toBeFalsy()
      expect(src.name).toBe('src')
      expect(src.path).toBe('C:/proj/src')
      expect(src.type).toBe('directory')
      expect(src.extension).toBeNull()
      expect(src.size).toBe(0)
      expect(src.modifiedAt).toBe(1_700_000_000_001)
      // `ignored` omitted in the wire JSON (None on the Rust side) → undefined.
      expect(src.ignored).toBeUndefined()
    })

    it('parses a failure body with camelCase-stable error/code fields', async () => {
      // The Rust `IpcBody::err` shape is camelCase-free for the error/code
      // fields (they're already single-word), but pin the round-trip through
      // `parseBody` so a future serde rename cannot silently break the
      // failure path either.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'boom', code: 'READ_ERROR' })
      )

      const result = await webServerFilesystem.readDirectory('/missing')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('boom')
        expect(result.code).toBe('READ_ERROR')
      }
    })
  })
})
