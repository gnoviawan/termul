/**
 * `TERMUL_SERVER_BIN=<fresh termul-server> bun tools/launcher/host-local-e2e.ts [--root DIR]`
 *
 * Runs the real launcher (`launch()`), which spawns the given termul-server
 * on `dataDirArgs(<data dir>)`, then authenticates over `/ws` with the
 * fields `buildAuthenticatePayload` sends, the credential read through
 * `readHostLocalToken(config.hostLocalTokenFile)` as `main.tsx` wires it.
 * (Importing the renderer builder pulls the store graph into the tools
 * tsconfig, whose Bun `import.meta.env` types reject it.)
 * Proves the path the launcher reads is the path the server writes, and that
 * the grant holds only with the credential, without a proxy header, and for
 * an attached client only when it names the data dir. Also checks that the
 * server's file routes refuse the credential file.
 *
 * Ports 8190-8199 only; state under --root (default /tmp/gpuix-r3/e2e),
 * removed on exit after the launcher stops the server.
 */

import { rmSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import type { ClientConfig } from '../../src/client-config'
import { readClientConfig } from '../../src/env/config'
import { launch } from '../../src/launcher'
import { readHostLocalToken } from '../../src/launcher/host-local'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { root: { type: 'string', default: '/tmp/gpuix-r3/e2e' } }
})
const ROOT = values.root as string
const SERVER_BIN = process.env.TERMUL_SERVER_BIN

let failed = false
function check(name: string, ok: boolean, detail: unknown): void {
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`)
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function testPort(): Promise<number> {
  for (let port = 8190; port <= 8199; port++) if (await portFree(port)) return port
  throw new Error('no free port in 8190-8199')
}

interface AuthReply {
  ok?: boolean
  payload?: { capabilities?: { write?: boolean; hostLocal?: boolean } }
  err?: unknown
}

/** One `/ws` handshake carrying the renderer's authenticate fields. */
async function authenticate(
  config: ClientConfig,
  headers: Record<string, string> = {}
): Promise<AuthReply> {
  const file = config.hostLocalTokenFile
  const hostLocalToken = file ? readHostLocalToken(file) : null
  const url = `${config.serverUrl.origin.replace(/^http/, 'ws')}/ws`
  const ws = new WebSocket(url, { headers } as unknown as string[])
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error(`cannot open ${url}`))
    })
    return await new Promise<AuthReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no authenticate reply')), 10_000)
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data))
        if (frame.id !== 'auth-1') return
        clearTimeout(timer)
        resolve(frame)
      }
      ws.send(
        JSON.stringify({
          id: 'auth-1',
          type: 'authenticate',
          payload: {
            protocolVersion: WS_PROTOCOL_VERSION,
            deviceId: 'host-local-e2e',
            clientInstanceId: crypto.randomUUID(),
            ...(config.token ? { token: config.token } : {}),
            ...(hostLocalToken ? { hostLocalToken } : {})
          }
        })
      )
    })
  } finally {
    ws.close()
  }
}

async function getJson(config: ClientConfig, route: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(route, config.serverUrl), {
    headers: { authorization: `Bearer ${config.token}` }
  })
  return (await response.json()) as Record<string, unknown>
}

if (!SERVER_BIN) throw new Error('set TERMUL_SERVER_BIN to a freshly built termul-server')
rmSync(ROOT, { recursive: true, force: true })
const dataDir = path.join(ROOT, 'data')
const port = await testPort()
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TERMUL_SERVER_BIN: SERVER_BIN,
  TERMUL_GPUIX_DATA_DIR: dataDir,
  TERMUL_GPUIX_STATE_DIR: path.join(ROOT, 'client'),
  TERMUL_GPUIX_SERVER_PORT: String(port)
}

const launched = await launch(env)
if (launched.kind !== 'primary') throw new Error('another launcher owns this state dir')
const { config } = launched
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }))
const credential = path.join(dataDir, 'host-local.token')
check('launcher reads the file the server writes', config.hostLocalTokenFile === credential, {
  launcher: config.hostLocalTokenFile,
  server: credential
})
const mode = statSync(credential).mode & 0o777
check('the credential is owner-only', mode === 0o600, mode.toString(8))

const granted = await authenticate(config)
check(
  'the launched client is hostLocal',
  granted.ok === true && granted.payload?.capabilities?.hostLocal === true,
  granted.payload?.capabilities ?? granted.err
)

const bare = await authenticate({ ...config, hostLocalTokenFile: null })
check(
  'without the credential it is not',
  bare.ok === true && bare.payload?.capabilities?.hostLocal === false,
  bare.payload?.capabilities ?? bare.err
)

const proxied = await authenticate(config, { Via: '1.1 proxy' })
check(
  'a Via header withholds hostLocal',
  proxied.ok === true && proxied.payload?.capabilities?.hostLocal === false,
  proxied.payload?.capabilities ?? proxied.err
)

const attachEnv = {
  HOME: process.env.HOME,
  TERMUL_SERVER_URL: config.serverUrl.origin,
  TERMUL_SERVER_TOKEN: config.token ?? ''
}
const attached = await authenticate(
  readClientConfig({ ...attachEnv, TERMUL_GPUIX_DATA_DIR: dataDir })
)
check(
  'an attached client naming the data dir is hostLocal',
  attached.payload?.capabilities?.hostLocal === true,
  attached.payload?.capabilities ?? attached.err
)
const attachedBare = await authenticate(readClientConfig(attachEnv))
check(
  'an attached client without it is not',
  attachedBare.payload?.capabilities?.hostLocal === false,
  attachedBare.payload?.capabilities ?? attachedBare.err
)

const read = await getJson(config, `/fs/read?path=${encodeURIComponent(credential)}`)
check('/fs/read refuses the credential', read.code === 'FORBIDDEN' && !read.data, read.code)
const listing = await getJson(config, `/fs/ls?path=${encodeURIComponent(dataDir)}`)
const names = ((listing.data as { name: string }[] | undefined) ?? []).map((entry) => entry.name)
check(
  '/fs/ls hides the credential',
  listing.success === true && !names.includes('host-local.token'),
  names
)

console.log(failed ? 'host-local e2e FAILED' : 'host-local e2e passed')
process.exit(failed ? 1 : 0)
