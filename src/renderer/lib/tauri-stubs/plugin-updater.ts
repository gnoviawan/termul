import { tauriUnavailable } from './unavailable'

export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

export interface UpdateMetadata {
  rid: number
  currentVersion: string
  version: string
  date?: string
  body?: string
  rawJson: Record<string, unknown>
}

/**
 * Web build: mirrors the plugin's `Update` class shape so the facade's signed
 * channel path type-checks and bundles. Never constructed in a browser because
 * the channel check goes through Tauri IPC, which the web build lacks.
 */
export class Update {
  rid: number
  currentVersion: string
  version: string
  date?: string
  body?: string
  rawJson: Record<string, unknown>

  constructor(metadata: UpdateMetadata) {
    this.rid = metadata.rid
    this.currentVersion = metadata.currentVersion
    this.version = metadata.version
    this.date = metadata.date
    this.body = metadata.body
    this.rawJson = metadata.rawJson
  }

  async download(_onEvent?: (event: DownloadEvent) => void): Promise<void> {
    return tauriUnavailable('updater.download')
  }

  async install(): Promise<void> {
    return tauriUnavailable('updater.install')
  }

  async close(): Promise<void> {}
}

/** Web build: never reports an available native update. */
export async function check(_options?: unknown): Promise<Update | null> {
  return null
}

export async function downloadAndInstall(): Promise<never> {
  return tauriUnavailable('updater.downloadAndInstall')
}
