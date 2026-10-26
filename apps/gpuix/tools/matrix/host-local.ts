/**
 * The `web-host-local` reference: the web client shown the capabilities the
 * launched GPUIX app has. termul-server writes a host-local credential to
 * `<state dir>/host-local.token` at start; a client that presents it at
 * `authenticate` gets `hostLocal` and with it the SSH section and Claude
 * account management. A browser tab never presents it, so the matrix adds it
 * to the web client's handshake frames through a Playwright WebSocket route.
 * The web bundle is unchanged; the route exists only in this harness.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext } from 'playwright'
import { HOST_LOCAL_TOKEN_FILE } from '../../src/launcher/host-local'
import type { World } from './world'

export function hostLocalTokenPath(world: World): string {
  return path.join(world.server.stateDir, HOST_LOCAL_TOKEN_FILE)
}

function hostLocalToken(world: World): string {
  const file = hostLocalTokenPath(world)
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing: this termul-server predates the host-local credential. ` +
        'Run with TERMUL_SERVER_BIN=/root/termul-wt/gpuix/src-tauri/target/release/termul-server.'
    )
  }
  return readFileSync(file, 'utf8').trim()
}

/** `frame` with the credential added when it is an `authenticate` request. */
export function withHostLocalCredential(frame: string, token: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(frame)
  } catch {
    return frame
  }
  const request = parsed as { type?: unknown; payload?: Record<string, unknown> }
  if (request.type !== 'authenticate' || typeof request.payload !== 'object') return frame
  return JSON.stringify({ ...request, payload: { ...request.payload, hostLocalToken: token } })
}

export async function grantHostLocal(context: BrowserContext, world: World): Promise<void> {
  const token = hostLocalToken(world)
  const host = new URL(world.server.baseUrl).host
  await context.routeWebSocket(
    (url) => url.host === host,
    (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) =>
        server.send(typeof message === 'string' ? withHostLocalCredential(message, token) : message)
      )
    }
  )
}
