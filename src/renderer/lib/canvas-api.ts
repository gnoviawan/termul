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
  open(docPath, projectId, options) {
    if (isMobileWebShellViewport()) {
      return Promise.resolve({
        success: false,
        error: 'canvas open is unavailable on the mobile web shell',
        code: 'UNSUPPORTED_SURFACE'
      })
    }
    return transport().open(docPath, projectId, options)
  },
  close: (projectId, mountSeq, discard) => transport().close(projectId, mountSeq, discard),
  setVisible: (projectId, mountSeq, visible) =>
    transport().setVisible(projectId, mountSeq, visible),
  readDocument: (projectId, mountSeq) => transport().readDocument(projectId, mountSeq),
  documentLoaded: (projectId, mountSeq, ack) =>
    transport().documentLoaded(projectId, mountSeq, ack),
  dirtyChanged: (projectId, mountSeq, dirty, contentVersion) =>
    transport().dirtyChanged(projectId, mountSeq, dirty, contentVersion),
  writeSnapshot: (projectId, mountSeq, snapshot) =>
    transport().writeSnapshot(projectId, mountSeq, snapshot),
  diskChanged: (projectId, mountSeq, reloadFailed) =>
    transport().diskChanged(projectId, mountSeq, reloadFailed),
  resolveConflict: (projectId, mountSeq, choice, snapshot) =>
    transport().resolveConflict(projectId, mountSeq, choice, snapshot),
  crashed: (projectId, mountSeq, reason) => transport().crashed(projectId, mountSeq, reason)
}

export { createTauriCanvasApi } from './tauri-canvas-api'
export { webCanvasApi } from './web-canvas-api'
