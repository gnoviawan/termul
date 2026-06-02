/**
 * Tauri Notification API adapter
 *
 * Provides desktop notification capabilities through the Tauri notification plugin.
 * Falls back gracefully outside Tauri runtime (tests, browser context).
 *
 * Permission is requested eagerly at import time (when the app loads).
 * If the user denies permission, the denial is cached so we don't re-prompt.
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
 * Initialize notification permissions.
 * Call this once during app startup to request permission early.
 * This avoids surprising the user with a permission prompt when a terminal exits.
 */
export async function initNotificationPermissions(): Promise<void> {
  if (!isTauriContext()) {
    permissionGranted = false
    return
  }

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
}

/**
 * Send a desktop notification.
 * No-op if permission was denied or not yet initialized.
 *
 * @param title - Notification title (e.g., project name)
 * @param body - Notification body text (e.g., terminal name)
 */
export async function sendDesktopNotification(title: string, body: string): Promise<void> {
  if (!isTauriContext()) {
    if (import.meta.env.DEV) {
      console.log('[Notification] Skipping notification outside Tauri runtime:', { title, body })
    }
    return
  }

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

  try {
    sendNotification({ title, body })
  } catch (error) {
    console.error('[Notification] Failed to send notification:', error)
  }
}
