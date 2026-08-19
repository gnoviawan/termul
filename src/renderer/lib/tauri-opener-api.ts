/**
 * Opener API Singleton
 *
 * Provides functions for opening files with external applications
 * and revealing items in the system file manager.
 *
 * Uses @tauri-apps/plugin-opener for cross-platform file operations on the
 * desktop. On web/remote, `openUrlWithSystemBrowser` branches to
 * `window.open(url, '_blank', 'noopener')` so the "View on GitHub" button in
 * `WhatsNewModal` works in a browser. The other two methods
 * (`openWithExternalApp`, `revealInFileManager`) have no browser equivalent
 * and return an explicit `WEB_UNSUPPORTED` result when called on web — they
 * never reach the stubbed plugin (which would throw `tauriUnavailable`).
 */

import type { IpcResult } from '@shared/types/ipc.types'
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { runtimeT } from '@/i18n/runtime'
import { isTauriContext } from './tauri-runtime'

export interface OpenerApi {
  openWithExternalApp: (path: string) => Promise<IpcResult<void>>
  openUrlWithSystemBrowser: (url: string) => Promise<IpcResult<void>>
  revealInFileManager: (path: string) => Promise<IpcResult<void>>
}

function createTauriOpenerApi(): OpenerApi {
  return {
    async openWithExternalApp(path: string): Promise<IpcResult<void>> {
      if (!isTauriContext()) {
        return {
          success: false,
          error: runtimeT(
            'projects',
            'webUnsupported.openExternalApp',
            'Opening with external apps is not available in the web client'
          ),
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
        // Web/remote: open a new tab. A popup blocker may return null; that is
        // not an error worth surfacing (best-effort facade). Swallow and report
        // success so the caller (e.g. WhatsNewModal) doesn't show a broken UX.
        //
        // Scheme guard: only hand `http(s):`/`mailto:` URLs to `window.open`.
        // `javascript:`/`data:`/`file:` would execute script or navigate the
        // current browsing context — a code-execution vector the desktop path
        // (OS handler) does not have. Non-conforming schemes no-op silently.
        if (!/^(https?:|mailto:)/i.test(url)) {
          return { success: true, data: undefined }
        }
        try {
          window.open(url, '_blank', 'noopener')
        } catch {
          // Swallow — SecurityError or popup blocker. Best-effort.
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
        return {
          success: false,
          error: runtimeT(
            'projects',
            'webUnsupported.revealInFileManager',
            'Revealing in file manager is not available in the web client'
          ),
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
