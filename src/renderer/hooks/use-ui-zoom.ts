import { useEffect } from 'react'
import { getCurrentWebview } from '@/lib/tauri-webview'
import { useAppSettingsLoaded, useUiZoomLevel } from '@/stores/app-settings-store'
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '@/types/settings'

/** Clamp a zoom factor into the supported UI zoom bounds. */
export function clampUiZoom(level: number): number {
  return Math.min(Math.max(level, UI_ZOOM_MIN), UI_ZOOM_MAX)
}

/** True when running inside the Tauri desktop webview (vs. the plain web build). */
function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
  )
}

let appliedUiZoom = 1
let nativeZoomQueue: Promise<void> = Promise.resolve()

/**
 * Under native webview zoom, `getBoundingClientRect` reports zoomed CSS px
 * while the host positions native child webviews in window-logical px; this
 * is the factor between them.
 */
export function getAppliedUiZoom(): number {
  return appliedUiZoom
}

/**
 * Apply a whole-UI zoom factor to the window and resolve to the clamped value.
 *
 * In Tauri this uses the native webview zoom (same mechanism as the View menu),
 * which scales the entire UI — terminal canvas included — crisply, exactly like
 * VS Code / Electron window zoom. In the plain web build it falls back to the
 * CSS `zoom` property on the document root.
 *
 * The call is async because the Tauri `setZoom` IPC is async: callers that care
 * about whether the zoom actually took effect can `await` this and handle a
 * rejection (the web build resolves synchronously). This keeps the persisted
 * `uiZoomLevel` setting from silently desyncing with the real applied zoom when
 * the native call fails.
 */
export async function applyUiZoom(level: number): Promise<number> {
  const clamped = clampUiZoom(level)
  if (isTauri()) {
    // Serialized so a failed call cannot roll back a newer one's factor.
    const update = nativeZoomQueue.then(async () => {
      // Recorded before the await: the zoom reflow fires ResizeObservers that
      // must already read the new factor.
      const previous = appliedUiZoom
      appliedUiZoom = clamped
      try {
        await getCurrentWebview().setZoom(clamped)
      } catch (error) {
        appliedUiZoom = previous
        throw error
      }
    })
    nativeZoomQueue = update.catch(() => {})
    await update
  } else if (typeof document !== 'undefined') {
    document.documentElement.style.zoom = String(clamped)
  }
  return clamped
}

/**
 * Keep the applied window zoom in sync with the persisted `uiZoomLevel` setting.
 * Mount once at the app root (alongside `useAppliedColorThemeSync`). Failures to
 * apply the native zoom are logged rather than thrown so a transient IPC error
 * doesn't surface to the user as an unhandled rejection.
 */
export function useAppliedUiZoomSync(): void {
  const isLoaded = useAppSettingsLoaded()
  const uiZoomLevel = useUiZoomLevel()

  useEffect(() => {
    if (!isLoaded) return
    applyUiZoom(uiZoomLevel).catch((error) => {
      console.error('Failed to apply UI zoom:', error)
    })
  }, [isLoaded, uiZoomLevel])
}
