/**
 * A same-host HTTP and WebSocket proxy in front of a test termul-server that fills in the
 * FigCraft bundle the release binary lacks. Every request goes to the server first, so the
 * canvas token still gates the bundle: only a bundle request the server answers with
 * `503 BUNDLE_MISSING` (a valid token, no embedded bundle) is served from `bundleDir`, with the
 * server's own MIME table. Clients point at the proxy as if it were the server; the canvas iframe
 * URL is same-origin with it, as it is with a real server.
 *
 *   bun tools/canvas/bundle-proxy.ts --upstream http://127.0.0.1:8190 --port 8191 [--bundle DIR]
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { ServerWebSocket } from 'bun'
import { ensureFigcraftBundle } from './bundle'

/** First segments under `/canvas/` that are API routes (src-tauri/src/canvas/bundle_path.rs). */
const API_ROUTES = new Set([
  'open',
  'close',
  'read-document',
  'document-loaded',
  'dirty-changed',
  'set-visible',
  'write-snapshot',
  'disk-changed',
  'resolve-conflict',
  'crashed'
])

/** src-tauri/src/web/assets.rs `bundle_mime`. */
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  wasm: 'application/wasm',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf'
}

/** The file a `/canvas/<id>/<token>/<tail>` path names, or `null` for any other path. */
export function bundleTail(pathname: string): string | null {
  const parts = pathname.split('/')
  if (parts[1] !== 'canvas' || parts.length < 5 || API_ROUTES.has(parts[2] ?? '')) return null
  const tail = parts.slice(4).join('/')
  if (tail === '') return 'index.html'
  return tail.split('/').some((p) => p === '' || p === '.' || p === '..' || /[\\:]/.test(p))
    ? null
    : tail
}

function bundleFile(bundleDir: string, tail: string): Response {
  const file = path.join(bundleDir, tail)
  if (!existsSync(file)) return new Response('404 Not Found', { status: 404 })
  const ext = tail.slice(tail.lastIndexOf('.') + 1)
  return new Response(readFileSync(file), {
    headers: {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff'
    }
  })
}

interface Pipe {
  target: string
  headers: Record<string, string>
  upstream: WebSocket | null
  queue: (string | ArrayBuffer | Uint8Array)[]
}

export interface BundleProxy {
  baseUrl: string
  /** Bundle files served from disk so far. */
  served(): number
  stop(): void
}

export function startBundleProxy(opts: {
  upstream: string
  bundleDir: string
  port: number
}): BundleProxy {
  const upstreamOrigin = new URL(opts.upstream).origin
  let served = 0
  const forwardHeaders = (req: Request): Headers => {
    const headers = new Headers(req.headers)
    headers.delete('host')
    headers.set('accept-encoding', 'identity')
    if (headers.has('origin')) headers.set('origin', upstreamOrigin)
    headers.delete('referer')
    return headers
  }
  const server = Bun.serve<Pipe>({
    port: opts.port,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const target = new URL(url.pathname + url.search, upstreamOrigin)
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const headers: Record<string, string> = {}
        for (const [name, value] of forwardHeaders(req)) {
          if (!name.startsWith('sec-websocket') && !['upgrade', 'connection'].includes(name)) {
            headers[name] = value
          }
        }
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
        const data: Pipe = { target: target.href, headers, upstream: null, queue: [] }
        return srv.upgrade(req, { data })
          ? undefined
          : new Response('websocket upgrade failed', { status: 400 })
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const res = await fetch(target, {
        method: req.method,
        headers: forwardHeaders(req),
        body: hasBody ? await req.arrayBuffer() : undefined,
        redirect: 'manual'
      })
      const tail = bundleTail(url.pathname)
      if (tail !== null && res.status === 503) {
        const body = await res.text()
        if (body.includes('"BUNDLE_MISSING"')) {
          served += 1
          return bundleFile(opts.bundleDir, tail)
        }
        return new Response(body, { status: res.status, headers: res.headers })
      }
      return new Response(res.body, { status: res.status, headers: res.headers })
    },
    websocket: {
      open(client: ServerWebSocket<Pipe>) {
        const pipe = client.data
        const ws = new WebSocket(pipe.target, { headers: pipe.headers } as never)
        ws.binaryType = 'arraybuffer'
        pipe.upstream = ws
        ws.onopen = () => {
          for (const message of pipe.queue.splice(0)) ws.send(message)
        }
        ws.onmessage = (event) => client.send(event.data as string | ArrayBuffer)
        ws.onclose = (event) => client.close(event.code === 1005 ? 1000 : event.code, event.reason)
        ws.onerror = () => client.close(1011, 'upstream error')
      },
      message(client, message) {
        const { upstream, queue } = client.data
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message)
        else queue.push(message)
      },
      close(client) {
        client.data.upstream?.close()
      }
    }
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    served: () => served,
    stop: () => server.stop(true)
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      upstream: { type: 'string' },
      port: { type: 'string' },
      bundle: { type: 'string', default: '/tmp/gpuix-v1/figcraft-bundle' }
    }
  })
  if (!values.upstream || !values.port) {
    throw new Error('usage: bundle-proxy.ts --upstream <origin> --port <port> [--bundle DIR]')
  }
  const bundleDir = await ensureFigcraftBundle(values.bundle!)
  const proxy = startBundleProxy({
    upstream: values.upstream,
    bundleDir,
    port: Number(values.port)
  })
  console.log(`bundle proxy ${proxy.baseUrl} -> ${values.upstream} (bundle ${bundleDir})`)
}
