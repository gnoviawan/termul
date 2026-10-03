/**
 * Canvas API singleton (OpenPencil canvas mode).
 *
 * Resolves to the Tauri IPC impl when running inside a Tauri webview; the
 * fetch-backed HTTP impl when running as a web/remote client. Both impls
 * return the same `IpcResult<...>` shape byte-for-byte (the
 * `parity-checklist.test.ts` canvas block pins this).
 *
 * Phone-width gating (canvas is unavailable on the mobile web shell):
 * `open` and `save` check the live viewport predicate at CALL time (not
 * module load) and answer a typed `UNSUPPORTED_SURFACE` failure — the tested
 * unsupported state the entry points also rely on to hide themselves.
 */

import type {
  CanvasApi,
  CanvasOpenInfo,
  CanvasSaveResult,
  CanvasStatus
} from '@shared/types/canvas.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { isMobileWebShellViewport } from '@/hooks/use-mobile-web-shell'
import { createTauriCanvasApi } from './tauri-canvas-api'
import { isTauriContext } from './tauri-runtime'
import { webCanvasApi } from './web-canvas-api'

function unsupportedSurface(method: string): IpcResult<never> {
  return {
    success: false,
    error: `${method} is unavailable on the mobile web shell`,
    code: 'UNSUPPORTED_SURFACE'
  }
}

const tauriCanvasApi = createTauriCanvasApi()

/**
 * Singleton [`CanvasApi`]: Tauri IPC in the desktop webview, HTTP on the web
 * client, with the phone-width `UNSUPPORTED_SURFACE` gate on `open`/`save`.
 */
export const canvasApi: CanvasApi = {
  open(docPath: string, projectId: string): Promise<IpcResult<CanvasOpenInfo>> {
    if (isMobileWebShellViewport()) {
      return Promise.resolve(unsupportedSurface('canvas open'))
    }
    return isTauriContext()
      ? tauriCanvasApi.open(docPath, projectId)
      : webCanvasApi.open(docPath, projectId)
  },

  close(docPath: string): Promise<IpcResult<boolean>> {
    return isTauriContext() ? tauriCanvasApi.close(docPath) : webCanvasApi.close(docPath)
  },

  save(docPath: string): Promise<IpcResult<CanvasSaveResult>> {
    if (isMobileWebShellViewport()) {
      return Promise.resolve(unsupportedSurface('canvas save'))
    }
    return isTauriContext() ? tauriCanvasApi.save(docPath) : webCanvasApi.save(docPath)
  },

  status(): Promise<IpcResult<CanvasStatus>> {
    return isTauriContext() ? tauriCanvasApi.status() : webCanvasApi.status()
  }
}

export { createTauriCanvasApi } from './tauri-canvas-api'
export { CANVAS_COOKIE_NAME, webCanvasApi } from './web-canvas-api'
