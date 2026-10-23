/**
 * Reading the native terminal out of the GPUIX automation tree in the real
 * shell: each terminal row is one child of the `terminal-<store id>` element,
 * its text the concatenation of its runs.
 */
import path from 'node:path'
import type { TreeNode } from '@gpuix/native/automation'
import type { withGpuix } from '../parity/shoot-gpuix'

export type GpuixApp = Parameters<Parameters<typeof withGpuix>[1]>[0]['app']

function walk(node: TreeNode | null | undefined, visit: (n: TreeNode) => void): void {
  if (!node) return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}
function textOf(node: TreeNode): string {
  let text = node.text ?? ''
  for (const child of node.children ?? []) text += textOf(child)
  return text
}

export interface Row {
  text: string
  x: number
  y: number
  height: number
  /** Width of one cell, from the widest text run on the row (ASCII, one cell per char). */
  cellWidth: number | null
}
export interface TerminalNode {
  testId: string
  rows: Row[]
}

/** Every painted workspace terminal: its rows top to bottom. */
export async function terminals(app: GpuixApp): Promise<TerminalNode[]> {
  const { tree } = await app.call('getTree', {})
  const found: TerminalNode[] = []
  walk(tree, (node) => {
    if (!node.testId?.startsWith('terminal-') || node.testId === 'terminal-assist-close') return
    const rows: Row[] = []
    for (const child of node.children ?? []) {
      const b = child.bounds
      if (!b) continue
      let cellWidth: number | null = null
      walk(child, (n) => {
        const t = n.text
        if (t && n.bounds && t.length > 0 && t.trim().length > 0) {
          const w = n.bounds.width / t.length
          if (cellWidth === null || t.length > 1) cellWidth = w
        }
      })
      rows.push({ text: textOf(child), x: b.x, y: b.y, height: b.height, cellWidth })
    }
    found.push({ testId: node.testId, rows })
  })
  return found
}

export async function until<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await probe()
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await Bun.sleep(50)
  }
}

export const rowMatching = (term: TerminalNode | undefined, pattern: RegExp) =>
  term?.rows.find((r) => pattern.test(r.text.trim()))

/**
 * Click the status-bar Terminal button (the same spawn path as Ctrl+Shift+Alt+T)
 * and wait for the new tab's prompt. Returns the terminal's test id.
 */
export async function openStatusBarTerminal(app: GpuixApp, windowHeight: number): Promise<string> {
  const button = (await app.getByText('Terminal').all()).find(
    (n) => n.text === 'Terminal' && (n.bounds?.y ?? 0) > windowHeight - 40
  )?.bounds
  if (!button) throw new Error('no status-bar Terminal button')
  await app.mouse.click({ x: button.x + button.width / 2, y: button.y + button.height / 2 })
  const opened = await until(
    'a terminal tab with a prompt',
    async () => (await terminals(app)).find((t) => t.rows.some((r) => r.text.trim())),
    30_000
  )
  return opened.testId
}

interface Size {
  width: number
  height: number
}

function xlib(display: string, script: string, ...args: string[]): void {
  const proc = Bun.spawnSync(
    ['uv', 'run', '--quiet', '--with', 'python-xlib==0.33', 'python', '-I', script, ...args],
    { env: { ...process.env, DISPLAY: display } }
  )
  if (proc.exitCode !== 0)
    throw new Error(`${path.basename(script)} failed: ${proc.stderr.toString()}`)
}

const sizeArg = (size: Size) => `${size.width}x${size.height}`

/** Resize the client's window as a user dragging its edge would. */
export function resizeWindow(display: string, from: Size, to: Size): void {
  xlib(
    display,
    path.join(import.meta.dir, '../parity/resize-window.py'),
    sizeArg(from),
    sizeArg(to)
  )
}

/** The first port in the test range 8190-8199 nothing listens on. */
export function freePort(): number {
  const listening = Bun.spawnSync(['ss', '-ltnH']).stdout.toString()
  for (let port = 8190; port <= 8199; port++) if (!listening.includes(`:${port} `)) return port
  throw new Error('no free port in 8190-8199')
}
