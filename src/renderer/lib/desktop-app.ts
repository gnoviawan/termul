import { getDesktopHost } from './desktop-host'
import { isTauriContext } from './tauri-runtime'

/** A desktop app (Tauri, or a shell that registered a desktop host) rather than the browser client. */
export function isDesktopApp(): boolean {
  return isTauriContext() || getDesktopHost() !== null
}
