/**
 * Desktop host seam: a non-Tauri desktop shell (the GPUIX client) registers
 * the OS capabilities a browser lacks, and the facades use them on their
 * non-Tauri branch. With no host registered (the browser and phone client)
 * every facade keeps its web behavior; Tauri never reaches this module.
 *
 * A host provides the whole set or nothing, so a facade never has to handle
 * a half-capable host.
 */

export interface DesktopHost {
  /** Open an http(s)/mailto URL in the default browser or mail client. */
  openUrl(url: string): Promise<void>
  /** Open a file or folder with its default application. */
  openPath(path: string): Promise<void>
  /** Show the item selected in the system file manager. */
  revealItemInDir(path: string): Promise<void>
  /** Post an OS notification. */
  notify(title: string, body: string): Promise<void>
}

let host: DesktopHost | null = null

export function registerDesktopHost(next: DesktopHost): void {
  host = next
}

export function getDesktopHost(): DesktopHost | null {
  return host
}

/** @internal Testing only. */
export function _resetDesktopHostForTesting(): void {
  host = null
}
