import { tauriUnavailable } from './unavailable'

export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

export type Update = {
  version: string
  date?: string
  body?: string
  download: (onEvent?: (event: DownloadEvent) => void) => Promise<void>
  install: () => Promise<void>
  close: () => Promise<void>
}

/** Web build: never reports an available native update. */
export async function check(_options?: unknown): Promise<Update | null> {
  return null
}

export async function downloadAndInstall(): Promise<never> {
  return tauriUnavailable('updater.downloadAndInstall')
}
