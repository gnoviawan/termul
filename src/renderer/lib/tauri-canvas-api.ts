/**
 * Tauri IPC implementation of the canvas facade (OpenPencil canvas mode).
 *
 * Mirrors the desktop `#[tauri::command] canvas_*` handlers in
 * `src-tauri/src/commands/canvas.rs`. The Rust commands already wrap their
 * results in `IpcResult<T>`, so this adapter maps `invoke()` → `IpcResult<T>`
 * without double-wrapping (via the shared `ipc/tauri.ts` `invokeIpc` helper).
 *
 * The web/remote fallback lives in `web-canvas-api.ts` and hits the three
 * HTTP routes in `src-tauri/src/web/canvas_api.rs`. Both impls return the
 * SAME `IpcResult<...>` shape byte-for-byte — the parity-checklist canvas
 * block pins this.
 */

import type {
  CanvasApi,
  CanvasOpenInfo,
  CanvasSaveResult,
  CanvasStatus
} from '@shared/types/canvas.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { invokeIpc } from './ipc/tauri'
import { isTauriContext } from './tauri-runtime'

/** IPC command names matching the Rust `#[tauri::command]` declarations. */
const IPC_COMMANDS = {
  OPEN: 'canvas_open',
  CLOSE: 'canvas_close',
  SAVE: 'canvas_save',
  STATUS: 'canvas_status'
} as const

function notTauri(method: string): IpcResult<never> {
  return {
    success: false,
    error: `${method} requires the Tauri runtime`,
    code: 'INVOKE_ERROR'
  }
}

/**
 * Build the Tauri IPC impl of [`CanvasApi`]. The singleton in
 * `canvas-api.ts` picks this when `isTauriContext()` is true; the guard
 * inside each method covers tests that construct this adapter directly.
 */
export function createTauriCanvasApi(): CanvasApi {
  return {
    async open(docPath: string, projectId: string): Promise<IpcResult<CanvasOpenInfo>> {
      if (!isTauriContext()) return notTauri(IPC_COMMANDS.OPEN)
      return invokeIpc<CanvasOpenInfo>(IPC_COMMANDS.OPEN, { docPath, projectId })
    },

    async close(docPath: string): Promise<IpcResult<boolean>> {
      if (!isTauriContext()) return notTauri(IPC_COMMANDS.CLOSE)
      return invokeIpc<boolean>(IPC_COMMANDS.CLOSE, { docPath })
    },

    async save(docPath: string): Promise<IpcResult<CanvasSaveResult>> {
      if (!isTauriContext()) return notTauri(IPC_COMMANDS.SAVE)
      return invokeIpc<CanvasSaveResult>(IPC_COMMANDS.SAVE, { docPath })
    },

    async status(): Promise<IpcResult<CanvasStatus>> {
      if (!isTauriContext()) return notTauri(IPC_COMMANDS.STATUS)
      return invokeIpc<CanvasStatus>(IPC_COMMANDS.STATUS)
    }
  }
}
