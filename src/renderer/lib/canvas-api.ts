/**
 * Canvas API singleton: the Tauri IPC impl inside a Tauri webview, the
 * fetch-backed HTTP impl on the web client. Both return the same
 * `IpcResult<...>` shapes (the parity checklist pins this), so nothing above
 * this file branches on surface.
 *
 * Phone-width gating: `open` checks the live viewport predicate at call time
 * and answers a typed `UNSUPPORTED_SURFACE` failure (no canvas on the mobile
 * web shell).
 */

import type { CanvasApi } from '@shared/types/canvas.types'

import { isMobileWebShellViewport } from '@/hooks/use-mobile-web-shell'
import { createTauriCanvasApi } from './tauri-canvas-api'
import { isTauriContext } from './tauri-runtime'
import { webCanvasApi } from './web-canvas-api'

const tauriCanvasApi = createTauriCanvasApi()

function transport(): CanvasApi {
  return isTauriContext() ? tauriCanvasApi : webCanvasApi
}

export const canvasApi: CanvasApi = {
  open(docPath, projectId, autosaveMs) {
    if (isMobileWebShellViewport()) {
      return Promise.resolve({
        success: false,
        error: 'canvas open is unavailable on the mobile web shell',
        code: 'UNSUPPORTED_SURFACE'
      })
    }
    return transport().open(docPath, projectId, autosaveMs)
  },
  close: (projectId, discard) => transport().close(projectId, discard),
  readDocument: (projectId, mountSeq) => transport().readDocument(projectId, mountSeq),
  documentLoaded: (projectId, mountSeq, ack) =>
    transport().documentLoaded(projectId, mountSeq, ack),
  dirtyChanged: (projectId, mountSeq, dirty, contentVersion) =>
    transport().dirtyChanged(projectId, mountSeq, dirty, contentVersion),
  writeSnapshot: (projectId, mountSeq, snapshot) =>
    transport().writeSnapshot(projectId, mountSeq, snapshot)
}

export { createTauriCanvasApi } from './tauri-canvas-api'
export { webCanvasApi } from './web-canvas-api'
