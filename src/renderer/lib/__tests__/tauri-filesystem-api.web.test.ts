/**
 * Web-branch tests for tauri-filesystem-api.ts.
 *
 * The desktop path (`@tauri-apps/plugin-fs`) is covered by the sibling
 * `tauri-filesystem-api.test.ts` (which pins `isTauriContext()` to true).
 * This file pins it to FALSE and asserts the facade delegates the
 * server-backed methods (`createDirectory`, `createFile`, `writeFile`,
 * `readDirectory`, `readFile`, `getFileInfo`, `deletePath`, `renameFile`,
 * `copyFile`) to `webServerFilesystem` — i.e. the fetch client that hits
 * `/fs/*`. The filename-search stream methods route through the one-shot
 * `GET /search/file-names` request + in-module batch/done emitters (issue
 * #848); `watchDirectory` and the content-search stream start/cancel still
 * return an explicit `WEB_UNSUPPORTED` result (no server transport yet).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

// The Tauri plugin-fs is imported by the facade module even in web mode (the
// desktop branch is in the same file). Mock it so the module loads without a
// real Tauri runtime. These are never called in the web branch.
vi.mock('@tauri-apps/plugin-fs', () => ({
  open: vi.fn(),
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  stat: vi.fn(),
  watchImmediate: vi.fn()
}))

import { _resetFilesystemStateForTesting, tauriFilesystemApi } from '../tauri-filesystem-api'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

describe('tauriFilesystemApi (web branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetFilesystemStateForTesting()
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('createDirectory delegates to webServerFilesystem (/fs/mkdir) when !isTauriContext()', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

    const result = await tauriFilesystemApi.createDirectory('/web/proj')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/fs/mkdir`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/web/proj' })
      })
    )
  })

  it('createFile delegates to webServerFilesystem (/fs/write) when !isTauriContext()', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

    const result = await tauriFilesystemApi.createFile('/web/proj/README.md', 'hi')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/fs/write`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/web/proj/README.md', content: 'hi' })
      })
    )
  })

  it('readDirectory delegates to webServerFilesystem (/fs/ls) when !isTauriContext()', async () => {
    const entries = [
      { name: 'src', path: '/web/src', type: 'directory', extension: null, size: 0, modifiedAt: 1 }
    ]
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: entries }))

    const result = await tauriFilesystemApi.readDirectory('/web')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(entries)
    }
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/fs/ls?path=${encodeURIComponent('/web')}`,
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('readDirectory normalizes Windows backslash entry paths to forward slashes (web)', async () => {
    // fs_api.rs `ls` joins paths with PathBuf and returns to_string_lossy() —
    // backslash separators on a Windows server. The file-explorer store keys
    // expandedDirs/directoryContents by normalizePath (`\`→`/`) but
    // FileTreeNode reads by raw entry.path; without this normalization the
    // desktop tree can't expand subdirs at level 2+ on web.
    const entries = [
      {
        name: 'src',
        path: 'C:\\web\\src',
        type: 'directory',
        extension: null,
        size: 0,
        modifiedAt: 1
      },
      {
        name: 'a.txt',
        path: 'C:\\web\\a.txt',
        type: 'file',
        extension: 'txt',
        size: 4,
        modifiedAt: 2
      }
    ]
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: entries }))

    const result = await tauriFilesystemApi.readDirectory('C:\\web')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.map((e) => e.path)).toEqual(['C:/web/src', 'C:/web/a.txt'])
    }
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/fs/ls?path=${encodeURIComponent('C:\\web')}`,
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('propagates a server-side failure body (e.g. MKDIR_ERROR) from the web client', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'permission denied', code: 'MKDIR_ERROR' })
    )

    const result = await tauriFilesystemApi.createDirectory('/bad')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('MKDIR_ERROR')
      expect(result.error).toBe('permission denied')
    }
  })

  it('maps a fetch throw to NETWORK_ERROR through the web branch', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'))

    const result = await tauriFilesystemApi.createDirectory('/x')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('NETWORK_ERROR')
    }
  })

  it('getFileInfo delegates to webServerFilesystem (/fs/info) when !isTauriContext()', async () => {
    const fileInfo = {
      path: '/web/file.txt',
      size: 100,
      modifiedAt: 1234567890,
      type: 'file',
      isReadOnly: false,
      isBinary: false
    }
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: fileInfo }))

    const result = await tauriFilesystemApi.getFileInfo('/web/file.txt')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(fileInfo)
    }
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/fs/info?path=${encodeURIComponent('/web/file.txt')}`,
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('getFileInfo returns directory metadata from /fs/info on web', async () => {
    const fileInfo = {
      path: '/web/dir',
      size: 0,
      modifiedAt: 1234567890,
      type: 'directory',
      isReadOnly: false,
      isBinary: false
    }
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: fileInfo }))

    const result = await tauriFilesystemApi.getFileInfo('/web/dir')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('directory')
    }
  })

  it('getFileInfo propagates a missing-path failure (STAT_ERROR) on web', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'not found', code: 'STAT_ERROR' })
    )

    const result = await tauriFilesystemApi.getFileInfo('/web/missing')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('STAT_ERROR')
    }
  })

  it('writeFile delegates to webServerFilesystem (/fs/write) when !isTauriContext()', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

    const result = await tauriFilesystemApi.writeFile('/web/existing.txt', 'new content')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/fs/write`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/web/existing.txt', content: 'new content' })
      })
    )
  })

  it('writeFile creates a new file via /fs/write on web', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

    const result = await tauriFilesystemApi.writeFile('/web/new.txt', 'hello')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBeUndefined()
    }
  })

  it('watchDirectory succeeds on web (#856: server-side watcher covers the project root)', async () => {
    const result = await tauriFilesystemApi.watchDirectory('/web/proj')

    // The server watches the active project root and broadcasts
    // `fs_changed` over the control WS — there is no per-directory client
    // setup, so the call reports success (a false WEB_UNSUPPORTED made
    // project switches treat the watcher as unavailable).
    expect(result.success).toBe(true)
    // No fetch/invoke should be attempted.
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('searchContentStreamStart returns WEB_UNSUPPORTED on web (no invoke)', async () => {
    const result = await tauriFilesystemApi.searchContentStreamStart(
      'id1',
      '/scope',
      '/root',
      'query'
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('searchContentStreamCancel returns WEB_UNSUPPORTED on web', async () => {
    const result = await tauriFilesystemApi.searchContentStreamCancel('id1')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
  })

  // Issue #848: filename search now routes through `GET /search/file-names`
  // on web (single batch + done through the in-module emitter) instead of
  // returning WEB_UNSUPPORTED.
  it('searchFileNamesStreamStart runs the one-shot HTTP search and emits batch + done (web)', async () => {
    const events: Array<Record<string, unknown>> = []
    const unsubBatch = tauriFilesystemApi.onSearchFileNamesBatch((event) => {
      events.push({ kind: 'batch', ...event })
    })
    const unsubDone = tauriFilesystemApi.onSearchFileNamesDone((event) => {
      events.push({ kind: 'done', ...event })
    })
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          files: [
            { path: 'src/alpha.ts', ignored: false },
            { path: 'node_modules/beta.js', ignored: true }
          ],
          truncated: true
        }
      })
    )

    const result = await tauriFilesystemApi.searchFileNamesStreamStart(
      'web-search-1',
      '/work/proj',
      '/work/proj',
      'query',
      true
    )

    expect(result.success).toBe(true)
    await vi.waitFor(() => {
      expect(events).toHaveLength(2)
    })
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/search/file-names?root=${encodeURIComponent(
        '/work/proj'
      )}&query=query&includeIgnored=true`,
      expect.objectContaining({ method: 'GET' })
    )
    const batch = events[0]
    expect(batch.kind).toBe('batch')
    expect(batch.searchId).toBe('web-search-1')
    expect(batch.files).toEqual([
      { path: 'src/alpha.ts', ignored: false },
      { path: 'node_modules/beta.js', ignored: true }
    ])
    expect(batch.truncated).toBe(true)
    const done = events[1]
    expect(done.kind).toBe('done')
    expect(done.searchId).toBe('web-search-1')
    expect(done.truncated).toBe(true)
    expect(done.totalFiles).toBe(2)
    expect(done.code).toBeUndefined()
    unsubBatch()
    unsubDone()
  })

  it('searchFileNamesStreamStart surfaces a transport failure as a done error event (web)', async () => {
    const doneEvents: Array<Record<string, unknown>> = []
    const unsubDone = tauriFilesystemApi.onSearchFileNamesDone((event) => {
      doneEvents.push(event as unknown as Record<string, unknown>)
    })
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'boom', code: 'SEARCH_ERROR' })
    )

    const result = await tauriFilesystemApi.searchFileNamesStreamStart(
      'web-search-2',
      '/work/proj',
      '/work/proj',
      'query'
    )

    expect(result.success).toBe(true)
    await vi.waitFor(() => {
      expect(doneEvents).toHaveLength(1)
    })
    expect(doneEvents[0].searchId).toBe('web-search-2')
    expect(doneEvents[0].code).toBe('NETWORK_ERROR')
    expect(doneEvents[0].error).toBe('boom')
    unsubDone()
  })

  it('searchFileNamesStreamCancel marks the web search cancelled (late batch dropped)', async () => {
    const batchEvents: Array<Record<string, unknown>> = []
    const unsubBatch = tauriFilesystemApi.onSearchFileNamesBatch((event) => {
      batchEvents.push(event as unknown as Record<string, unknown>)
    })

    const cancel = await tauriFilesystemApi.searchFileNamesStreamCancel('web-search-3')
    expect(cancel.success).toBe(true)

    // A start with the same id clears the cancellation (mirrors the desktop
    // stream, where a new start supersedes any prior cancel of that id).
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { files: [{ path: 'a.ts', ignored: false }], truncated: false }
      })
    )
    await tauriFilesystemApi.searchFileNamesStreamStart(
      'web-search-3',
      '/work/proj',
      '/work/proj',
      'q'
    )
    await vi.waitFor(() => {
      expect(batchEvents).toHaveLength(1)
    })
    expect(batchEvents[0].searchId).toBe('web-search-3')
    unsubBatch()
  })
})

// ---------------------------------------------------------------------------
// #856: web FS-change bridge — the control-WS `fs_changed` event dispatches
// through the shared onFileChanged/onFileCreated/onFileDeleted chain so the
// explorer tree refreshes (debounced, by useFileWatcher) exactly as it does
// on desktop.
// ---------------------------------------------------------------------------

describe('tauriFilesystemApi fs_changed bridge (web)', () => {
  // The bridge subscribes through the ACP transport; mock it to capture.
  const { mockAcpTransport } = vi.hoisted(() => {
    const listeners = new Map<string, (payload: unknown, seq?: number) => void>()
    const transport = {
      onEvent: vi.fn((eventName: string, callback: (payload: unknown, seq?: number) => void) => {
        listeners.set(eventName, callback)
        return () => listeners.delete(eventName)
      }),
      emit: (eventName: string, payload: unknown) => {
        listeners.get(eventName)?.(payload, 0)
      },
      listenerCount: () => listeners.size
    }
    return { mockAcpTransport: transport }
  })

  vi.mock('../acp-transport', () => ({
    getAcpTransport: () => mockAcpTransport
  }))

  beforeEach(() => {
    vi.clearAllMocks()
    _resetFilesystemStateForTesting()
    mockIsTauriContext.mockReturnValue(false)
  })

  it('subscribes on the first onFileChanged call (web) and dispatches fs_changed paths', () => {
    const received: Array<{ type: string; path: string }> = []
    const unsubscribe = tauriFilesystemApi.onFileChanged((event) => {
      received.push({ type: event.type, path: event.path })
    })

    // The bridge wired the control-WS subscription.
    expect(mockAcpTransport.onEvent).toHaveBeenCalledWith('acp:fs_changed', expect.any(Function))

    // A server batch arrives: paths under the watched root dispatch.
    mockAcpTransport.emit('acp:fs_changed', {
      root: '/web/proj',
      paths: ['/web/proj/src/new.ts', '/web/proj/README.md']
    })

    expect(received).toEqual([
      { type: 'change', path: '/web/proj/src/new.ts' },
      { type: 'change', path: '/web/proj/README.md' }
    ])

    unsubscribe()
  })

  it('filters paths outside the event root', () => {
    const received: string[] = []
    const unsubscribe = tauriFilesystemApi.onFileChanged((event) => {
      received.push(event.path)
    })

    mockAcpTransport.emit('acp:fs_changed', {
      root: '/web/proj',
      paths: ['/other/proj/file.ts', '/web/proj/src/a.ts']
    })

    // Only the in-root path dispatched (the tree refreshes the project's
    // own directories; foreign paths are not its concern).
    expect(received).toEqual(['/web/proj/src/a.ts'])

    unsubscribe()
  })

  it('ignores malformed payloads (no crash, no dispatch)', () => {
    const received: string[] = []
    const unsubscribe = tauriFilesystemApi.onFileDeleted((event) => {
      received.push(event.path)
    })

    mockAcpTransport.emit('acp:fs_changed', { root: '/web/proj' })
    mockAcpTransport.emit('acp:fs_changed', null)
    mockAcpTransport.emit('acp:fs_changed', { root: '/web/proj', paths: 'not-an-array' })

    expect(received).toEqual([])

    unsubscribe()
  })

  it('does not subscribe on Tauri (desktop uses the native watcher)', () => {
    mockIsTauriContext.mockReturnValue(true)
    // Reset the call log so ONLY this test's subscription is observed.
    mockAcpTransport.onEvent.mockClear()

    const unsubscribe = tauriFilesystemApi.onFileChanged(() => {})

    // The desktop posture must not register the WS bridge — the native
    // tauri-plugin-fs watcher owns change events there.
    expect(
      (mockAcpTransport.onEvent.mock.calls ?? []).some(
        (call: unknown[]) => call[0] === 'acp:fs_changed'
      )
    ).toBe(false)

    unsubscribe()
  })
})
