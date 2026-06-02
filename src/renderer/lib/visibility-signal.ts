/**
 * Visibility Signal — resolves when the app window becomes visible.
 *
 * Problem:
 * In production builds, the Tauri window starts with `"visible": false`.
 * `TauriApp.tsx` calls `showWindow()` asynchronously after mount, but React
 * effects (including `useTerminalRestore`, `useVisibilityState`) fire
 * immediately — while the window is still hidden. This causes:
 *   - `useVisibilityState` sets `isAppHidden=true` before `showWindow()` resolves
 *   - `useTerminalRestore` spawns terminals during the hidden phase
 *   - The Rust backend defers PTY cleanup for hidden terminals (manager.rs:993)
 *   - Accumulated PTYs and zombie store entries cause RAM to climb
 *
 * This module provides a simple promise-based gate that `useTerminalRestore`
 * (and any other spawn-sensitive hook) can await before doing work.
 *
 * Auto-resolve: If `document.visibilityState === 'visible'` when this module
 * loads (typical in browser dev, test environments, and after hot reload),
 * the signal resolves immediately. Only production builds with
 * `"visible": false` benefit from the deferred resolution path.
 */

let resolveSignal: (() => void) | null = null
let visibleReady = false

const signalPromise = new Promise<void>((resolve) => {
  resolveSignal = resolve
})

/**
 * Mark the app as visibility-ready. Called once when the window becomes
 * visible for the first time (from `useVisibilityState` or `showWindow`).
 * Idempotent — subsequent calls are no-ops.
 */
export function markVisible(): void {
  if (visibleReady) return
  visibleReady = true
  resolveSignal?.()
  resolveSignal = null
}

/**
 * Wait until the app window is visible. Returns immediately if already
 * visible. Used by terminal restore and other spawn-sensitive code paths.
 */
export function waitForVisibility(): Promise<void> {
  if (visibleReady) return Promise.resolve()

  // Check document visibility at call time — resolves instantly in tests and
  // dev environments where the window is already visible.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    markVisible()
    return Promise.resolve()
  }

  // Safety timeout: if visibility never fires (e.g. test environment),
  // resolve after 5 seconds so the app doesn't hang forever.
  return Promise.race([signalPromise, new Promise<void>((resolve) => setTimeout(resolve, 5000))])
}

/**
 * Check if the app has become visible at least once.
 */
export function isVisibleReady(): boolean {
  return visibleReady
}

// Auto-resolve when the document is already visible (dev server, tests,
// hot reload, non-Tauri browser). Only deferred in production builds
// where tauri.conf.json sets `"visible": false`.
if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
  markVisible()
}
