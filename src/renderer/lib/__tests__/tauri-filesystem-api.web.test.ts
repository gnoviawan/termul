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
 * #848); `watchDirectory` maps the path to a registered project and sends
 * `watch_project` (see the fs_changed bridge block); the content-search stream
 * start/cancel still return an explicit `WEB_UNSUPPORTED` result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

const { mockLogFrontendError } = vi.hoisted(() => ({ mockLogFrontendError: vi.fn() }))
vi.mock('../log-api', () => ({ logFrontendError: mockLogFrontendError }))

// Minimal project store: the facade only reads `getState().projects`.
// (The real store pulls the whole `lib/api` graph into this file's mocks.)
vi.mock('@/stores/project-store', () => {
  const state = { projects: [] as unknown[] }
  return {
    useProjectStore: {
      getState: () => state,
      setState: (next: { projects: unknown[] }) => {
        state.projects = next.projects
      }
    }
  }
})

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

import { useProjectStore } from '@/stores/project-store'
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

  it('searchFileNamesStreamStart passes kind:dir hits through the web batch unchanged', async () => {
    const batches: Array<{ files: unknown[] }> = []
    const unsubBatch = tauriFilesystemApi.onSearchFileNamesBatch((event) => {
      batches.push(event)
    })
    const files = [
      { path: 'src/components.ts', ignored: false },
      { path: 'src/renderer/components', ignored: false, kind: 'dir' },
      { path: 'node_modules/components', ignored: true, kind: 'dir' }
    ]
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { files, truncated: false } })
    )

    await tauriFilesystemApi.searchFileNamesStreamStart(
      'web-search-dir',
      '/work/proj',
      '/work/proj',
      'components',
      true
    )

    await vi.waitFor(() => {
      expect(batches).toHaveLength(1)
    })
    expect(batches[0].files).toEqual(files)
    unsubBatch()
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
      watchProject: vi.fn(async (_projectId: string) => undefined),
      unwatchProject: vi.fn(async (_projectId: string) => undefined),
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
    useProjectStore.setState({
      projects: [
        { id: 'proj-1', name: 'P1', color: 'blue', path: '/web/proj' },
        { id: 'proj-nested', name: 'Nested', color: 'green', path: '/web/proj/nested' },
        { id: 'proj-gone', name: 'Gone', color: 'red', path: '/web/gone', isArchived: true }
      ]
    })
  })

  it('watchDirectory asks the host to watch the containing project (refcounted per project)', async () => {
    const first = await tauriFilesystemApi.watchDirectory('/web/proj')
    const second = await tauriFilesystemApi.watchDirectory('/web/proj/src/')

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    // Two directories of one project share ONE host watch.
    expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(1)
    expect(mockAcpTransport.watchProject).toHaveBeenCalledWith('proj-1')
    expect(mockFetch).not.toHaveBeenCalled()

    await tauriFilesystemApi.unwatchDirectory('/web/proj')
    expect(mockAcpTransport.unwatchProject).not.toHaveBeenCalled()
    await tauriFilesystemApi.unwatchDirectory('/web/proj/src')
    expect(mockAcpTransport.unwatchProject).toHaveBeenCalledTimes(1)
    expect(mockAcpTransport.unwatchProject).toHaveBeenCalledWith('proj-1')
  })

  it('maps a nested path to the most specific project and ignores archived/unregistered paths', async () => {
    await tauriFilesystemApi.watchDirectory('/web/proj/nested/deep')
    expect(mockAcpTransport.watchProject).toHaveBeenCalledWith('proj-nested')

    mockAcpTransport.watchProject.mockClear()
    for (const dir of ['/web/gone', '/elsewhere']) {
      const result = await tauriFilesystemApi.watchDirectory(dir)
      // No registered project contains it: nothing to watch, not an error.
      expect(result.success).toBe(true)
    }
    expect(mockAcpTransport.watchProject).not.toHaveBeenCalled()
  })

  it('treats a failed host watch as non-fatal: success, logged, and nothing tracked', async () => {
    mockAcpTransport.watchProject.mockRejectedValueOnce(new Error('project not found'))

    const result = await tauriFilesystemApi.watchDirectory('/web/proj')

    // Live refresh is best-effort: the explorer root must still load.
    expect(result.success).toBe(true)
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: expect.stringContaining('watchWebDirectory')
      })
    )
    // The failed claim was rolled back: unwatch sends nothing, and a retry re-requests.
    await tauriFilesystemApi.unwatchDirectory('/web/proj')
    expect(mockAcpTransport.unwatchProject).not.toHaveBeenCalled()
    await tauriFilesystemApi.watchDirectory('/web/proj')
    expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(2)
  })

  it('overlapping watches of one directory send a single host watch and one unwatch', async () => {
    let release: () => void = () => {}
    mockAcpTransport.watchProject.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
    )

    const first = tauriFilesystemApi.watchDirectory('/web/proj')
    const second = tauriFilesystemApi.watchDirectory('/web/proj')
    await vi.waitFor(() => expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([first, second])

    expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(1)
    await tauriFilesystemApi.unwatchDirectory('/web/proj')
    expect(mockAcpTransport.unwatchProject).toHaveBeenCalledTimes(1)
  })

  it('an unwatch issued while the watch is in flight is sent after it, never lost', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    mockAcpTransport.watchProject.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            order.push('watch-done')
            resolve(undefined)
          }
        })
    )
    mockAcpTransport.unwatchProject.mockImplementationOnce(async () => {
      order.push('unwatch')
      return undefined
    })

    const watching = tauriFilesystemApi.watchDirectory('/web/proj')
    const unwatching = tauriFilesystemApi.unwatchDirectory('/web/proj')
    await vi.waitFor(() => expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([watching, unwatching])

    expect(order).toEqual(['watch-done', 'unwatch'])
  })

  it('does not drop an fs_changed that arrives before the watch reply resolves', async () => {
    const received: string[] = []
    const unsubscribe = tauriFilesystemApi.onFileChanged((event) => {
      received.push(event.path)
    })
    let release: () => void = () => {}
    mockAcpTransport.watchProject.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
    )

    const watching = tauriFilesystemApi.watchDirectory('/web/proj')
    mockAcpTransport.emit('acp:fs_changed', {
      projectId: 'proj-1',
      root: '/web/proj',
      paths: ['/web/proj/early.ts']
    })
    await vi.waitFor(() => expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(1))
    release()
    await watching

    expect(received).toEqual(['/web/proj/early.ts'])
    unsubscribe()
  })

  it('maps nested directories of a project rooted at / (or a drive root)', async () => {
    useProjectStore.setState({
      projects: [
        { id: 'root-proj', name: 'Root', color: 'blue', path: '/' },
        { id: 'drive-proj', name: 'Drive', color: 'green', path: 'C:\\' }
      ]
    })

    await tauriFilesystemApi.watchDirectory('/home/user/src')
    expect(mockAcpTransport.watchProject).toHaveBeenLastCalledWith('root-proj')
    await tauriFilesystemApi.watchDirectory('C:\\work\\app')
    expect(mockAcpTransport.watchProject).toHaveBeenLastCalledWith('drive-proj')
  })

  it('subscribes on the first onFileChanged call (web) and dispatches fs_changed paths', async () => {
    await tauriFilesystemApi.watchDirectory('/web/proj')
    const received: Array<{ type: string; path: string }> = []
    const unsubscribe = tauriFilesystemApi.onFileChanged((event) => {
      received.push({ type: event.type, path: event.path })
    })

    // The bridge wired the control-WS subscription.
    expect(mockAcpTransport.onEvent).toHaveBeenCalledWith('acp:fs_changed', expect.any(Function))

    // A server batch arrives: paths under the watched root dispatch.
    mockAcpTransport.emit('acp:fs_changed', {
      projectId: 'proj-1',
      root: '/web/proj',
      paths: ['/web/proj/src/new.ts', '/web/proj/README.md']
    })

    expect(received).toEqual([
      { type: 'change', path: '/web/proj/src/new.ts' },
      { type: 'change', path: '/web/proj/README.md' }
    ])

    unsubscribe()
  })

  it('re-requests a watch the host ended (fs_watch_ended), and ignores the event for other projects', async () => {
    const unsubscribe = tauriFilesystemApi.onFileChanged(() => {})
    await tauriFilesystemApi.watchDirectory('/web/proj')
    expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(1)

    // Another project's end does not disturb this watch.
    mockAcpTransport.emit('acp:fs_watch_ended', {
      projectId: 'proj-nested',
      reason: 'project_unavailable'
    })
    await tauriFilesystemApi.watchDirectory('/web/proj')
    expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(1)

    mockAcpTransport.emit('acp:fs_watch_ended', {
      projectId: 'proj-1',
      reason: 'project_unavailable'
    })
    await tauriFilesystemApi.watchDirectory('/web/proj')
    expect(mockAcpTransport.watchProject).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('drops fs_changed for a project this client is not watching', async () => {
    await tauriFilesystemApi.watchDirectory('/web/proj')
    const received: string[] = []
    const unsubscribe = tauriFilesystemApi.onFileChanged((event) => {
      received.push(event.path)
    })

    mockAcpTransport.emit('acp:fs_changed', {
      projectId: 'proj-nested',
      root: '/web/proj/nested',
      paths: ['/web/proj/nested/a.ts']
    })
    expect(received).toEqual([])

    await tauriFilesystemApi.unwatchDirectory('/web/proj')
    mockAcpTransport.emit('acp:fs_changed', {
      projectId: 'proj-1',
      root: '/web/proj',
      paths: ['/web/proj/late.ts']
    })
    expect(received).toEqual([])

    unsubscribe()
  })

  it('filters paths outside the event root', async () => {
    await tauriFilesystemApi.watchDirectory('/web/proj')
    const received: string[] = []
    const unsubscribe = tauriFilesystemApi.onFileChanged((event) => {
      received.push(event.path)
    })

    mockAcpTransport.emit('acp:fs_changed', {
      projectId: 'proj-1',
      root: '/web/proj',
      paths: ['/other/proj/file.ts', '/web/proj/src/a.ts']
    })

    // Only the in-root path dispatched (the tree refreshes the project's
    // own directories; foreign paths are not its concern).
    expect(received).toEqual(['/web/proj/src/a.ts'])

    unsubscribe()
  })

  it('normalizes a backslash root before the prefix check (Windows, CodeRabbit)', async () => {
    useProjectStore.setState({
      projects: [{ id: 'win', name: 'Win', color: 'blue', path: 'C:\\proj\\app' }]
    })
    await tauriFilesystemApi.watchDirectory('C:\\proj\\app')
    const received: string[] = []
    const unsubscribe = tauriFilesystemApi.onFileChanged((event) => {
      received.push(event.path)
    })

    mockAcpTransport.emit('acp:fs_changed', {
      projectId: 'win',
      root: 'C:\\proj\\app',
      paths: ['C:/proj/app/src/main.rs']
    })

    expect(received).toEqual(['C:/proj/app/src/main.rs'])

    unsubscribe()
  })

  it('ignores malformed payloads (no crash, no dispatch)', async () => {
    await tauriFilesystemApi.watchDirectory('/web/proj')
    const received: string[] = []
    const unsubscribe = tauriFilesystemApi.onFileDeleted((event) => {
      received.push(event.path)
    })

    mockAcpTransport.emit('acp:fs_changed', { projectId: 'proj-1', root: '/web/proj' })
    mockAcpTransport.emit('acp:fs_changed', null)
    mockAcpTransport.emit('acp:fs_changed', {
      projectId: 'proj-1',
      root: '/web/proj',
      paths: 'not-an-array'
    })

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
