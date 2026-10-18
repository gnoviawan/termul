/**
 * Fetch-based HTTP impl of the canvas facade over the routes in
 * `src-tauri/src/web/canvas_api.rs` and `canvas_persistence_api.rs`
 * (same-origin, behind the bearer `web_auth_gate`; `postJson` adds the web
 * auth header):
 * - `POST /canvas/open` body `{ docPath, projectId, autosaveMs }` →
 *   `CanvasOpenInfo` with an empty `baseUrl` (the bundle is same-origin);
 * - `POST /canvas/close` body `{ projectId, discard }` — the host's AD-31
 *   unmount (save, verify, unmount), which also revokes the `ct` token;
 * - `POST /canvas/read-document|document-loaded|dirty-changed|write-snapshot`
 *   — the persistence calls, keyed by `{ projectId, mountSeq }`.
 *
 * The bundle routes set their own HttpOnly per-canvas cookie on the first
 * `ct` request, so this adapter never touches `document.cookie`. Transport
 * failures map to `NETWORK_ERROR`; server failures keep their typed code.
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

import { postJson } from './ipc/http'

export const webCanvasApi: CanvasApi = {
  open(
    docPath: string,
    projectId: string,
    autosaveMs?: number
  ): Promise<IpcResult<CanvasOpenInfo>> {
    return postJson<CanvasOpenInfo>('/canvas/open', { docPath, projectId, autosaveMs })
  },

  close(projectId: string, discard = false): Promise<IpcResult<CanvasCloseOutcome>> {
    return postJson<CanvasCloseOutcome>('/canvas/close', { projectId, discard })
  },

  readDocument(projectId: string, mountSeq: number): Promise<IpcResult<CanvasDocumentBytes>> {
    return postJson<CanvasDocumentBytes>('/canvas/read-document', { projectId, mountSeq })
  },

  documentLoaded(
    projectId: string,
    mountSeq: number,
    ack: string | null
  ): Promise<IpcResult<CanvasPersistenceView>> {
    return postJson<CanvasPersistenceView>('/canvas/document-loaded', {
      projectId,
      mountSeq,
      ack
    })
  },

  dirtyChanged(
    projectId: string,
    mountSeq: number,
    dirty: boolean,
    contentVersion: string
  ): Promise<IpcResult<CanvasDirtyOutcome>> {
    return postJson<CanvasDirtyOutcome>('/canvas/dirty-changed', {
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
    return postJson<CanvasWriteOutcome>('/canvas/write-snapshot', {
      projectId,
      mountSeq,
      snapshot
    })
  }
}
