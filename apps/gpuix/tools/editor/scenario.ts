/**
 * The editor scenario both clients run: a seeded test server whose `alpha`
 * project holds a small TypeScript file, a README with frontmatter-free
 * markdown and a mermaid fence, and a 5,000-line file; plus the clicks that
 * open a file from the Explorer in the web client.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import type { Page } from 'playwright'
import { addProject, type TestServer } from '../parity/server'
import type { withGpuix } from '../parity/shoot-gpuix'

export const STATE_ROOT = process.env.GPUIX_STATE_ROOT ?? '/tmp/gpuix-e1'
export const SIZE = { width: 1280, height: 800 } as const
export const PROJECT = { id: 'editor-alpha', name: 'alpha' } as const
export const READY_TEXT = 'What should we do in alpha?'

/** The seeded file holds template literals; `${` here is file content, not interpolation. */
const DOLLAR = '$'

export const APP_TS = [
  "import { createServer } from 'node:http'",
  '',
  'const PORT = Number(process.env.PORT ?? 3000)',
  '',
  '/** Answers every request with a greeting and the request path. */',
  'export function handler(path: string): string {',
  `  return \`hello from ${DOLLAR}{path}\``,
  '}',
  '',
  'const server = createServer((req, res) => {',
  "  res.writeHead(200, { 'content-type': 'text/plain' })",
  "  res.end(handler(req.url ?? '/'))",
  '})',
  '',
  'server.listen(PORT, () => {',
  `  console.log(\`listening on ${DOLLAR}{PORT}\`)`,
  '})',
  ''
].join('\n')

export const README_MD = [
  '# alpha',
  '',
  'A small service used by the **editor** checks.',
  '',
  '## Run',
  '',
  '```sh',
  'bun src/app.ts',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  ''
].join('\n')

export const BIG_LINES = 5000

export function bigFile(): string {
  const lines: string[] = []
  for (let i = 1; i <= BIG_LINES; i++) {
    lines.push(
      i % 10 === 1
        ? `/** Block ${i}: generated for the large-file check. */`
        : `export const value${i} = compute(${i}, 'label ${i}') // line ${i}`
    )
  }
  return `${lines.join('\n')}\n`
}

export function projectDir(server: TestServer): string {
  return path.join(server.stateDir, 'projects', PROJECT.name)
}

export async function seedEditorProject(server: TestServer): Promise<string> {
  const dir = projectDir(server)
  await addProject(server, { id: PROJECT.id, name: PROJECT.name, path: dir, color: 'blue' })
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'app.ts'), APP_TS)
  await writeFile(path.join(dir, 'README.md'), README_MD)
  await writeFile(path.join(dir, 'big.ts'), bigFile())
  await writeFile(path.join(dir, 'boom.gpuix-crash'), 'this tab throws under test hooks\n')
  return dir
}

export async function freePort(): Promise<number> {
  for (let port = 8190; port <= 8199; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('no free port in 8190-8199')
}

/** Web client: open the Explorer and click through `segments` (folders, then the file). */
export async function webOpenFile(
  page: Page,
  segments: readonly string[],
  fromDashboard = true
): Promise<void> {
  if (fromDashboard) await page.getByText(READY_TEXT).first().waitFor({ timeout: 30_000 })
  const explorer = page.getByRole('tab', { name: 'Explorer', exact: true }).first()
  if ((await explorer.getAttribute('aria-selected')) !== 'true') await explorer.click()
  for (const name of segments) {
    await page.getByText(name, { exact: true }).first().click()
  }
}

type GpuixApp = Parameters<Parameters<typeof withGpuix>[1]>[0]['app']

async function waitFor<T>(label: string, probe: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await Bun.sleep(100)
  }
}

/** Click the Explorer tab, then each tree row by its label, in the side panel column. */
export async function gpuixOpenFile(app: GpuixApp, segments: readonly string[]): Promise<void> {
  const inPanel = async (label: string) => {
    const nodes = await app.getByText(label).all()
    return nodes.find((n) => (n.bounds?.x ?? 0) > 200 && (n.bounds?.x ?? 0) < 470)?.bounds
  }
  const tab = await waitFor('Explorer tab', () => inPanel('Explorer'))
  await app.mouse.click({ x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 })
  for (const name of segments) {
    const row = await waitFor(`tree row ${name}`, () => inPanel(name))
    await app.mouse.click({ x: row.x + row.width / 2, y: row.y + row.height / 2 })
  }
}
