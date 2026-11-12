/**
 * Web-branch tests for tauri-opener-api.ts (CAP-3: Web UI entry parity).
 *
 * `openUrlWithSystemBrowser` branches on `isTauriContext()`: desktop calls
 * `@tauri-apps/plugin-opener`'s `openUrl(url)`; web/remote calls
 * `window.open(url, '_blank')`. The other two methods
 * (`openWithExternalApp`, `revealInFileManager`) have no browser equivalent
 * and return an explicit `WEB_UNSUPPORTED` result on web — they never reach
 * the stubbed plugin (which would throw `tauriUnavailable`).
 *
 * This file asserts, per the `log-api.test.ts` dual-branch pattern, that:
 * - the WEB branch of `openUrlWithSystemBrowser` calls `window.open` and NOT `openUrl`
 * - the DESKTOP branch calls `openUrl` and NOT `window.open`
 * - `openWithExternalApp`/`revealInFileManager` return `WEB_UNSUPPORTED` on web
 *   (no plugin call) and succeed on desktop (plugin call)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockOpenPath,
  mockOpenUrl,
  mockRevealItemInDir,
  mockIsTauriContext,
  mockWindowOpen,
  mockPlatform
} = vi.hoisted(() => ({
  mockOpenPath: vi.fn(),
  mockOpenUrl: vi.fn(),
  mockRevealItemInDir: vi.fn(),
  mockIsTauriContext: vi.fn(),
  mockWindowOpen: vi.fn(),
  mockPlatform: vi.fn(() => 'windows')
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: mockOpenPath,
  openUrl: mockOpenUrl,
  revealItemInDir: mockRevealItemInDir
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('../tauri-os', () => ({
  platform: mockPlatform
}))

import { openerApi } from '../tauri-opener-api'

const URL = 'https://github.com/gnoviawan/troupe/releases/tag/v0.4.8'
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

  it('web: calls window.open(url, "_blank") and clears the opener handle', async () => {
    mockIsTauriContext.mockReturnValue(false)
    const openedWindow: { opener: unknown } = { opener: {} }
    mockWindowOpen.mockReturnValue(openedWindow)

    const result = await openerApi.openUrlWithSystemBrowser(URL)

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockWindowOpen).toHaveBeenCalledWith(URL, '_blank')
    // 'noopener' is not in the feature string (it would make the null check
    // lie), so the opener reference is cleared manually instead.
    expect(openedWindow.opener).toBeNull()
    expect(mockOpenUrl).not.toHaveBeenCalled()
  })

  it('web: returns OPEN_URL_ERROR when the popup blocker returns null', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockWindowOpen.mockReturnValue(null)

    const result = await openerApi.openUrlWithSystemBrowser(URL)

    // An honest failure: callers reporting "the issue page opened" must not
    // get a `success: true` for a tab that never appeared.
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('OPEN_URL_ERROR')
    }
    expect(mockWindowOpen).toHaveBeenCalledWith(URL, '_blank')
  })

  it('web: returns OPEN_URL_ERROR when window.open throws (SecurityError)', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockWindowOpen.mockImplementation(() => {
      throw new Error('SecurityError: blocked')
    })

    const result = await openerApi.openUrlWithSystemBrowser(URL)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('OPEN_URL_ERROR')
      expect(result.error).toBe('SecurityError: blocked')
    }
    expect(mockWindowOpen).toHaveBeenCalledWith(URL, '_blank')
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

describe('openWithExternalApp (web branch: WEB_UNSUPPORTED)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWindowOpen.mockReset()
    vi.stubGlobal('open', mockWindowOpen)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('web: returns WEB_UNSUPPORTED without calling the Tauri plugin', async () => {
    mockIsTauriContext.mockReturnValue(false)

    const result = await openerApi.openWithExternalApp(PATH)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    // Must NOT call the stubbed plugin (which would throw tauriUnavailable).
    expect(mockOpenPath).not.toHaveBeenCalled()
    // Must NOT use window.open — no browser equivalent.
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

describe('revealInFileManager (web branch: WEB_UNSUPPORTED)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWindowOpen.mockReset()
    vi.stubGlobal('open', mockWindowOpen)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mockPlatform.mockReturnValue('windows')
  })

  it('web: returns WEB_UNSUPPORTED without calling the Tauri plugin', async () => {
    mockIsTauriContext.mockReturnValue(false)

    const result = await openerApi.revealInFileManager(PATH)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockRevealItemInDir).not.toHaveBeenCalled()
    expect(mockWindowOpen).not.toHaveBeenCalled()
  })

  it('desktop: calls revealItemInDir(path)', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockRevealItemInDir.mockResolvedValue(undefined)

    const result = await openerApi.revealInFileManager(PATH)

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockRevealItemInDir).toHaveBeenCalledWith(PATH)
  })

  it('desktop: drops the verbatim prefix the Windows explorer paths carry', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockRevealItemInDir.mockResolvedValue(undefined)

    await openerApi.revealInFileManager('//?/E:/pawbytes/agents/pawbytes-skill-suites/skills')
    await openerApi.revealInFileManager(String.raw`\\?\UNC\srv\share\docs`)

    expect(mockRevealItemInDir.mock.calls).toEqual([
      ['E:/pawbytes/agents/pawbytes-skill-suites/skills'],
      [String.raw`\\srv\share\docs`]
    ])
  })

  it('desktop: keeps a Windows verbatim path that has no plain spelling', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockRevealItemInDir.mockResolvedValue(undefined)
    const volume = String.raw`\\?\Volume{0b1c2d3e-0000-0000-0000-100000000000}\proj`

    await openerApi.revealInFileManager(volume)

    expect(mockRevealItemInDir).toHaveBeenCalledWith(volume)
  })

  it('desktop: leaves a //?/ path alone outside Windows', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockPlatform.mockReturnValue('linux')
    mockRevealItemInDir.mockResolvedValue(undefined)
    mockOpenPath.mockResolvedValue(undefined)

    await openerApi.revealInFileManager('//?/C:/project/readme.md')
    await openerApi.openWithExternalApp('//?/notes.txt')

    expect(mockRevealItemInDir).toHaveBeenCalledWith('//?/C:/project/readme.md')
    expect(mockOpenPath).toHaveBeenCalledWith('//?/notes.txt')
  })

  it('desktop: keeps the prefix on a name only the verbatim form can reach', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockRevealItemInDir.mockResolvedValue(undefined)
    mockOpenPath.mockResolvedValue(undefined)
    const names = [
      '//?/E:/pawbytes/notes.',
      String.raw`\\?\E:\pawbytes\draft \a.md`,
      String.raw`\\?\C:\project\AUX.txt`,
      '//?/C:/project/com1/x.md'
    ]

    for (const name of names) await openerApi.openWithExternalApp(name)
    await openerApi.revealInFileManager(names[2])

    expect(mockOpenPath.mock.calls).toEqual(names.map((name) => [name]))
    expect(mockRevealItemInDir).toHaveBeenCalledWith(names[2])
  })

  it('desktop: strips the prefix when the names only look reserved', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockOpenPath.mockResolvedValue(undefined)

    await openerApi.openWithExternalApp('//?/C:/project/auxiliary/console.txt')

    expect(mockOpenPath).toHaveBeenCalledWith('C:/project/auxiliary/console.txt')
  })

  it('desktop: opens a verbatim Windows path without its prefix', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockOpenPath.mockResolvedValue(undefined)

    await openerApi.openWithExternalApp('//?/E:/pawbytes/notes.pdf')

    expect(mockOpenPath).toHaveBeenCalledWith('E:/pawbytes/notes.pdf')
  })
})
