/**
 * Opener API Singleton
 *
 * Provides functions for opening files with external applications
 * and revealing items in the system file manager.
 *
 * Uses @tauri-apps/plugin-opener for cross-platform file operations on the
 * desktop. On web/remote, `openUrlWithSystemBrowser` branches to
 * `window.open(url, '_blank')` so the "View on GitHub" button in
 * `WhatsNewModal` works in a browser. The other two methods
 * (`openWithExternalApp`, `revealInFileManager`) have no browser equivalent
 * and return an explicit `WEB_UNSUPPORTED` result when called on web — they
 * never reach the stubbed plugin (which would throw `tauriUnavailable`).
 *
 * A non-Tauri desktop shell that registered a `DesktopHost` (the GPUIX
 * client) gets the OS behavior on all three instead.
 */

import type { IpcResult } from '@shared/types/ipc.types'
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'

import { type DesktopHost, getDesktopHost } from './desktop-host'
import { isTauriContext } from './tauri-runtime'

export interface OpenerApi {
  openWithExternalApp: (path: string) => Promise<IpcResult<void>>
  openUrlWithSystemBrowser: (url: string) => Promise<IpcResult<void>>
  revealInFileManager: (path: string) => Promise<IpcResult<void>>
}

async function viaHost(
  run: (host: DesktopHost) => Promise<void>,
  host: DesktopHost,
  code: string
): Promise<IpcResult<void>> {
  try {
    await run(host)
    return { success: true, data: undefined }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), code }
  }
}

function createTauriOpenerApi(): OpenerApi {
  return {
    async openWithExternalApp(path: string): Promise<IpcResult<void>> {
      if (!isTauriContext()) {
        const host = getDesktopHost()
        if (host) return viaHost((h) => h.openPath(path), host, 'OPEN_ERROR')
        return {
          success: false,
          error: 'Opening with external apps is not available in the web client',
          code: 'WEB_UNSUPPORTED'
        }
      }
      try {
        await openPath(path)
        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'OPEN_ERROR'
        }
      }
    },

    async openUrlWithSystemBrowser(url: string): Promise<IpcResult<void>> {
      if (!isTauriContext()) {
        // Web/remote: open a new tab. A popup blocker (or a SecurityError)
        // makes `window.open` fail — report that honestly so callers like the
        // bug-report fallback don't toast "issue opened" for a tab that never
        // appeared. Callers that don't check the result (e.g. WhatsNewModal)
        // keep their fire-and-forget UX.
        //
        // Scheme guard: only hand `http(s):`/`mailto:` URLs to `window.open`.
        // `javascript:`/`data:`/`file:` would execute script or navigate the
        // current browsing context — a code-execution vector the desktop path
        // (OS handler) does not have. Non-conforming schemes no-op silently.
        if (!/^(https?:|mailto:)/i.test(url)) {
          return { success: true, data: undefined }
        }
        const host = getDesktopHost()
        if (host) return viaHost((h) => h.openUrl(url), host, 'OPEN_URL_ERROR')
        try {
          // No 'noopener' feature: it makes window.open return null even on
          // success, so the popup-blocked check below could never be honest.
          // Modern browsers imply noopener for _blank anyway, and the opener
          // reference is cleared explicitly for older ones.
          const opened = window.open(url, '_blank')
          if (opened === null) {
            return {
              success: false,
              error: 'The browser blocked the new tab (popup blocked)',
              code: 'OPEN_URL_ERROR'
            }
          }
          opened.opener = null
        } catch (error) {
          // SecurityError or a popup-blocker throw — same class of failure as
          // the desktop `openUrl` rejection.
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            code: 'OPEN_URL_ERROR'
          }
        }
        return { success: true, data: undefined }
      }

      try {
        await openUrl(url)
        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'OPEN_URL_ERROR'
        }
      }
    },

    async revealInFileManager(path: string): Promise<IpcResult<void>> {
      if (!isTauriContext()) {
        const host = getDesktopHost()
        if (host) return viaHost((h) => h.revealItemInDir(path), host, 'REVEAL_ERROR')
        return {
          success: false,
          error: 'Revealing in file manager is not available in the web client',
          code: 'WEB_UNSUPPORTED'
        }
      }
      try {
        await revealItemInDir(path)
        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'REVEAL_ERROR'
        }
      }
    }
  }
}

export const openerApi: OpenerApi = createTauriOpenerApi()
