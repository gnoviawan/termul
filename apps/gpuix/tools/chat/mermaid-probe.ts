/**
 * `bun tools/chat/mermaid-probe.ts [--binary PATH] [--out DIR]`
 *
 * Drives the webview helper's mermaid renderer over its stdio protocol and measures it: the
 * helper's memory before and after its first diagram, the first render (renderer page and mermaid
 * load included), a warm render of a new diagram, the same diagram again, and a source mermaid
 * rejects, then the memory once the helper has released the idle renderer and the first render
 * after that. Runs under its own Xvfb; the helper's parent is that display's root window. Writes each
 * PNG to `--out` and prints one JSON report.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { HostProcess } from '../../src/browser/host-process'
import type { MermaidRender } from '../../src/browser/mermaid-render'
import type { HostEvent } from '../../src/browser/protocol'
import { startXvfb } from '../parity/shoot-gpuix'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    binary: {
      type: 'string',
      default: path.join(
        process.env.CARGO_TARGET_DIR ?? '/root/termul-wt/gpuix/src-tauri/target',
        'debug/termul-webview-host'
      )
    },
    out: { type: 'string', default: '/tmp/gpuix-mermaid-probe' }
  }
})

const ROUTER = `flowchart LR
  URL[hash URL] --> Router{createHashRouter}
  Router -->|/| Dashboard
  Router -->|/c/:sessionId| ChatRoute
  ChatRoute --> Open[openHistorySession]
  Router -->|/snapshots| Snapshots`
const SEQUENCE = `sequenceDiagram
  participant Web
  participant Server
  Web->>Server: list_persisted_sessions
  Server-->>Web: rows`
const BROKEN = 'flowchart LR\n  A -->'
const STATE = `stateDiagram-v2
  [*] --> Idle
  Idle --> Rendering: renderMermaid
  Rendering --> Idle: mermaid`
/** The helper's `MERMAID_IDLE` (30 s) plus time for WebKit to end the web process. */
const RELEASED_AFTER_MS = 33_000

/** Resident memory of `pid` and every process below it, in MiB, in total and per process. */
function treeRss(pid: number): { total: number; byProcess: Record<string, number> } {
  const children = new Map<number, number[]>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)])
    } catch {}
  }
  const mib = (kib: number) => Math.round(kib / 102.4) / 10
  let kib = 0
  const byProcess: Record<string, number> = {}
  const stack = [pid]
  while (stack.length > 0) {
    const next = stack.pop() as number
    try {
      const status = readFileSync(`/proc/${next}/status`, 'utf8')
      const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0)
      const name = `${/Name:\s+(\S+)/.exec(status)?.[1] ?? '?'} ${next}`
      kib += rss
      byProcess[name] = mib(rss)
    } catch {}
    stack.push(...(children.get(next) ?? []))
  }
  return { total: mib(kib), byProcess }
}

const treeRssMiB = (pid: number) => treeRss(pid).total

const out = values.out as string
await mkdir(out, { recursive: true })
const xvfb = await startXvfb(800, 600)
const rootWindow = /Window id: (0x[0-9a-f]+)/.exec(
  Bun.spawnSync(['xwininfo', '-root', '-display', xvfb.display]).stdout.toString()
)?.[1]
if (!rootWindow) throw new Error(`no root window on ${xvfb.display}`)
const answers = new Map<string, (result: MermaidRender) => void>()
let ready = false
const helper = new HostProcess({
  binary: values.binary as string,
  args: ['--parent', rootWindow],
  env: { ...process.env, DISPLAY: xvfb.display },
  onEvent: (event: HostEvent) => {
    if (event.ev === 'ready') ready = true
    if (event.ev !== 'mermaid') return
    answers.get(event.id)?.(
      event.ok
        ? { ok: true, png: event.png, svg: event.svg, width: event.width, height: event.height }
        : { ok: false, error: event.error }
    )
  },
  onStderr: (line) => console.error(line),
  onExit: (detail) => console.error(`helper ${detail}`)
})
let nextId = 1
const render = (source: string) =>
  new Promise<MermaidRender>((resolve) => {
    const id = `p${nextId++}`
    answers.set(id, resolve)
    void helper.request({ op: 'renderMermaid', id, source }).then((ack) => {
      if (!ack.ok) resolve({ ok: false, error: ack.error })
    })
  })
try {
  const readyBy = Date.now() + 5000
  while (!ready && Date.now() < readyBy) await Bun.sleep(20)
  await Bun.sleep(500)
  const pid = helper.pid
  if (!ready || !pid) throw new Error('the helper did not start')
  const idleMiB = treeRssMiB(pid)
  const timed = async (label: string, source: string) => {
    const started = performance.now()
    const result = await render(source)
    const ms = Math.round(performance.now() - started)
    if (result.ok) {
      writeFileSync(
        path.join(out, `${label}.png`),
        Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64')
      )
      return { label, ms, width: result.width, height: result.height, pngBytes: result.png.length }
    }
    return { label, ms, error: result.error }
  }
  const first = await timed('first', ROUTER)
  const afterFirstMiB = treeRssMiB(pid)
  const warm = await timed('warm', SEQUENCE)
  const repeat = await timed('repeat', ROUTER)
  const broken = await timed('broken', BROKEN)
  const afterAll = treeRss(pid)
  await Bun.sleep(RELEASED_AFTER_MS)
  const released = treeRss(pid)
  const afterIdle = await timed('after-idle', STATE)
  console.log(
    JSON.stringify(
      {
        binary: values.binary,
        memoryMiB: {
          idle: idleMiB,
          afterFirst: afterFirstMiB,
          afterAll: afterAll.total,
          released: released.total,
          afterIdleRender: treeRssMiB(pid)
        },
        processesMiB: { afterAll: afterAll.byProcess, released: released.byProcess },
        renders: [first, warm, repeat, broken, afterIdle]
      },
      null,
      2
    )
  )
} finally {
  helper.quit()
  await Bun.sleep(300)
  xvfb.stop()
}
