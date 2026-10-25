/**
 * Canvas acceptance in the real GPUIX shell under Xvfb: FigCraft in a helper webview, driven by
 * the shell's own canvas code, by agent MCP calls, and by real X input (XTest) where the webview
 * is involved, because GPUIX automation input never reaches X.
 *
 *   CARGO_TARGET_DIR=... bun run build:webview-host   # once; the check uses dist/termul-webview-host
 *   bun tools/canvas/canvas-check.ts [--out DIR]
 *
 * The test server lacks the FigCraft bundle, so it runs behind `bundle-proxy.ts` with the pinned
 * bundle. Writes PNGs and results.json to DIR (default /tmp/gpuix-v1/canvas-check).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient, OUT_DIR } from '../../build'
import { WEBVIEW_HOST_BIN } from '../../src/browser/support'
import {
  alive,
  childWindows,
  closeWindow,
  descendants,
  mapState,
  processTable,
  type Rect,
  xinput
} from '../browser/probes'
import { type App, startSession } from '../browser/session'
import { sendPrompt } from '../chat/seed'
import { startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS } from '../parity/shoot-gpuix'
import { seedWorkspace } from '../parity/workspace'
import { commandId, connectWs } from '../shared/ws'
import { freePort, until } from '../terminal/shell-tree'
import { ensureFigcraftBundle } from './bundle'
import { startBundleProxy } from './bundle-proxy'
import { regionColors } from './pixels'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-v1/canvas-check' },
    bundle: { type: 'string', default: '/tmp/gpuix-v1/figcraft-bundle' }
  }
})
const OUT = values.out!
const SIZE = { width: 1280, height: 800 }
const PROJECT = 'parity-alpha'
const sameRect = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
interface AgentResult {
  content?: { text?: string }[]
  isError?: boolean
  error?: unknown
}
interface AgentCall {
  ms: number
  isError: boolean
  text: string
  json: Record<string, unknown> | null
}
const closers: (() => void)[] = []
const results: { check: string; ok: boolean; detail: unknown }[] = []
const measures: Record<string, unknown> = {}
function check(name: string, ok: boolean, detail: unknown = {}): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

if (!existsSync(path.join(OUT_DIR, WEBVIEW_HOST_BIN))) {
  throw new Error('build the helper first: CARGO_TARGET_DIR=... bun run build:webview-host')
}
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const bundleDir = await ensureFigcraftBundle(values.bundle!)
const build = await buildClient()
if (!build.ok) throw new Error(build.logs.join('\n'))
const server = await startTestServer({
  port: freePort(),
  token: 'v1-canvas-token',
  stateDir: path.join(OUT, 'server')
})
const proxy = startBundleProxy({ upstream: server.baseUrl, bundleDir, port: freePort() })
const logFile = path.join(OUT, 'app.log')
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
const logged = (pattern: RegExp, ms = 20_000) =>
  until(`log ${pattern}`, async () => pattern.exec(log()), ms)

await seedWorkspace(server)
const PROJECT_DIR = path.join(server.stateDir, 'projects', 'alpha')
const s = await startSession({
  server: { ...server, baseUrl: proxy.baseUrl },
  entry: build.entry,
  ...SIZE,
  clientStateDir: path.join(OUT, 'client'),
  logFile
})
const app: App = s.app
const shot = (name: string) => s.grab(path.join(OUT, `${name}.png`))
const X = (...args: string[]) => xinput(s.display, ...args)

try {
  await app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
  const origin = await s.origin()
  const click = (x: number, y: number) =>
    X('click', String(Math.round(origin.x + x)), String(Math.round(origin.y + y)))

  // 1. The rail's Canvas button opens the canvas tab with FigCraft painted in its slot.
  const openedAt = Date.now()
  await app.getByText('Canvas').click()
  const tabId = (await logged(/created canvas (\S+)/))[1]
  const parentXid = (await logged(/attached to window (0x[0-9a-f]+)/))[1]
  const helperPid = Number((await logged(/started webview host (\d+)/))[1])
  const view = await until('canvas webview over its slot', async () => {
    const child = childWindows(s.display, parentXid).find(
      (w) => w.rect.x >= 0 && w.rect.width > 100
    )
    return child && mapState(s.display, child.id) === 'IsViewable' ? child : null
  })
  await app.getByText('Ready').waitFor({ timeoutMs: 60_000 })
  measures.openToReadyMs = Date.now() - openedAt
  await Bun.sleep(1500)
  await shot('01-canvas-open')
  const colors = regionColors(path.join(OUT, '01-canvas-open.png'), view.rect)
  check('the Canvas button opens FigCraft in a webview over the canvas slot', colors > 50, {
    tabId,
    helperPid,
    view,
    distinctColorsInSlot: colors,
    openToReadyMs: measures.openToReadyMs
  })

  // 2. An agent's canvas MCP tools: host gateway -> this renderer -> bridge -> relay -> FigCraft.
  const ws = await connectWs({
    baseUrl: server.baseUrl,
    token: server.token,
    deviceId: 'v1-canvas-check',
    clientInstanceId: 'canvas-check'
  })
  const agentOut = path.join(OUT, 'agent-calls.jsonl')
  const agentConfig = {
    configId: 'custom-canvas-agent',
    name: 'Canvas Agent',
    command: 'bun',
    args: [path.join(import.meta.dir, 'canvas-agent.ts')],
    env: { CANVAS_AGENT_OUT: agentOut },
    allowTerminal: false
  }
  const { agentId } = await ws.request<{ agentId: string }>(
    'spawn_agent',
    { config: agentConfig, projectId: PROJECT },
    { commandId: commandId('spawn') }
  )
  const { sessionId } = await ws.request<{ sessionId: string }>(
    'create_session',
    { agentId, cwd: PROJECT_DIR, projectId: PROJECT },
    { commandId: commandId('session') }
  )
  closers.push(() => ws.close())
  /** One canvas tool call by the agent; the parsed JSON of its text result, or its error. */
  const canvasCall = async (tool: string, args: object): Promise<AgentCall> => {
    const t0 = Date.now()
    await sendPrompt(ws, { agentId, sessionId }, `canvas-call ${tool} ${JSON.stringify(args)}`)
    const last = readFileSync(agentOut, 'utf8').trim().split('\n').pop() ?? '{}'
    const { result } = JSON.parse(last) as { result: AgentResult }
    const text = result?.content?.map((c) => c.text ?? '').join('') ?? ''
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { ms: Date.now() - t0, isError: Boolean(result?.isError || result?.error), text, json }
  }
  const created = await canvasCall('create_node', {
    type: 'frame',
    name: 'V1 agent frame',
    x: 40,
    y: 40,
    width: 320,
    height: 200,
    props: { fill: '#3366FF' }
  })
  const frameId = created.json?.id as string | number | undefined
  const readBack = frameId === undefined ? null : await canvasCall('get_node', { id: frameId })
  await app
    .getByText('Unsaved changes')
    .waitFor({ timeoutMs: 10_000 })
    .catch(() => null)
  await Bun.sleep(800)
  await shot('02-agent-frame')
  const node = readBack?.json as { name?: string; width?: number; height?: number } | null
  check(
    'an agent create_node through the canvas MCP tools lands in FigCraft and get_node reads it back',
    !created.isError &&
      node?.name === 'V1 agent frame' &&
      node.width === 320 &&
      node.height === 200,
    {
      createMs: created.ms,
      readMs: readBack?.ms,
      created: created.text.slice(0, 300),
      readBack: readBack?.text.slice(0, 300)
    }
  )

  // 3. Save: the panel's Save button asks the editor for the document over the bridge.
  const docFile = path.join(PROJECT_DIR, 'design.figcraft')
  await app.getByText('Save').click()
  const saved = await until(
    'design.figcraft written',
    async () => (existsSync(docFile) && statSync(docFile).size > 0 ? statSync(docFile).size : null),
    20_000
  ).catch(() => 0)
  const dirtyGone = await until('the unsaved dot clears', async () =>
    (await app.getByText('Unsaved changes').all()).length === 0 ? true : null
  ).catch(() => false)
  check('Save writes the document the editor hands over the bridge', saved > 0 && dirtyGone, {
    bytes: saved,
    dirtyCleared: dirtyGone
  })

  // 4. Preferences over the canvas: the webview leaves the window, the dialog is whole, and the
  // editor keeps answering agent calls while it is out of sight.
  click(24, 777)
  await app.getByText('Appearance').waitFor({ timeoutMs: 10_000 })
  const offscreen = await until('canvas webview out of the window', async () => {
    const w = childWindows(s.display, parentXid).find((c) => c.id === view.id)
    return w && w.rect.x < 0 ? w.rect : null
  }).catch(() => null)
  await Bun.sleep(600)
  await shot('03-preferences-over-canvas')
  const hiddenCall = await canvasCall('create_node', {
    type: 'rectangle',
    name: 'V1 hidden rect',
    x: 420,
    y: 40,
    width: 120,
    height: 80
  })
  const hiddenId = hiddenCall.json?.id as string | number | undefined
  X('key', 'Escape')
  const back = await until('canvas webview back over its slot', async () => {
    const w = childWindows(s.display, parentXid).find((c) => c.id === view.id)
    return w && sameRect(w.rect, view.rect) ? w.rect : null
  }).catch(() => null)
  await Bun.sleep(800)
  await shot('04-preferences-closed')
  check(
    'a GPUIX dialog over the canvas is fully visible; the hidden editor still answers; it returns after',
    offscreen !== null && back !== null && !hiddenCall.isError && hiddenId !== undefined,
    { offscreen, back, hiddenCallMs: hiddenCall.ms, hiddenCall: hiddenCall.text.slice(0, 200) }
  )
} catch (error) {
  check('run', false, String(error))
  await shot('zz-failure').catch(() => {})
} finally {
  for (const close of closers) close()
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, measures }, null, 2))
  await s.stop()
  proxy.stop()
  await server.stop()
}
const failed = results.filter((result) => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed; results in ${OUT}`)
process.exit(failed.length ? 1 : 0)
