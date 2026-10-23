/**
 * The host-local credential: termul-server writes a fresh one to
 * `<data dir>/host-local.token` (mode 0600) at every start, and a client that
 * presents it at `authenticate` may use the host's own Claude accounts and SSH
 * keys. Read at each handshake, so a restarted server's credential is used.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

export const HOST_LOCAL_TOKEN_FILE = 'host-local.token'

export function hostLocalTokenFile(dataDir: string): string {
  return path.join(dataDir, HOST_LOCAL_TOKEN_FILE)
}

/** The credential in `file`; `null` while the server has not written one. */
export function readHostLocalToken(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim() || null
  } catch {
    return null
  }
}
