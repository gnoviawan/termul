/**
 * Client configuration, parsed once from the process environment. Everything
 * after this boundary trusts the parsed shape.
 */

import os from 'node:os'
import path from 'node:path'
import type { ClientConfig } from '../client-config'
import { hostLocalTokenFile } from '../launcher/host-local'

export type { ClientConfig }

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8190'

export class ClientConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientConfigError'
  }
}

function parseServerUrl(raw: string | undefined): URL {
  const text = raw?.trim() || DEFAULT_SERVER_URL
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ClientConfigError(`TERMUL_SERVER_URL is not a URL: ${JSON.stringify(text)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ClientConfigError(`TERMUL_SERVER_URL must be http(s): ${text}`)
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new ClientConfigError(
      `TERMUL_SERVER_URL must be an origin without path, query or fragment: ${text}`
    )
  }
  return new URL(url.origin)
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'termul-gpuix')
}

/**
 * `TERMUL_GPUIX_DATA_DIR` names the server's `--state-dir`. When set, an
 * attached client on the same host presents the server's host-local
 * credential from it, as a launched one does.
 */
export function readClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const token = env.TERMUL_SERVER_TOKEN?.trim() || null
  const serverDataDir = env.TERMUL_GPUIX_DATA_DIR?.trim()
  return {
    serverUrl: parseServerUrl(env.TERMUL_SERVER_URL),
    token,
    stateDir: env.TERMUL_GPUIX_STATE_DIR?.trim() || defaultStateDir(env),
    hostLocalTokenFile: serverDataDir ? hostLocalTokenFile(serverDataDir) : null
  }
}
