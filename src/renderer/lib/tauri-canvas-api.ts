/**
 * Tauri IPC implementation of the canvas facade. Mirrors the
 * `#[tauri::command] canvas_*` handlers in `src-tauri/src/commands/canvas.rs`,
 * which already return `IpcResult<T>`. The web twin is `web-canvas-api.ts`;
 * the parity checklist pins both.
 */

import type {
  CanvasApi,
  CanvasCloseOutcome,
  CanvasDirtyOutcome,
  CanvasDocumentBytes,
  CanvasOpenInfo,
  CanvasPersistenceView,
  CanvasWriteOutcome
} from '@shared/types/canvas.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { invokeIpc } from './ipc/tauri'
import { isTauriContext } from './tauri-runtime'

const IPC_COMMANDS = {
  OPEN: 'canvas_open',
  CLOSE: 'canvas_close',
  READ_DOCUMENT: 'canvas_read_document',
  DOCUMENT_LOADED: 'canvas_document_loaded',
  DIRTY_CHANGED: 'canvas_dirty_changed',
  WRITE_SNAPSHOT: 'canvas_write_snapshot'
} as const

function notTauri(method: string): IpcResult<never> {
  return {
    success: false,
    error: `${method} requires the Tauri runtime`,
    code: 'INVOKE_ERROR'
  }
}

function invokeCanvas<T>(command: string, args: Record<string, unknown>): Promise<IpcResult<T>> {
  if (!isTauriContext()) return Promise.resolve(notTauri(command))
  return invokeIpc<T>(command, args)
}

/** Build the Tauri IPC impl of [`CanvasApi`]; `canvas-api.ts` picks it when
 * `isTauriContext()` is true. */
export function createTauriCanvasApi(): CanvasApi {
  return {
    open(
      docPath: string,
      projectId: string,
      autosaveMs?: number
    ): Promise<IpcResult<CanvasOpenInfo>> {
      return invokeCanvas(IPC_COMMANDS.OPEN, { docPath, projectId, autosaveMs })
    },

    close(projectId: string, discard = false): Promise<IpcResult<CanvasCloseOutcome>> {
      return invokeCanvas(IPC_COMMANDS.CLOSE, { projectId, discard })
    },

    readDocument(projectId: string, mountSeq: number): Promise<IpcResult<CanvasDocumentBytes>> {
      return invokeCanvas(IPC_COMMANDS.READ_DOCUMENT, { projectId, mountSeq })
    },

    documentLoaded(
      projectId: string,
      mountSeq: number,
      ack: string | null
    ): Promise<IpcResult<CanvasPersistenceView>> {
      return invokeCanvas(IPC_COMMANDS.DOCUMENT_LOADED, { projectId, mountSeq, ack })
    },

    dirtyChanged(
      projectId: string,
      mountSeq: number,
      dirty: boolean,
      contentVersion: string
    ): Promise<IpcResult<CanvasDirtyOutcome>> {
      return invokeCanvas(IPC_COMMANDS.DIRTY_CHANGED, {
        projectId,
        mountSeq,
        dirty,
        contentVersion
      })
    },

    writeSnapshot(
      projectId: string,
      mountSeq: number,
      snapshot: string
    ): Promise<IpcResult<CanvasWriteOutcome>> {
      return invokeCanvas(IPC_COMMANDS.WRITE_SNAPSHOT, { projectId, mountSeq, snapshot })
    }
  }
}
