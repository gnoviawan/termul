#!/usr/bin/env node
/**
 * TCP fault proxy for the reconnect lab: forwards 127.0.0.1:<listen> to
 * 127.0.0.1:<target> and injects link faults on command.
 *
 * In-process: `const proxy = await startFaultProxy({ targetPort })`, then
 * `proxy.rst()`, `proxy.blackhole(ms, { end: 'resume' | 'destroy' })`,
 * `proxy.stallDownstream(ms)`, `proxy.down(ms)`, `proxy.pass()`, `proxy.stats()`.
 *
 * Standalone: `node fault-proxy.mjs --target 8300 [--listen 8301] [--control 8302] [--delay <one-way ms>]`,
 * then `curl -X POST 127.0.0.1:8302/rst`, `/blackhole?ms=40000&end=destroy`,
 * `/stall-downstream?ms=30000`, `/down?ms=60000`, `/pass`; `GET /stats`.
 *
 * Fault semantics:
 * - rst: every open pair is reset (TCP RST to the browser and to the server).
 * - blackhole: no byte moves in either direction and nothing closes; bytes are
 *   held (TCP would retransmit them) and flushed on resume, or every pair is
 *   reset on `end: 'destroy'`. Connections opened meanwhile are held too (a
 *   SYN into a dead radio link never completes an exchange).
 * - stall-downstream: browser->server flows, server->browser is held.
 * - down: every open pair is reset and new connections are reset on accept.
 * - pass: clears every fault now (held bytes are flushed).
 */
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {{ kind: 'pass' } | { kind: 'blackhole' } | { kind: 'stall-downstream' } | { kind: 'down' }} Fault */

