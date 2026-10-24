/**
 * GPUIX twin of `src/renderer/hooks/use-ui-zoom.ts`. The shared hook zooms
 * the Tauri webview or sets CSS `zoom` on the document root; GPUIX has
 * neither, so the factor goes to `shims/window-zoom.ts`, which scales the
 * whole native window the way the Tauri webview zoom does (browser zoom
 * semantics: the app keeps measuring in CSS px).
 */

import { useEffect } from 'react'
import { useAppSettingsLoaded, useUiZoomLevel } from '@/stores/app-settings-store'
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '@/types/settings'
import { log } from '../../log'
import { setWindowZoom, windowZoom } from '../../shims/window-zoom'

export function clampUiZoom(level: number): number {
  return Math.min(Math.max(level, UI_ZOOM_MIN), UI_ZOOM_MAX)
}

/** The factor between CSS px and window px. GPUIX has no native child webviews to place. */
export function getAppliedUiZoom(): number {
  return windowZoom()
}

export async function applyUiZoom(level: number): Promise<number> {
  const clamped = clampUiZoom(level)
  setWindowZoom(clamped)
  return clamped
}

export function useAppliedUiZoomSync(): void {
  const isLoaded = useAppSettingsLoaded()
  const uiZoomLevel = useUiZoomLevel()

  useEffect(() => {
    if (!isLoaded) return
    applyUiZoom(uiZoomLevel).catch((error: unknown) => {
      log.error(
        'ui-zoom',
        `failed to apply ${uiZoomLevel}: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }, [isLoaded, uiZoomLevel])
}
