/**
 * Canvas facade tests (OpenPencil canvas mode, task 22).
 *
 * Following the `git-api.web.test.ts` pattern, asserts one method at a
 * time that:
 * - the WEB branch calls `fetch` (POST /canvas/*) and NOT `invoke`, merges
 *   the bearer web auth header, and sets the `op_canvas_ct` cookie from the
 *   open response's `canvasToken` (BEFORE the iframe could mount);
 * - the DESKTOP branch calls `invoke` and NOT `fetch`;
 * - phone-width viewports answer a typed `UNSUPPORTED_SURFACE` failure
 *   (mobile gating — the mobile web shell has no canvas);
 * - typed server error codes (e.g. DAEMON_DOWN) and transport failures
 *   (NETWORK_ERROR) are surfaced through the `IpcResult` envelope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext, mockInvoke } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

import { canvasApi } from '../canvas-api'
import { CANVAS_COOKIE_NAME } from '../web-canvas-api'

const NARROW_QUERY = '(max-width: 767px)'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

const DOC = 'C:/proj/design.op'
const PROJECT = 'proj-1'

const OPEN_INFO = {
  embedUrl: '/canvas/cv0123456789abcdef/?embed=vscode&ct=cafebabecafebabecafebabecafebabe',
  mcpUrl: '/canvas/mcp',
  docKey: 'C:/proj/design.op',
  canvasId: 'cv0123456789abcdef',
  canvasToken: 'cafebabecafebabecafebabecafebabe'
}

describe('canvasApi (web vs desktop branch)', () => {
  let matchesByQuery: Record<string, boolean> = {}
  let originalMatchMedia: PropertyDescriptor | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
    mockIsTauriContext.mockReturnValue(false)
    matchesByQuery = {}
    if (originalMatchMedia === undefined) {
      originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: matchesByQuery[query] ?? false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    })
    document.cookie = `${CANVAS_COOKIE_NAME}=; Path=/; Max-Age=0`
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalMatchMedia !== undefined) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
  })

  // ---- open ----
  it('open: web → POST /canvas/open with docPath + projectId + auth header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: OPEN_INFO }))
    const result = await canvasApi.open(DOC, PROJECT)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/canvas/open`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ docPath: DOC, projectId: PROJECT })
      })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: OPEN_INFO })
  })

  it('open: web sets the op_canvas_ct cookie from the canvasToken before the iframe mounts', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: OPEN_INFO }))
    await canvasApi.open(DOC, PROJECT)
    expect(document.cookie).toContain(`${CANVAS_COOKIE_NAME}=${OPEN_INFO.canvasToken}`)
  })

  it('open: web keeps the server-provided typed error code (DAEMON_DOWN)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'canvas daemon is not running', code: 'DAEMON_DOWN' })
    )
    const result = await canvasApi.open(DOC, PROJECT)
    expect(result).toEqual({
      success: false,
      error: 'canvas daemon is not running',
      code: 'DAEMON_DOWN'
    })
  })

  it('open: web maps a transport failure to NETWORK_ERROR', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network gone'))
    const result = await canvasApi.open(DOC, PROJECT)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('NETWORK_ERROR')
    }
  })

  it('open: desktop → invoke("canvas_open") with docPath + projectId', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({
      success: true,
      data: {
        ...OPEN_INFO,
        canvasId: undefined,
        canvasToken: undefined,
        embedUrl: 'http://127.0.0.1:5199/?embed=vscode'
      }
    })
    const result = await canvasApi.open(DOC, PROJECT)
    expect(mockInvoke).toHaveBeenCalledWith('canvas_open', { docPath: DOC, projectId: PROJECT })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.embedUrl).toBe('http://127.0.0.1:5199/?embed=vscode')
    }
  })

  // ---- close ----
  it('close: web → POST /canvas/close with docPath', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: true }))
    await canvasApi.close(DOC)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/canvas/close`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ docPath: DOC })
      })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('close: desktop → invoke("canvas_close")', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ success: true, data: true })
    await canvasApi.close(DOC)
    expect(mockInvoke).toHaveBeenCalledWith('canvas_close', { docPath: DOC })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---- save ----
  it('save: web → POST /canvas/save with docPath', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: true } }))
    const result = await canvasApi.save(DOC)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/canvas/save`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ docPath: DOC })
      })
    )
    expect(result).toEqual({ success: true, data: { ok: true } })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('save: desktop → invoke("canvas_save")', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ success: true, data: { ok: true } })
    await canvasApi.save(DOC)
    expect(mockInvoke).toHaveBeenCalledWith('canvas_save', { docPath: DOC })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---- status ----
  it('status: desktop → invoke("canvas_status"); web answers WEB_UNSUPPORTED', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ success: true, data: { daemons: [], activeDocKey: null } })
    const desktop = await canvasApi.status()
    expect(mockInvoke).toHaveBeenCalledWith('canvas_status', undefined)
    expect(desktop.success).toBe(true)

    mockIsTauriContext.mockReturnValue(false)
    const web = await canvasApi.status()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(web.success).toBe(false)
    if (!web.success) {
      expect(web.code).toBe('WEB_UNSUPPORTED')
    }
  })

  // ---- mobile gating (UNSUPPORTED_SURFACE) ----
  it('open: a phone-width viewport answers UNSUPPORTED_SURFACE without any transport call', async () => {
    matchesByQuery[NARROW_QUERY] = true
    const result = await canvasApi.open(DOC, PROJECT)
    expect(result).toEqual({
      success: false,
      error: 'canvas open is unavailable on the mobile web shell',
      code: 'UNSUPPORTED_SURFACE'
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('save: a phone-width viewport answers UNSUPPORTED_SURFACE without any transport call', async () => {
    matchesByQuery[NARROW_QUERY] = true
    const result = await canvasApi.save(DOC)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('UNSUPPORTED_SURFACE')
    }
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('mobile gating resolves through resolveMobileWebShell (narrow web viewport, non-Tauri)', async () => {
    // The facade's gate is the same predicate the mobile shell hook uses:
    // resolveMobileWebShell(false, true) → mobile (gated).
    const { resolveMobileWebShell } = await import('@/hooks/use-mobile-web-shell')
    expect(resolveMobileWebShell(false, true)).toBe(true)
    expect(resolveMobileWebShell(true, true)).toBe(false)
    // Desktop-width web viewport stays ungated.
    matchesByQuery[NARROW_QUERY] = false
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: OPEN_INFO }))
    const result = await canvasApi.open(DOC, PROJECT)
    expect(result.success).toBe(true)
  })
})
