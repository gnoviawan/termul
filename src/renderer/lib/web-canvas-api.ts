/**
 * Fetch-based HTTP impl of the canvas facade over the routes in
 * `src-tauri/src/web/canvas_api.rs` and `canvas_persistence_api.rs`
 * (same-origin, behind the bearer `web_auth_gate`; `postJson` adds the web
 * auth header):
 * - `POST /canvas/open` body `{ docPath, projectId, clientInstanceId,
 *   ...CanvasOpenOptions }` → `CanvasOpenInfo` with an empty `baseUrl` (the
 *   bundle is same-origin); this tab takes the mount lease, after the least
 *   recently active canvases beyond `maxMounted` unloaded;
 * - `POST /canvas/close` body `{ projectId, mountSeq, discard }` — the
 *   host's AD-31 unmount (save, verify, unmount) of that mount only, which
 *   also revokes the canvas token once the project has no mount;
 * - `POST /canvas/set-visible` body `{ projectId, mountSeq, visible }` — the
 *   user-visibility half of the mount cap's activity ranking;
 * - `POST /canvas/read-document|document-loaded|dirty-changed|write-snapshot`
 *   — the persistence calls, keyed by `{ projectId, mountSeq }`.
 *
 * The bundle routes take the canvas token from their own path, so this
 * adapter never touches cookies. Transport
 * failures map to `NETWORK_ERROR`; server failures keep their typed code.
 */

import type {
  CanvasApi,
  CanvasCloseOutcome,
  CanvasConflictChoice,
  CanvasDirtyOutcome,
  CanvasDiskOutcome,
  CanvasDocumentBytes,
  CanvasOpenInfo,
  CanvasOpenOptions,
  CanvasPersistenceView,
  CanvasRemount,
  CanvasResolveOutcome,
  CanvasWriteOutcome
} from '@shared/types/canvas.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { postJson } from './ipc/http'
import { getClientInstanceId } from './web-client-identity'

export const webCanvasApi: CanvasApi = {
  open(
    docPath: string,
    projectId: string,
    options: CanvasOpenOptions = {}
  ): Promise<IpcResult<CanvasOpenInfo>> {
    return postJson<CanvasOpenInfo>('/canvas/open', {
      docPath,
      projectId,
      clientInstanceId: getClientInstanceId(),
      ...options
    })
  },

  setVisible(projectId: string, mountSeq: number, visible: boolean): Promise<IpcResult<void>> {
    return postJson<void>('/canvas/set-visible', { projectId, mountSeq, visible })
  },

  close(
    projectId: string,
    mountSeq: number,
    discard = false
  ): Promise<IpcResult<CanvasCloseOutcome>> {
    return postJson<CanvasCloseOutcome>('/canvas/close', { projectId, mountSeq, discard })
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
  },

  diskChanged(
    projectId: string,
    mountSeq: number,
    reloadFailed?: boolean
  ): Promise<IpcResult<CanvasDiskOutcome>> {
    return postJson<CanvasDiskOutcome>('/canvas/disk-changed', {
      projectId,
      mountSeq,
      ...(reloadFailed ? { reloadFailed: true } : {})
    })
  },

  resolveConflict(
    projectId: string,
    mountSeq: number,
    choice: CanvasConflictChoice,
    snapshot?: string
  ): Promise<IpcResult<CanvasResolveOutcome>> {
    return postJson<CanvasResolveOutcome>('/canvas/resolve-conflict', {
      projectId,
      mountSeq,
      choice,
      snapshot
    })
  },

  crashed(projectId: string, mountSeq: number, reason: string): Promise<IpcResult<CanvasRemount>> {
    return postJson<CanvasRemount>('/canvas/crashed', { projectId, mountSeq, reason })
  }
}
