import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '@/types/settings'
import { applyUiZoom, clampUiZoom } from './use-ui-zoom'

// jsdom is not the Tauri webview, so applyUiZoom normally takes the CSS-`zoom`
// fallback. We selectively force the Tauri path for the failure-propagation
// test by mocking the webview module.
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn()
}))

describe('clampUiZoom', () => {
  it('clamps above the maximum', () => {
    expect(clampUiZoom(99)).toBe(UI_ZOOM_MAX)
  })

  it('clamps below the minimum', () => {
    expect(clampUiZoom(0)).toBe(UI_ZOOM_MIN)
  })

  it('passes an in-range value through unchanged', () => {
    expect(clampUiZoom(1.2)).toBe(1.2)
  })
})

describe('applyUiZoom', () => {
  beforeEach(() => {
    document.documentElement.style.zoom = ''
  })

  afterEach(() => {
    document.documentElement.style.zoom = ''
    vi.restoreAllMocks()
  })

  it('clamps to the maximum zoom factor', async () => {
    const applied = await applyUiZoom(99)
    expect(applied).toBe(UI_ZOOM_MAX)
    expect(document.documentElement.style.zoom).toBe(String(UI_ZOOM_MAX))
  })

  it('clamps to the minimum zoom factor', async () => {
    const applied = await applyUiZoom(0)
    expect(applied).toBe(UI_ZOOM_MIN)
    expect(document.documentElement.style.zoom).toBe(String(UI_ZOOM_MIN))
  })

  it('applies an in-range factor unchanged', async () => {
    const applied = await applyUiZoom(1.2)
    expect(applied).toBe(1.2)
    expect(document.documentElement.style.zoom).toBe('1.2')
  })

  it('propagates failures from the native zoom call', async () => {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    const setZoom = vi.fn().mockRejectedValue(new Error('boom'))
    vi.mocked(getCurrentWebview).mockReturnValue({ setZoom } as unknown as never)
    // Inject the Tauri internals marker so applyUiZoom takes the native path.
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
      writable: true
    })
    try {
      await expect(applyUiZoom(1)).rejects.toThrow('boom')
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })
})
