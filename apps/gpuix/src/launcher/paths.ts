/**
 * Where the launcher finds termul-server and where that server keeps its data.
 * Pure: every input (env, platform, home, file checks) is passed in.
 *
 * The data dir is the Tauri desktop app's `app_data_dir`
 * (`identifier` `com.termul-manager.app` in `src-tauri/tauri.conf.json`), and
 * the server is pointed at the same files the desktop host opens there
 * (`src-tauri/src/lib.rs`, `data_lock::lock_desktop_data`), so a user who
 * switches from the Tauri app keeps their projects and sessions.
 */

import path from 'node:path'

export const DESKTOP_IDENTIFIER = 'com.termul-manager.app'

export interface HostFacts {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  homedir: string
  isFile(candidate: string): boolean
}

function join(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? path.win32.join(...parts) : path.posix.join(...parts)
}

/** Tauri's `app_data_dir()` for the desktop app, or `TERMUL_GPUIX_DATA_DIR`. */
export function serverDataDir(host: HostFacts): string {
  const override = host.env.TERMUL_GPUIX_DATA_DIR?.trim()
  if (override) return override
  const { platform, homedir, env } = host
  if (platform === 'darwin') {
    return join(platform, homedir, 'Library', 'Application Support', DESKTOP_IDENTIFIER)
  }
  if (platform === 'win32') {
    const roaming = env.APPDATA?.trim() || join(platform, homedir, 'AppData', 'Roaming')
    return join(platform, roaming, DESKTOP_IDENTIFIER)
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(platform, homedir, '.local', 'share')
  return join(platform, dataHome, DESKTOP_IDENTIFIER)
}

/**
 * The flags that make termul-server open the desktop host's stores. The ACP
 * catalog and install roots follow `--state-dir` (`<dir>/acp-catalog`,
 * `<dir>/acp-registry-binaries`), which is where the desktop keeps them too.
 */
export function dataDirArgs(platform: NodeJS.Platform, dataDir: string): string[] {
  return [
    '--state-dir',
    dataDir,
    '--sessions-dir',
    join(platform, dataDir, 'acp-sessions'),
    '--projects-file',
    join(platform, dataDir, 'projects.json'),
    '--store-file',
    join(platform, dataDir, 'store.json')
  ]
}

/** The launcher's own files: the server record, its token, the watchdog. */
export function launcherDir(clientStateDir: string): string {
  return path.join(clientStateDir, 'launcher')
}

export type BinaryLookup = { found: true; path: string } | { found: false; searched: string[] }

/**
 * `TERMUL_SERVER_BIN`, then a binary bundled next to the app (beside a
 * compiled executable, or beside the bundle in `dist/`), then `PATH`.
 */
export function resolveServerBinary(host: HostFacts, bundledDirs: readonly string[]): BinaryLookup {
  const name = host.platform === 'win32' ? 'termul-server.exe' : 'termul-server'
  const fromEnv = host.env.TERMUL_SERVER_BIN?.trim()
  if (fromEnv) {
    return host.isFile(fromEnv)
      ? { found: true, path: fromEnv }
      : { found: false, searched: [fromEnv] }
  }
  const separator = host.platform === 'win32' ? ';' : ':'
  const pathDirs = (host.env.PATH ?? host.env.Path ?? '').split(separator).filter(Boolean)
  const searched = [...bundledDirs, ...pathDirs].map((dir) => join(host.platform, dir, name))
  const hit = searched.find((candidate) => host.isFile(candidate))
  return hit ? { found: true, path: hit } : { found: false, searched }
}
