import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '@/types/settings'
import { applyUiZoom } from './use-ui-zoom'

describe('applyUiZoom', () => {
  beforeEach(() => {
    document.documentElement.style.zoom = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.style.zoom = ''
  })

  it('clamps to the maximum zoom factor', () => {
    // jsdom is not the Tauri webview, so the CSS-zoom fallback path runs.
    const applied = applyUiZoom(99)
    expect(applied).toBe(UI_ZOOM_MAX)
    expect(document.documentElement.style.zoom).toBe(String(UI_ZOOM_MAX))
  })

  it('clamps to the minimum zoom factor', () => {
    const applied = applyUiZoom(0)
    expect(applied).toBe(UI_ZOOM_MIN)
    expect(document.documentElement.style.zoom).toBe(String(UI_ZOOM_MIN))
  })

  it('applies an in-range factor unchanged', () => {
    const applied = applyUiZoom(1.2)
    expect(applied).toBe(1.2)
    expect(document.documentElement.style.zoom).toBe('1.2')
  })
})
