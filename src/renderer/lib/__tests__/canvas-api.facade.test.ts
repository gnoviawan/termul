/**
 * Canvas facade: the web branch calls `fetch` (POST /canvas/open|close with
 * the bearer header) and never `invoke`; the desktop branch calls `invoke`
 * and never `fetch`; both return the same `CanvasOpenInfo`; phone-width
 * viewports answer `UNSUPPORTED_SURFACE` without a transport call.
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

import type { CanvasOpenInfo } from '@shared/types/canvas.types'
import { canvasApi } from '../canvas-api'

const NARROW_QUERY = '(max-width: 767px)'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

const DOC = 'C:/proj/design.figcraft'
const PROJECT = 'proj-1'

const WEB_INFO: CanvasOpenInfo = {
  canvasId: 'cv0123456789abcdef',
  baseUrl: '',
  canvasToken: 'cafebabecafebabecafebabecafebabe',
  pinTag: 'termul-v1',
  docKey: DOC,
  mountSeq: 1
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
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalMatchMedia !== undefined) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
  })

  it('open: web → POST /canvas/open with docPath + projectId, no cookie written', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: WEB_INFO }))
    const cookieBefore = document.cookie
    const result = await canvasApi.open(DOC, PROJECT)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/canvas/open`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ docPath: DOC, projectId: PROJECT })
      })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: WEB_INFO })
    expect(document.cookie).toBe(cookieBefore)
  })

  it('open: web keeps the server-provided typed error code', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'outside the project', code: 'PATH_VALIDATION_FAILED' })
    )
    await expect(canvasApi.open(DOC, PROJECT)).resolves.toEqual({
      success: false,
      error: 'outside the project',
      code: 'PATH_VALIDATION_FAILED'
    })
  })

  it('open: web maps a transport failure to NETWORK_ERROR', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network gone'))
    const result = await canvasApi.open(DOC, PROJECT)
    expect(result).toMatchObject({ success: false, code: 'NETWORK_ERROR' })
  })

  it('open: desktop → invoke("canvas_open") returning the loopback base', async () => {
    mockIsTauriContext.mockReturnValue(true)
    const desktopInfo = { ...WEB_INFO, baseUrl: 'http://127.0.0.1:5199' }
    mockInvoke.mockResolvedValueOnce({ success: true, data: desktopInfo })
    const result = await canvasApi.open(DOC, PROJECT)
    expect(mockInvoke).toHaveBeenCalledWith('canvas_open', { docPath: DOC, projectId: PROJECT })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: desktopInfo })
  })

  it('close: web → POST /canvas/close with projectId and discard', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: true }))
    await expect(canvasApi.close(PROJECT)).resolves.toEqual({ success: true, data: true })
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/canvas/close`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: PROJECT, discard: false })
      })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('close: desktop → invoke("canvas_close") with projectId and discard', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ success: true, data: true })
    await canvasApi.close(PROJECT)
    expect(mockInvoke).toHaveBeenCalledWith('canvas_close', { projectId: PROJECT, discard: false })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('open: a phone-width viewport answers UNSUPPORTED_SURFACE without any transport call', async () => {
    matchesByQuery[NARROW_QUERY] = true
    await expect(canvasApi.open(DOC, PROJECT)).resolves.toEqual({
      success: false,
      error: 'canvas open is unavailable on the mobile web shell',
      code: 'UNSUPPORTED_SURFACE'
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('close stays available at phone width so a stray mount can still be released', async () => {
    matchesByQuery[NARROW_QUERY] = true
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: true }))
    await expect(canvasApi.close(PROJECT)).resolves.toEqual({ success: true, data: true })
  })

  const PERSISTENCE_CASES = [
    {
      name: 'readDocument',
      call: () => canvasApi.readDocument(PROJECT, 3),
      command: 'canvas_read_document',
      route: '/canvas/read-document',
      args: { projectId: PROJECT, mountSeq: 3 }
    },
    {
      name: 'documentLoaded',
      call: () => canvasApi.documentLoaded(PROJECT, 3, '{"contentVersion":7}'),
      command: 'canvas_document_loaded',
      route: '/canvas/document-loaded',
      args: { projectId: PROJECT, mountSeq: 3, ack: '{"contentVersion":7}' }
    },
    {
      name: 'dirtyChanged',
      call: () => canvasApi.dirtyChanged(PROJECT, 3, true, '9007199254740993'),
      command: 'canvas_dirty_changed',
      route: '/canvas/dirty-changed',
      args: { projectId: PROJECT, mountSeq: 3, dirty: true, contentVersion: '9007199254740993' }
    },
    {
      name: 'writeSnapshot',
      call: () => canvasApi.writeSnapshot(PROJECT, 3, '{"contentVersion":8,"bytes":"AA=="}'),
      command: 'canvas_write_snapshot',
      route: '/canvas/write-snapshot',
      args: { projectId: PROJECT, mountSeq: 3, snapshot: '{"contentVersion":8,"bytes":"AA=="}' }
    }
  ] as const

  for (const { name, call, command, route, args } of PERSISTENCE_CASES) {
    it(`${name}: web posts ${route} and desktop invokes ${command} with the same body`, async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: 1 } }))
      await expect(call()).resolves.toEqual({ success: true, data: { ok: 1 } })
      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}${route}`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify(args) })
      )
      expect(mockInvoke).not.toHaveBeenCalled()

      mockFetch.mockClear()
      mockIsTauriContext.mockReturnValue(true)
      mockInvoke.mockResolvedValueOnce({ success: true, data: { ok: 1 } })
      await expect(call()).resolves.toEqual({ success: true, data: { ok: 1 } })
      expect(mockInvoke).toHaveBeenCalledWith(command, args)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }
})
