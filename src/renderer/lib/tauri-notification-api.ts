/**
 * Tauri Notification API adapter
 *
 * Provides desktop notification capabilities. Branches on `isTauriContext()`:
 * - Desktop: `@tauri-apps/plugin-notification` (OS notification).
 * - Web/remote: the Web Notifications API (`Notification.requestPermission()`
 *   + `new Notification(title, { body })`).
 *
 * Permission is requested eagerly at app startup (`initNotificationPermissions`
 * is called from `AppEffects` / `TauriApp`'s `AppEffects`). If the user denies
 * permission, the denial is cached so we don't re-prompt.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from '@tauri-apps/plugin-notification'
import { isTauriContext } from './tauri-runtime'

/** Cached permission state to avoid repeated OS prompts */
let permissionGranted: boolean | null = null

/**
 * In-flight initialization promise. The startup effect and a lazy init from
 * `sendDesktopNotification` may race while the first permission request is
 * pending; deduping to a single promise avoids a second OS/browser prompt.
 */
let permissionInitPromise: Promise<void> | null = null

/**
 * Initialize notification permissions.
 * Call this once during app startup to request permission early.
 * This avoids surprising the user with a permission prompt when a terminal exits.
 */
export function initNotificationPermissions(): Promise<void> {
  if (!permissionInitPromise) {
    permissionInitPromise = performInitNotificationPermissions().finally(() => {
      permissionInitPromise = null
    })
  }
  return permissionInitPromise
}

async function performInitNotificationPermissions(): Promise<void> {
  if (isTauriContext()) {
    try {
      const granted = await isPermissionGranted()

      if (granted) {
        permissionGranted = true
        return
      }

      // Permission is denied (not "not determined" on some platforms) or default
      // Try requesting once. If denied, cache it so we don't re-prompt.
      const result = await requestPermission()
      permissionGranted = result === 'granted'
    } catch (error) {
      console.error('[Notification] Failed to initialize notification permissions:', error)
      permissionGranted = false
    }
    return
  }

  // Web/remote: Web Notifications API. Guard `typeof Notification` for SSR /
  // test environments (jsdom does not expose `Notification`).
  if (typeof Notification === 'undefined') {
    permissionGranted = false
    return
  }

  try {
    // `Notification.permission` may already be 'granted' (no prompt needed).
    if (Notification.permission === 'granted') {
      permissionGranted = true
      return
    }

    const result = await Notification.requestPermission()
    permissionGranted = result === 'granted'
  } catch (error) {
    // Swallow — best-effort facade; never throw to the UI on permission failure.
    console.error('[Notification] Failed to request web notification permission:', error)
    permissionGranted = false
  }
}

/**
 * Send a desktop notification.
 * No-op if permission was denied or not yet initialized.
 *
 * @param title - Notification title (e.g., project name)
 * @param body - Notification body text (e.g., terminal name)
 */
export async function sendDesktopNotification(title: string, body: string): Promise<void> {
  if (permissionGranted === null) {
    // Permission not yet initialized — try to init now
    await initNotificationPermissions()
  }

  if (!permissionGranted) {
    if (import.meta.env.DEV) {
      console.log('[Notification] Permission not granted, skipping notification:', { title, body })
    }
    return
  }

  if (isTauriContext()) {
    try {
      sendNotification({ title, body })
    } catch (error) {
      console.error('[Notification] Failed to send notification:', error)
    }
    return
  }

  // Web/remote: Web Notifications API. Guard `typeof Notification` again for
  // SSR/test safety even though `initNotificationPermissions` already checked.
  if (typeof Notification === 'undefined') return

  try {
    new Notification(title, { body })
  } catch (error) {
    // Swallow — best-effort facade. A notification failure must never throw.
    console.error('[Notification] Failed to send web notification:', error)
  }
}

/**
 * @internal Testing only — reset the cached permission state so each test can
 * re-exercise the `isTauriContext()` branch from a clean slate.
 */
export function _resetNotificationPermissionForTesting(): void {
  permissionGranted = null
  permissionInitPromise = null
}
