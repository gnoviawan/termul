import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './api-bridge'

/**
 * Native menu accelerators (e.g. ⌘W, ⌘R, ⌘C on macOS, Ctrl+W on Windows) are
 * handled by the OS menu before the key event reaches the webview, so the
 * shortcut recorder never sees them. While recording a keybinding we ask the
 * Rust side to remove the app menu, then restore it when recording ends.
 *
 * A refcount guards against overlapping recorders (e.g. clicking a second
 * recorder before the first blurs): the menu stays suspended until the last
 * active capture releases it.
 */
let activeCaptures = 0

// Serialize the suspend/restore IPC so the two commands can never land out of
// order. Without this, a fast blur-then-click between recorders (refcount
// 1 -> 0 -> 1) issues `restore` then `suspend` as independent IPC calls; if
// `suspend` (cheap) overtakes `restore` (rebuilds the menu) the menu would be
// left in place while the next recorder is still capturing.
let ipcQueue: Promise<void> = Promise.resolve()

function enqueueMenuIpc(command: 'suspend_app_menu' | 'restore_app_menu'): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await invoke(command)
    } catch {
      // Non-fatal: the recorder still works for combos the menu does not own,
      // and the menu is rebuilt on the next app launch regardless.
    }
  }
  ipcQueue = ipcQueue.then(run, run)
  return ipcQueue
}

export async function beginShortcutCapture(): Promise<void> {
  activeCaptures += 1
  if (activeCaptures > 1 || !isTauri()) return
  await enqueueMenuIpc('suspend_app_menu')
}

export async function endShortcutCapture(): Promise<void> {
  if (activeCaptures === 0) return
  activeCaptures -= 1
  if (activeCaptures > 0 || !isTauri()) return
  await enqueueMenuIpc('restore_app_menu')
}
