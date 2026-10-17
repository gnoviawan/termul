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
  webServerLog,
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

    it('preserves a structured failure body on non-2xx (web auth gate 401)', async () => {
      // The auth gate answers 401 with a valid IpcBody — the adapter must keep
      // the server's code/message instead of collapsing to NETWORK_ERROR.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
      )

      const result = await webServerFilesystem.createDirectory('/x')

      expect(result).toEqual({
        success: false,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED'
      })
    })

    it('falls back to NETWORK_ERROR when a non-2xx body is not a valid IpcBody', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse('<html>Bad Gateway</html>', 502))

      const result = await webServerFilesystem.createDirectory('/x')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('NETWORK_ERROR')
        expect(result.error).toContain('502')
      }
    })

    it('falls back to NETWORK_ERROR when a non-2xx body is unparseable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: () => Promise.reject(new Error('unexpected token'))
      })

      const result = await webServerFilesystem.createDirectory('/x')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('NETWORK_ERROR')
        expect(result.error).toContain('503')
      }
    })
  })

  describe('webServerLog.frontendError', () => {
    it('caps each field one char past the server limit so a 100 KB error still fits the 64 KiB body limit', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

      await webServerLog.frontendError({
        message: 'm'.repeat(100_000),
        source: 'unhandledrejection',
        stack: 's'.repeat(100_000)
      })

      const body = mockFetch.mock.calls[0][1].body as string
      expect(body.length).toBeLessThan(64 * 1024)
      expect(JSON.parse(body)).toEqual({
        level: 'error',
        message: 'm'.repeat(4097),
        source: 'unhandledrejection',
        stack: 's'.repeat(4097),
        componentStack: null
      })
    })

    it('cuts on code points so an astral char at the cap is not split into a lone surrogate', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

      await webServerLog.frontendError({ message: '\u{1F600}'.repeat(5000) })

      const { message } = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(message).toBe('\u{1F600}'.repeat(4097))
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

  // Issue #1363: a blackholed server (TCP open, no reply) must not strand a
  // web fs request forever. The editor's per-file save lock waits on it, and
  // a rename or paste of that file waits on the save.
  describe('web fs request timeouts', () => {
    function blackholedFetch(): void {
      // Settles only via the caller's abort signal, like a real fetch against
      // a server that never replies.
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          const fail = () =>
            reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
          if (signal?.aborted) return fail()
          signal?.addEventListener('abort', fail)
        })
      })
    }

    it('writeFile resolves NETWORK_ERROR after the 30s bound when the reply never arrives', async () => {
      vi.useFakeTimers()
      try {
        blackholedFetch()

        const pending = webServerFilesystem.writeFile('/proj/a.ts', 'x')
        // 30s request bound, then the ledgered command's awaited resend ladder
        // (1s + 2s + 4s, each same-id resend aborting on the spent signal).
        await vi.advanceTimersByTimeAsync(30_000 + 7_000)

        await expect(pending).resolves.toMatchObject({
          success: false,
          code: 'NETWORK_ERROR'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('readFile resolves NETWORK_ERROR after the 30s bound when the reply never arrives', async () => {
      vi.useFakeTimers()
      try {
        blackholedFetch()

        const pending = webServerFilesystem.readFile('/proj/a.ts')
        await vi.advanceTimersByTimeAsync(30_000)

        await expect(pending).resolves.toMatchObject({
          success: false,
          code: 'NETWORK_ERROR'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('readDirectory still resolves NETWORK_ERROR after the 30s bound', async () => {
      vi.useFakeTimers()
      try {
        blackholedFetch()

        const pending = webServerFilesystem.readDirectory('/proj')
        await vi.advanceTimersByTimeAsync(30_000)

        await expect(pending).resolves.toMatchObject({
          success: false,
          code: 'NETWORK_ERROR'
        })
      } finally {
        vi.useRealTimers()
      }
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

  describe('webServerGit.getDiffStat', () => {
    it('POSTs /git/diff-stat with { cwd } and returns the unwrapped stat', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { added: 3, removed: 1 } })
      )

      await expect(webServerGit.getDiffStat('/proj')).resolves.toEqual({ added: 3, removed: 1 })
      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/git/diff-stat`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ cwd: '/proj' })
        })
      )
    })

    it('throws the host error message on OUTSIDE_PROJECT_ROOT', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'outside root', code: 'OUTSIDE_PROJECT_ROOT' })
      )

      await expect(webServerGit.getDiffStat('/elsewhere')).rejects.toThrow('outside root')
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
