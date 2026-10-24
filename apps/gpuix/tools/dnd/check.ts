/**
 * Drag-and-drop and resizable-panel acceptance in the real app shell on GPUIX,
 * against a seeded test server, with every gesture sent as GPUI mouse input
 * and the OS drop sent over X11's XDND protocol:
 *
 * - an OS file dropped on the new-chat composer becomes an attachment chip;
 * - dragging tab "Terminal 2" before "Terminal 1" reorders the tabs;
 * - dragging a terminal tab onto the right edge of its pane splits the pane,
 *   and both shells still answer typed commands;
 * - dragging the split divider changes the pane widths, which survive a
 *   client restart;
 * - dragging a file from the Explorer onto a pane opens it there;
 * - the shared EditorTocLayout shows the outline beside a markdown file, and
 *   dragging its handle changes the outline width.
 *
 * bun tools/dnd/check.ts [--out DIR] [--only name,...]
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { TreeNode } from '@gpuix/native/automation'
import { buildClient } from '../../build'
import { startTestServer, type TestServer } from '../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { seedWorkspace } from '../parity/workspace'
import { registerAgent } from '../shared/seed'
import { connectWs } from '../shared/ws'
import {
  freePort,
  type GpuixApp,
  openStatusBarTerminal,
  rowMatching,
  terminals,
  until
} from '../terminal/shell-tree'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-d1/dnd' },
    only: { type: 'string' }
  }
})
const OUT = values.out!
const only = values.only ? new Set(values.only.split(',')) : null
const want = (name: string) => !only || only.has(name)
const STATE = path.join(OUT, 'state')
const SIZE = { width: 1280, height: 800 }
const TOKEN = 'd1-dnd-token'
const DEVICE_ID = 'd1-gpuix'
const AGENT_ID = 'custom-d1-agent'

const results: Array<{ check: string; ok: boolean; detail: unknown }> = []
function check(name: string, ok: boolean, detail: unknown): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

interface Point {
  x: number
  y: number
}
interface Box extends Point {
  width: number
  height: number
}

/** A press, then moves at a hand's pace so each frame paints, then the release. */
async function handDrag(app: GpuixApp, from: Point, to: Point, steps = 14): Promise<void> {
  await app.mouse.move(from)
  await app.mouse.down(from)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await app.mouse.move(
      { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
      { pressedButton: 0 }
    )
    await Bun.sleep(40)
  }
  await Bun.sleep(150)
  await app.mouse.up(to)
}

const center = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

function walk(node: TreeNode | null | undefined, visit: (n: TreeNode) => void): void {
  if (!node) return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

type PaintedNode = TreeNode & { bounds: Box }

async function painted(app: GpuixApp, match: (n: PaintedNode) => boolean): Promise<PaintedNode[]> {
  const { tree } = await app.call('getTree', {})
  const found: PaintedNode[] = []
  walk(tree, (n) => {
    if (n.bounds && match(n as PaintedNode)) found.push(n as PaintedNode)
  })
  return found
}

/** Painted text nodes in the tab bar strip (above y=50), left to right. */
async function tabLabels(app: GpuixApp): Promise<{ text: string; x: number }[]> {
  const nodes = await painted(
    app,
    (n) => typeof n.text === 'string' && /^Terminal \d$|\.md$|\.txt$/.test(n.text)
  )
  return nodes
    .filter((n) => n.bounds.y < 50 && n.bounds.x > 470)
    .map((n) => ({ text: n.text as string, x: Math.round(n.bounds.x) }))
    .sort((a, b) => a.x - b.x)
}

interface PaneTerminal {
  testId: string
  box: Box
}

async function paneTerminals(app: GpuixApp): Promise<PaneTerminal[]> {
  const nodes = await painted(
    app,
    (n) => !!n.testId?.startsWith('terminal-') && n.testId !== 'terminal-assist-close'
  )
  return nodes
    .filter((n) => n.bounds.width > 0)
    .map((n) => ({ testId: n.testId as string, box: n.bounds }))
    .sort((a, b) => a.box.x - b.box.x)
}

async function typeInto(app: GpuixApp, testId: string, text: string): Promise<void> {
  const node = await app.getByTestId(testId).element()
  const keys = [...text].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')
  await app.call('keystrokes', { elementId: node.id, keys: `${keys} enter` })
}

function xdndDrop(display: string, point: Point, files: string[]): string {
  const proc = Bun.spawnSync(
    [
      'uv',
      'run',
      '--quiet',
      '--with',
      'python-xlib==0.33',
      'python',
      '-I',
      path.join(import.meta.dir, 'xdnd-drop.py'),
      `${SIZE.width}x${SIZE.height}`,
      String(Math.round(point.x)),
      String(Math.round(point.y)),
      ...files
    ],
    { env: { ...process.env, DISPLAY: display } }
  )
  return `${proc.exitCode}: ${proc.stdout.toString().trim().replaceAll('\n', ' | ')} ${proc.stderr.toString().trim()}`
}

function pinDeviceId(clientStateDir: string, server: TestServer): void {
  const host = new URL(server.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
  const file = path.join(clientStateDir, 'web-storage', `${host}.json`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ 'termul.deviceId': DEVICE_ID }), { mode: 0o600 })
}

