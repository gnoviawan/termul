/**
 * Web-branch tests for tauri-filesystem-api.ts.
 *
 * The desktop path (`@tauri-apps/plugin-fs`) is covered by the sibling
 * `tauri-filesystem-api.test.ts` (which pins `isTauriContext()` to true).
 * This file pins it to FALSE and asserts the facade delegates the
 * server-backed methods (`createDirectory`, `createFile`, `writeFile`,
 * `readDirectory`, `readFile`, `getFileInfo`, `deletePath`, `renameFile`,
 * `copyFile`) to `webServerFilesystem` — i.e. the fetch client that hits
 * `/fs/*`. Methods without a server transport (`watchDirectory`, streaming
 * search start/cancel) return an explicit `WEB_UNSUPPORTED` result instead
 * of false success or silent `invoke()` failure.
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

import { i18n } from '../../i18n'
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
  beforeEach(async () => {
    await i18n.changeLanguage('en')
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

  it('watchDirectory returns WEB_UNSUPPORTED on web (no false success)', async () => {
    const result = await tauriFilesystemApi.watchDirectory('/web/proj')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
      expect(result.error).toContain('not available')
    }
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
      expect(result.error).toBe('Streaming search is not available in the web client')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('localizes unsupported streaming search errors in Simplified Chinese', async () => {
    await i18n.changeLanguage('zh-CN')

    const results = await Promise.all([
      tauriFilesystemApi.searchContentStreamStart('id1', '/scope', '/root', 'query'),
      tauriFilesystemApi.searchContentStreamCancel('id1'),
      tauriFilesystemApi.searchFileNamesStreamStart('id2', '/scope', '/root', 'query'),
      tauriFilesystemApi.searchFileNamesStreamCancel('id2')
    ])

    for (const result of results) {
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('WEB_UNSUPPORTED')
        expect(result.error).toBe('网页客户端暂不支持流式搜索')
      }
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

  it('searchFileNamesStreamStart returns WEB_UNSUPPORTED on web (no invoke)', async () => {
    const result = await tauriFilesystemApi.searchFileNamesStreamStart(
      'id2',
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

  it('searchFileNamesStreamCancel returns WEB_UNSUPPORTED on web', async () => {
    const result = await tauriFilesystemApi.searchFileNamesStreamCancel('id2')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
  })
})
