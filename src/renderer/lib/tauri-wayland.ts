import { invokeIpcWrapped } from './ipc/tauri'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

/**
 * IPC Command name
 * Must match the Rust command in src-tauri/src/window_visibility/mod.rs
 */
const IS_WAYLAND_SESSION_COMMAND = 'is_wayland_session'

/**
 * Whether the desktop app is running in a Linux Wayland session (gh-719).
 *
 * Desktop-only: returns false outside Tauri. Wayland compositors ignore (or
 * never settle) client-side `setPosition`, so window-state restore skips it.
 * Any detection failure is logged and treated as non-Wayland.
 */
export async function isWaylandSession(): Promise<boolean> {
  if (!isTauriContext()) return false

  const result = await invokeIpcWrapped<boolean>(IS_WAYLAND_SESSION_COMMAND)
  if (!result.success) {
    void logFrontendError({
      level: 'warn',
      source: 'tauri-wayland',
      message: `Wayland session detection failed; assuming non-Wayland: ${result.error}`
    })
    return false
  }
  return result.data === true
}