async function seed(server: TestServer): Promise<void> {
  await seedWorkspace(server)
  const ws = await connectWs({
    baseUrl: server.baseUrl,
    token: TOKEN,
    deviceId: DEVICE_ID,
    clientInstanceId: 'd1-seed'
  })
  await registerAgent(ws, DEVICE_ID, {
    configId: AGENT_ID,
    name: 'D1 Agent',
    command: 'bun',
    args: [path.join(import.meta.dir, '../composer/prompt-agent.ts')],
    env: { COMPOSER_PROMPT_LOG: path.join(STATE, 'prompts.jsonl') },
    allowTerminal: false
  })
  ws.close()
}

const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
rmSync(STATE, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const dropDir = path.join(STATE, 'drop')
mkdirSync(dropDir, { recursive: true })
const dropped = path.join(dropDir, 'drop-notes.md')
writeFileSync(dropped, '# dropped from the OS\n')

// launch() pipes the client's stderr and never reads it: send it to a file instead.
const clientLog = path.join(OUT, 'client-stderr.log')
const entry = path.join(STATE, 'entry.mjs')
writeFileSync(
  entry,
  `import { appendFileSync } from 'node:fs'
const sink = (...parts) => appendFileSync(${JSON.stringify(clientLog)}, parts.map(String).join(' ') + '\\n')
console.error = sink
console.warn = sink
process.on('uncaughtException', (e) => sink('uncaught', e?.stack ?? e))
process.on('unhandledRejection', (e) => sink('unhandled', e?.stack ?? e))
await import(${JSON.stringify(build.entry)})
`
)
rmSync(clientLog, { force: true })
const server = await startTestServer({
  port: freePort(),
  token: TOKEN,
  stateDir: path.join(STATE, 'server')
})
const clientStateDir = path.join(STATE, 'client')
const session = { server, entry, clientStateDir, ...SIZE }
let dividerAfterDrag: number | null = null
try {
  await seed(server)
  pinDeviceId(clientStateDir, server)

  await withGpuix(session, async ({ app, display, grab }) => {
    const composerHint = 'What should we do in alpha?'
    await app.getByText(composerHint).waitFor({ timeoutMs: READY_TIMEOUT_MS })
    const openExplorer = async () => {
      const tab = (await app.getByText('Explorer').all()).find(
        (n) => (n.bounds?.y ?? 0) > 45 && (n.bounds?.y ?? 0) < 70
      )?.bounds
      if (tab) await app.mouse.click(center(tab as Box))
    }
    const explorerRow = async (name: string) =>
      (await until(
        `${name} in the Explorer`,
        async () =>
          (await app.getByText(name).all()).find((n) => (n.bounds?.x ?? 999) < 470)?.bounds,
        15_000
      )) as Box

    if (want('os-drop')) {
      await app
        .getByText('D1 Agent')
        .waitFor({ timeoutMs: 30_000 })
        .catch(() => {})
      await Bun.sleep(3000)
      const hint = await app.getByText(composerHint).bounds()
      const log = xdndDrop(display, { x: hint.x + 40, y: hint.y + hint.height / 2 }, [dropped])
      const chip = await until(
        'attachment chip',
        async () => (await app.getByText('drop-notes.md').count()) > 0,
        10_000
      ).catch(() => false)
      await grab(path.join(OUT, 'os-drop-chip.png'))
      const toasts = (
        await painted(
          app,
          (n) => typeof n.text === 'string' && /can't|Unsupported|too large/i.test(n.text)
        )
      ).map((n) => n.text)
      check(
        'an OS file dropped on the new-chat composer shows its attachment chip',
        chip === true,
        { xdnd: log, toasts }
      )
    }

    if (want('toc')) {
      await openExplorer()
      await app.mouse.click(center(await explorerRow('README.md')))
      await app.getByTestId('markdown-preview').waitFor({ timeoutMs: 20_000 })
      const handleOf = async () =>
        (await painted(app, (n) => !!n.testId?.startsWith('resize-handle-')))[0]?.bounds
      // The Outline toggle is the editor toolbar's last 28px button; the tree carries no aria-label.
      const toggle = (
        await painted(
          app,
          (n) =>
            n.type === 'div' &&
            n.bounds.width === 28 &&
            n.bounds.height === 28 &&
            n.bounds.y > 50 &&
            n.bounds.y < 85
        )
      ).sort((a, b) => b.bounds.x - a.bounds.x)[0]?.bounds
      // The outline belongs to the Source view (the native CodeEditor renders EditorTocLayout).
      await app.getByText('Source').click()
      await Bun.sleep(1500)
      if (toggle && !(await handleOf())) await app.mouse.click(center(toggle))
      const handle = await until('the outline handle', handleOf, 10_000).catch(() => undefined)
      await Bun.sleep(800)
      await grab(path.join(OUT, 'toc-open.png'))
      const outlineText = async () =>
        (await painted(app, (n) => n.text === 'alpha' && n.bounds.x > (handle?.x ?? 1e9))).map(
          (n) => Math.round(n.bounds.x)
        )
      const before = await outlineText()
      if (handle)
        await handDrag(app, center(handle), { x: center(handle).x - 80, y: center(handle).y }, 8)
      await Bun.sleep(800)
      const moved = await handleOf()
      await grab(path.join(OUT, 'toc-resized.png'))
      check(
        'the shared EditorTocLayout shows the outline beside README.md source; dragging its handle widens it',
        !!handle && before.length > 0 && !!moved && handle.x - moved.x > 60,
        {
          outlineToggle: toggle,
          handleBefore: handle,
          handleAfter: moved,
          outlineHeadingX: before
        }
      )
      await app.mouse.click(center(await explorerRow('README.md')))
    }

    if (want('tabs') || want('split') || want('resize') || want('explorer')) {
      await openStatusBarTerminal(app, SIZE.height)
      await openStatusBarTerminal(app, SIZE.height)
      await Bun.sleep(800)
      const terminalTabs = async () =>
        (await tabLabels(app)).filter((t) => t.text.startsWith('Terminal'))
      const before = await terminalTabs()
      await grab(path.join(OUT, 'tabs-before.png'))

      const label = async (text: string) =>
        (await app.getByText(text).all()).find((n) => (n.bounds?.y ?? 99) < 50)?.bounds as Box
      const t1 = await label('Terminal 1')
      const t2 = await label('Terminal 2')
      await handDrag(app, center(t2), { x: t1.x - 8, y: t1.y + t1.height / 2 })
      await Bun.sleep(500)
      const after = await terminalTabs()
      await grab(path.join(OUT, 'tabs-after.png'))
      check(
        'dragging tab Terminal 2 before Terminal 1 reorders the tabs',
        before.map((t) => t.text).join(',') === 'Terminal 1,Terminal 2' &&
          after.map((t) => t.text).join(',') === 'Terminal 2,Terminal 1',
        {
          before,
          after
        }
      )

      const [single] = await paneTerminals(app)
      const pane = single.box
      const t1Now = await label('Terminal 1')
      await handDrag(app, center(t1Now), {
        x: pane.x + pane.width - 40,
        y: pane.y + pane.height / 2
      })
      await Bun.sleep(1500)
      const split = await paneTerminals(app)
      await grab(path.join(OUT, 'split.png'))
      const ids = split.map((t) => t.testId)
      if (split.length === 2) {
        await typeInto(app, split[0].testId, 'echo left-alive')
        await typeInto(app, split[1].testId, 'echo right-alive')
      }
      const echoed = (i: number, text: RegExp) =>
        until(
          `pane ${i} echoes`,
          async () =>
            rowMatching(
              (await terminals(app)).find((t) => t.testId === ids[i]),
              text
            ),
          10_000
        ).catch(() => null)
      const leftAlive = await echoed(0, /^left-alive$/)
      const rightAlive = await echoed(1, /^right-alive$/)
      await grab(path.join(OUT, 'split-alive.png'))
      check(
        'dragging tab Terminal 1 onto the right edge splits the pane; both shells answer',
        split.length === 2 &&
          split[0].box.x + split[0].box.width <= split[1].box.x &&
          !!leftAlive &&
          !!rightAlive,
        {
          panes: split.map((t) => ({
            testId: t.testId,
            x: Math.round(t.box.x),
            width: Math.round(t.box.width)
          })),
          leftAlive: !!leftAlive,
          rightAlive: !!rightAlive
        }
      )

      if (split.length === 2 && want('resize')) {
        const handle = (await painted(app, (n) => !!n.testId?.startsWith('resize-handle-')))[0]
          ?.bounds
        const widthsBefore = split.map((t) => Math.round(t.box.width))
        if (handle)
          await handDrag(
            app,
            center(handle),
            { x: center(handle).x - 200, y: center(handle).y },
            10
          )
        await Bun.sleep(1500)
        const widthsAfter = (await paneTerminals(app)).map((t) => Math.round(t.box.width))
        const moved = (await painted(app, (n) => !!n.testId?.startsWith('resize-handle-')))[0]
          ?.bounds
        dividerAfterDrag = moved ? Math.round(moved.x) : null
        await grab(path.join(OUT, 'resized.png'))
        check(
          'dragging the divider 200px left narrows the left pane and widens the right one',
          !!handle &&
            widthsBefore[0] - widthsAfter[0] > 180 &&
            widthsAfter[1] - widthsBefore[1] > 180,
          {
            handleBefore: handle && Math.round(handle.x),
            handleAfter: dividerAfterDrag,
            widthsBefore,
            widthsAfter
          }
        )
      }

      if (want('explorer')) {
        await openExplorer()
        const row = await explorerRow('notes.txt')
        const target = (await paneTerminals(app)).at(-1)?.box
        if (target) await handDrag(app, center(row), center(target))
        const opened = await until(
          'notes.txt tab in the right pane',
          async () =>
            (await tabLabels(app)).find((t) => t.text === 'notes.txt' && t.x > (target?.x ?? 0)),
          10_000
        ).catch(() => null)
        await grab(path.join(OUT, 'explorer-drop.png'))
        check('dragging notes.txt from the Explorer onto the right pane opens it there', !!opened, {
          row,
          target,
          tabs: await tabLabels(app)
        })
      }
    }
    // The pane layout is written to the server debounced; let it land before the restart.
    await Bun.sleep(2500)
  })

  if (dividerAfterDrag !== null) {
    const expected = dividerAfterDrag
    await withGpuix(session, async ({ app, grab }) => {
      await app.getByText('Changes').waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const divider = await until(
        'a split divider after restart',
        async () =>
          (await painted(app, (n) => !!n.testId?.startsWith('resize-handle-')))[0]?.bounds,
        20_000
      ).catch(() => null)
      await Bun.sleep(800)
      await grab(path.join(OUT, 'restarted.png'))
      check(
        'the dragged divider position survives a client restart',
        !!divider && Math.abs(Math.round(divider.x) - expected) <= 3,
        {
          beforeRestart: expected,
          afterRestart: divider && Math.round(divider.x)
        }
      )
    })
  }
} catch (error) {
  check('error', false, String(error instanceof Error ? error.stack : error))
} finally {
  await server.stop()
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1)
