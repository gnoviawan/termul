import { getBrowserHost } from './browser-host'
import { isTauriContext } from './tauri-runtime'

/**
 * Whether this surface can show browser panes: the Tauri desktop app, or a
 * desktop shell that registered a browser host (`browser-host.ts`). The
 * browser and phone client cannot, so their entry points stay hidden.
 */
export function nativeBrowserPanesAvailable(): boolean {
  return isTauriContext() || getBrowserHost() !== null
}
