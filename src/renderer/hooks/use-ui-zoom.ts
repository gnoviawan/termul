import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useEffect } from 'react'
import { useAppSettingsLoaded, useUiZoomLevel } from '@/stores/app-settings-store'
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '@/types/settings'

/** True when running inside the Tauri desktop webview (vs. the plain web build). */
function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
  )
}

/**
 * Apply a whole-UI zoom factor to the window.
 *
 * In Tauri this uses the native webview zoom (same mechanism as the View menu),
 * which scales the entire UI — terminal canvas included — crisply, exactly like
 * VS Code / Electron window zoom. In the plain web build it falls back to the
 * CSS `zoom` property on the document root.
 *
 * Returns the clamped factor that was actually applied.
 */
export function applyUiZoom(level: number): number {
  const clamped = Math.min(Math.max(level, UI_ZOOM_MIN), UI_ZOOM_MAX)
  if (isTauri()) {
    void getCurrentWebview()
      .setZoom(clamped)
      .catch((error) => {
        console.error('Failed to apply webview zoom:', error)
      })
  } else if (typeof document !== 'undefined') {
    document.documentElement.style.zoom = String(clamped)
  }
  return clamped
}

/**
 * Keep the applied window zoom in sync with the persisted `uiZoomLevel` setting.
 * Mount once at the app root (alongside `useAppliedColorThemeSync`).
 */
export function useAppliedUiZoomSync(): void {
  const isLoaded = useAppSettingsLoaded()
  const uiZoomLevel = useUiZoomLevel()

  useEffect(() => {
    if (!isLoaded) return
    applyUiZoom(uiZoomLevel)
  }, [isLoaded, uiZoomLevel])
}