export async function startFaultProxy({
  targetPort,
  targetHost = '127.0.0.1',
  listenPort = 0,
  delayMs = 0,
  onEvent = () => {}
}) {
  /** @type {Fault} */
  let fault = { kind: 'pass' }
  let faultTimer = null
  let nextId = 1
  /** @type {Set<Pair>} */
  const pairs = new Set()
  const totals = { accepted: 0, refused: 0, reset: 0, bytesUp: 0, bytesDown: 0, wsUpgrades: {} }

  // One-way delay per direction (same delay for every chunk keeps the order).
  const later = (write) => (delayMs > 0 ? setTimeout(write, delayMs) : write())
  const emit = (type, detail = {}) => onEvent({ t: Date.now(), src: 'proxy', type, ...detail })

  class Pair {
    constructor(client) {
      this.id = nextId++
      this.client = client
      this.openedAt = Date.now()
      this.firstLine = null
      this.heldUp = []
      this.heldDown = []
      this.closed = false
      this.upstream = createConnection({ host: targetHost, port: targetPort })
      this.upstream.setNoDelay(true)
      client.setNoDelay(true)
      client.on('data', (chunk) => this.fromClient(chunk))
      this.upstream.on('data', (chunk) => this.fromServer(chunk))
      for (const [side, other] of [
        [client, this.upstream],
        [this.upstream, client]
      ]) {
        side.on('error', () => {})
        side.on('close', () => {
          if (!other.destroyed) other.destroy()
          this.onClosed(side === client ? 'client' : 'server')
        })
      }
    }

    fromClient(chunk) {
      if (this.firstLine === null) {
        this.firstLine = chunk.toString('latin1', 0, Math.min(chunk.length, 200)).split('\r\n')[0]
        const ws = /^GET (\S+) HTTP/.exec(this.firstLine)
        const isUpgrade = /\r\nupgrade:\s*websocket/i.test(chunk.toString('latin1'))
        if (ws && isUpgrade) {
          const path = ws[1].split('?')[0]
          totals.wsUpgrades[path] = (totals.wsUpgrades[path] ?? 0) + 1
          this.wsPath = path
          emit('ws-upgrade', { conn: this.id, path })
        }
      }
      if (fault.kind === 'blackhole') this.heldUp.push(chunk)
      else this.writeUp(chunk)
    }

    fromServer(chunk) {
      if (fault.kind === 'blackhole' || fault.kind === 'stall-downstream') this.heldDown.push(chunk)
      else this.writeDown(chunk)
    }

    writeUp(chunk) {
      totals.bytesUp += chunk.length
      later(() => !this.upstream.destroyed && this.upstream.write(chunk))
    }

    writeDown(chunk) {
      totals.bytesDown += chunk.length
      later(() => !this.client.destroyed && this.client.write(chunk))
    }

    flush() {
      if (fault.kind !== 'blackhole') {
        for (const chunk of this.heldUp.splice(0)) this.writeUp(chunk)
      }
      if (fault.kind !== 'blackhole' && fault.kind !== 'stall-downstream') {
        for (const chunk of this.heldDown.splice(0)) this.writeDown(chunk)
      }
    }

    reset() {
      if (this.closed) return
      totals.reset += 1
      this.client.resetAndDestroy()
      this.upstream.resetAndDestroy()
    }

    onClosed(by) {
      if (this.closed) return
      this.closed = true
      pairs.delete(this)
      emit('conn-close', {
        conn: this.id,
        by,
        path: this.wsPath ?? this.firstLine?.split(' ')[1] ?? null,
        lifetimeMs: Date.now() - this.openedAt
      })
    }
  }

  const server = createServer((client) => {
    if (fault.kind === 'down') {
      totals.refused += 1
      emit('conn-refused')
      client.on('error', () => {})
      client.resetAndDestroy()
      return
    }
    totals.accepted += 1
    const pair = new Pair(client)
    pairs.add(pair)
    emit('conn-open', { conn: pair.id, fault: fault.kind })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, '127.0.0.1', resolve)
  })

  const setFault = (next, ms, onEnd) => {
    if (faultTimer) clearTimeout(faultTimer)
    faultTimer = null
    fault = next
    emit('fault', { fault: next.kind, ms: ms ?? null, open: pairs.size })
    if (ms !== undefined) {
      faultTimer = setTimeout(() => {
        faultTimer = null
        onEnd()
      }, ms)
    }
  }

  const resetAll = () => {
    const n = pairs.size
    for (const pair of [...pairs]) pair.reset()
    return n
  }

  const api = {
    port: server.address().port,
    /** Clear any fault now and flush held bytes. */
    pass() {
      setFault({ kind: 'pass' })
      for (const pair of pairs) pair.flush()
    },
    /** Reset every open connection; the link stays up. */
    rst() {
      const n = resetAll()
      emit('rst', { reset: n })
      return n
    },
    /** Hold every byte both ways; after `ms` resume (flush) or reset every pair. */
    blackhole(ms, { end = 'resume' } = {}) {
      setFault({ kind: 'blackhole' }, ms, () =>
        end === 'destroy' ? api.endBlackhole('destroy') : api.pass()
      )
    },
    /** End a blackhole now: `resume` flushes held bytes, `destroy` resets every pair. */
    endBlackhole(how) {
      if (how === 'destroy') {
        const n = resetAll()
        setFault({ kind: 'pass' })
        emit('rst', { reset: n, reason: 'blackhole-destroy' })
        return
      }
      api.pass()
    },
    /** Forward browser->server, hold server->browser for `ms`. */
    stallDownstream(ms) {
      setFault({ kind: 'stall-downstream' }, ms, () => api.pass())
    },
    /** Reset every open pair and refuse new connections for `ms`. */
    down(ms) {
      setFault({ kind: 'down' }, ms, () => api.pass())
      emit('rst', { reset: resetAll(), reason: 'down' })
    },
    fault: () => fault.kind,
    stats: () => ({
      ...totals,
      wsUpgrades: { ...totals.wsUpgrades },
      open: pairs.size,
      openWs: [...pairs].filter((p) => p.wsPath).map((p) => ({ conn: p.id, path: p.wsPath }))
    }),
    async close() {
      if (faultTimer) clearTimeout(faultTimer)
      for (const pair of [...pairs]) {
        pair.client.destroy()
        pair.upstream.destroy()
      }
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
  return api
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.target) {
    console.error(
      'usage: node fault-proxy.mjs --target <port> [--listen <port>] [--control <port>]'
    )
    process.exit(2)
  }
  const proxy = await startFaultProxy({
    targetPort: Number(args.target),
    listenPort: Number(args.listen ?? 0),
    delayMs: Number(args.delay ?? 0),
    onEvent: (e) => console.log(JSON.stringify(e))
  })
  const control = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://control')
    const ms = url.searchParams.has('ms') ? Number(url.searchParams.get('ms')) : undefined
    const actions = {
      '/rst': () => proxy.rst(),
      '/blackhole': () => proxy.blackhole(ms, { end: url.searchParams.get('end') ?? 'resume' }),
      '/blackhole-end': () => proxy.endBlackhole(url.searchParams.get('how') ?? 'resume'),
      '/stall-downstream': () => proxy.stallDownstream(ms),
      '/down': () => proxy.down(ms),
      '/pass': () => proxy.pass(),
      '/stats': () => proxy.stats()
    }
    const action = actions[url.pathname]
    if (!action) {
      res.writeHead(404).end('unknown fault\n')
      return
    }
    const result = action()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(`${JSON.stringify(result ?? { ok: true, fault: proxy.fault() })}\n`)
  })
  await new Promise((resolve) => control.listen(Number(args.control ?? 0), '127.0.0.1', resolve))
  console.error(
    `fault-proxy listening on 127.0.0.1:${proxy.port} -> ${args.target}; control on 127.0.0.1:${control.address().port}`
  )
  const shutdown = async () => {
    control.close()
    await proxy.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}
