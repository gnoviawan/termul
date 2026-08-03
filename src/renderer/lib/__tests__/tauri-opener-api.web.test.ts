/**
 * Web-branch tests for tauri-opener-api.ts (CAP-3: Web UI entry parity).
 *
 * `openUrlWithSystemBrowser` branches on `isTauriContext()`: desktop calls
 * `@tauri-apps/plugin-opener`'s `openUrl(url)`; web/remote calls
 * `window.open(url, '_blank', 'noopener')`. The other two methods
 * (`openWithExternalApp`, `revealInFileManager`) have no browser equivalent
 * and stay desktop-only — they call the Tauri plugin in both modes (the web
 * build's stubbed plugin throws `tauriUnavailable`, which the methods wrap
 * into an `IpcResult` error).
 *
 * This file asserts, per the `log-api.test.ts` dual-branch pattern, that:
 * - the WEB branch of `openUrlWithSystemBrowser` calls `window.open` and NOT `openUrl`
 * - the DESKTOP branch calls `openUrl` and NOT `window.open`
 * - `openWithExternalApp`/`revealInFileManager` call the Tauri plugin in both modes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockOpenPath, mockOpenUrl, mockRevealItemInDir, mockIsTauriContext, mockWindowOpen } =
  vi.hoisted(() => ({
    mockOpenPath: vi.fn(),
    mockOpenUrl: vi.fn(),
    mockRevealItemInDir: vi.fn(),
    mockIsTauriContext: vi.fn(),
    mockWindowOpen: vi.fn()
  }))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: mockOpenPath,
  openUrl: mockOpenUrl,
  revealItemInDir: mockRevealItemInDir
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

import { openerApi } from '../tauri-opener-api'

const URL = 'https://github.com/gnoviawan/termul/releases/tag/v0.4.8'
const PATH = '/some/path/file.txt'

describe('openerApi.openUrlWithSystemBrowser (web vs desktop branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWindowOpen.mockReset()
    vi.stubGlobal('open', mockWindowOpen)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('web: calls window.open(url, "_blank", "noopener")', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockWindowOpen.mockReturnValue(null)

    const result = await openerApi.openUrlWithSystemBrowser(URL)

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockWindowOpen).toHaveBeenCalledWith(URL, '_blank', 'noopener')
    expect(mockOpenUrl).not.toHaveBeenCalled()
  })

  it('web: returns success even when popup blocker returns null (best-effort)', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockWindowOpen.mockReturnValue(null)

    const result = await openerApi.openUrlWithSystemBrowser(URL)

    expect(result.success).toBe(true)
  })

  it('web: swallows SecurityError from window.open (best-effort)', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockWindowOpen.mockImplementation(() => {
      throw new Error('SecurityError: blocked')
    })

    const result = await openerApi.openUrlWithSystemBrowser(URL)

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockWindowOpen).toHaveBeenCalledWith(URL, '_blank', 'noopener')
  })

  it('web: no-ops for non-http(s)/mailto schemes (javascript:/data:) — no window.open', async () => {
    mockIsTauriContext.mockReturnValue(false)

    for (const dangerous of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const result = await openerApi.openUrlWithSystemBrowser(dangerous)

      expect(result).toEqual({ success: true, data: undefined })
    }
    expect(mockWindowOpen).not.toHaveBeenCalled()
  })

  it('desktop: calls openUrl(url) and NOT window.open', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockOpenUrl.mockResolvedValue(undefined)

    const result = await openerApi.openUrlWithSystemBrowser(URL)

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockOpenUrl).toHaveBeenCalledWith(URL)
    expect(mockWindowOpen).not.toHaveBeenCalled()
  })

  it('desktop: returns error result when openUrl rejects', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockOpenUrl.mockRejectedValue(new Error('native opener failed'))

    const result = await openerApi.openUrlWithSystemBrowser(URL)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('OPEN_URL_ERROR')
      expect(result.error).toBe('native opener failed')
    }
  })
})

describe('openWithExternalApp (no web branch — desktop-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWindowOpen.mockReset()
    vi.stubGlobal('open', mockWindowOpen)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('web: still calls the Tauri plugin (no web branch)', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockOpenPath.mockRejectedValue(new Error('unavailable in web build'))

    const result = await openerApi.openWithExternalApp(PATH)

    expect(mockOpenPath).toHaveBeenCalledWith(PATH)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('OPEN_ERROR')
    }
    // Must NOT use window.open — no browser equivalent for "open with external app".
    expect(mockWindowOpen).not.toHaveBeenCalled()
  })

  it('desktop: calls openPath(path)', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockOpenPath.mockResolvedValue(undefined)

    const result = await openerApi.openWithExternalApp(PATH)

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockOpenPath).toHaveBeenCalledWith(PATH)
  })
})

describe('revealInFileManager (no web branch — desktop-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWindowOpen.mockReset()
    vi.stubGlobal('open', mockWindowOpen)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('web: still calls the Tauri plugin (no web branch)', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockRevealItemInDir.mockRejectedValue(new Error('unavailable in web build'))

    const result = await openerApi.revealInFileManager(PATH)

    expect(mockRevealItemInDir).toHaveBeenCalledWith(PATH)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('REVEAL_ERROR')
    }
    expect(mockWindowOpen).not.toHaveBeenCalled()
  })

  it('desktop: calls revealItemInDir(path)', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockRevealItemInDir.mockResolvedValue(undefined)

    const result = await openerApi.revealInFileManager(PATH)

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockRevealItemInDir).toHaveBeenCalledWith(PATH)
  })
})
