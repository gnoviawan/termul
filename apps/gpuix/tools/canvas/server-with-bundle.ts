#!/usr/bin/env bun
/**
 * A drop-in `TERMUL_SERVER_BIN` for tools that start their own test server (the parity matrix):
 * it runs the real termul-server on another port in 8190-8199 and `bundle-proxy.ts` on the port
 * it was asked for, so the canvas surfaces get the pinned FigCraft bundle with no change to the
 * tool. Every argument passes through except `--port`.
 *
 *   TERMUL_SERVER_BIN=tools/canvas/server-with-bundle.ts bun tools/matrix/run.ts --area canvas
 *
 * `TERMUL_REAL_SERVER_BIN` names the real binary (default: the parity tools' own choice);
 * `FIGCRAFT_BUNDLE_DIR` where the bundle is kept (default /tmp/gpuix-v1/figcraft-bundle).
 */

import { defaultServerBinary } from '../parity/server'
import { ensureFigcraftBundle } from './bundle'
import { startBundleProxy } from './bundle-proxy'

const args = Bun.argv.slice(2)
const at = args.indexOf('--port')
if (at < 0 || !args[at + 1]) throw new Error('server-with-bundle: --port is required')
const port = Number(args[at + 1])
const inner = freePortExcept(port)
args[at + 1] = String(inner)

const bundleDir = await ensureFigcraftBundle(
  process.env.FIGCRAFT_BUNDLE_DIR ?? '/tmp/gpuix-v1/figcraft-bundle'
)
const real = process.env.TERMUL_REAL_SERVER_BIN ?? withoutSelf(defaultServerBinary)
const child = Bun.spawn([real, ...args], { stdout: 'inherit', stderr: 'inherit', env: process.env })
const proxy = startBundleProxy({ upstream: `http://127.0.0.1:${inner}`, bundleDir, port })
console.error(`[server-with-bundle] ${proxy.baseUrl} -> 127.0.0.1:${inner} (${real})`)

const stop = () => {
  proxy.stop()
  child.kill('SIGTERM')
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.exit(await child.exited)

/** The parity tools' binary choice, ignoring the `TERMUL_SERVER_BIN` that points here. */
function withoutSelf(choose: () => string): string {
  const saved = process.env.TERMUL_SERVER_BIN
  delete process.env.TERMUL_SERVER_BIN
  try {
    return choose()
  } finally {
    if (saved !== undefined) process.env.TERMUL_SERVER_BIN = saved
  }
}

/** A port in 8190-8199 nothing listens on, other than the one the proxy is about to take. */
function freePortExcept(taken: number): number {
  const listening = Bun.spawnSync(['ss', '-ltnH']).stdout.toString()
  for (let p = 8190; p <= 8199; p++) if (p !== taken && !listening.includes(`:${p} `)) return p
  throw new Error('server-with-bundle: no free port in 8190-8199')
}
