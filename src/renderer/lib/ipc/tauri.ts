/**
 * Shared Tauri `invoke()` helpers for the `lib/` IPC adapters.
 *
 * Two distinct flavors exist because Rust commands use two different return
 * conventions — do NOT merge them:
 *
 * - `invokeIpc` — the Rust handler already returns `IpcResult<T>`; the helper
 *   forwards it untouched and only maps a thrown invoke failure (Rust panic,
 *   IPC serialization error) to `{ success: false, code: 'INVOKE_ERROR' }`.
 *   Routing a bare-`T` command through this helper would return the raw
 *   payload with no `success` flag.
 * - `invokeIpcWrapped` — the Rust handler returns a bare `T`; the helper
 *   wraps it in `{ success: true, data }` and maps a thrown invoke failure to
 *   `{ success: false, code: 'UNKNOWN_ERROR' }`. Routing an
 *   `IpcResult`-returning command through this helper would double-wrap it.
 */

import type { IpcResult } from '@shared/types/ipc.types'
import { type InvokeArgs, invoke } from '@tauri-apps/api/core'

/**
 * Invoke a Tauri IPC command that already returns `IpcResult<T>` from Rust.
 * Maps a thrown invoke failure (Rust panic, IPC serialization error) to
 * `IpcResult { success: false, code: 'INVOKE_ERROR' }` so the renderer never
 * sees a thrown exception from the IPC layer.
 */
export async function invokeIpc<T>(command: string, args?: InvokeArgs): Promise<IpcResult<T>> {
  try {
    return await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INVOKE_ERROR'
    }
  }
}

/**
 * Invoke a Tauri IPC command whose Rust handler returns a bare `T` (NOT
 * `IpcResult<T>`) and wrap the resolved value in `IpcResult { success: true,
 * data }`. A thrown invoke failure maps to `IpcResult { success: false,
 * code: 'UNKNOWN_ERROR' }`.
 */
export async function invokeIpcWrapped<T>(
  command: string,
  args?: InvokeArgs
): Promise<IpcResult<T>> {
  try {
    const data = await invoke<T>(command, args)
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'UNKNOWN_ERROR'
    }
  }
}
