/**
 * `bun tools/chat/check.ts [--port 8192]`
 *
 * Behaviour checks of the native transcript on a seeded chat, driven through
 * `@gpuix/react/automation` against the transcript scene:
 *
 * 1. At rest the list follows the tail: no jump-to-latest button.
 * 2. Scrolling up shows the button, and a turn that streams in meanwhile
 *    does not pull the reader down: the row under the reader stays put.
 *
 * The scene starts the chat itself (the launcher's `startChat`), so it owns
 * the live session and sends each scripted turn through the store.
 * 3. Clicking the button returns to the live edge: the button goes away and
 *    the newest row ends inside the list.
 * 4. Expanding the turn's activity and then its thought group shows the
 *    thought text.
 *
 * Exits non-zero on the first failed assertion.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { buildScene } from './scene/build'
import type { SceneCommand } from './scene/contract'
import { SCRIPT_PROMPTS } from './script'
import { CHAT_AGENT_CONFIG_ID, CHAT_PROJECT_ID, seedChat } from './seed'

type App = Parameters<Parameters<typeof withGpuix>[1]>[0]['app']

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: 'string', default: '8192' } } })

const results: Array<{ check: string; ok: boolean; detail: string }> = []

function assert(check: string, ok: boolean, detail: string): void {
  results.push({ check, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${check}: ${detail}`)
  if (!ok) throw new Error(`check failed: ${check} (${detail})`)
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(100)
    value = await read()
  }
  return value
}

type Node = Awaited<ReturnType<ReturnType<App['getByTestId']>['element']>>

/** Text of a subtree, native `<markdown>` sources included (they are props, not text nodes). */
function nodeText(node: Node): string {
  const own = [node.text ?? '', typeof node.customProps?.source === 'string' ? node.customProps.source : '']
  return [...own, ...(node.children ?? []).map(nodeText)].join(' ')
}

/** Pixels in `box` (window coordinates) clearly brighter than the dark background: painted glyphs. */
function inkedPixels(file: string, box: { x: number; y: number; width: number; height: number }): number {
  const png = PNG.sync.read(readFileSync(file))
  let count = 0
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(png.height, box.y + box.height); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(png.width, box.x + box.width); x++) {
      const i = (y * png.width + x) * 4
      if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 3 * 80) count++
    }
  }
  return count
}

/** Bounds of the lowest painted node that matches, in window coordinates. */
function lowest(root: Node, match: (node: Node) => boolean): Node['bounds'] {
  let best: Node['bounds']
  const visit = (node: Node) => {
    if (match(node) && node.bounds && node.bounds.height > 0 && (!best || node.bounds.y > best.y)) best = node.bounds
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return best
}

async function turnEnded(app: App): Promise<void> {
  const active = await poll(() => app.getByTestId('chat-scene-turn-active').count(), (n) => n === 0, 30_000)
  if (active !== 0) throw new Error('turn did not end within 30 s')
}

const jumpCount = (app: App) => app.getByTestId('chat-jump-latest').count()

/** The list's rows with their painted bounds, from one automation tree read. */
async function rows(app: App) {
  const list = await app.getByTestId('chat-transcript-list').element()
  // The virtual list reports no bounds of its own; its wrapper is exactly its box.
  const listBounds = await app.getByTestId('chat-transcript').bounds()
  return { list: listBounds, rows: list.children ?? [] }
}

async function lastRowBottom(app: App): Promise<{ row: number; list: number }> {
  const { list, rows: all } = await rows(app)
  const last = all[all.length - 1]?.bounds
  return { row: last ? last.y + last.height : Number.NaN, list: list.y + list.height }
}

const entry = await buildScene()
const seeded = await seedChat({ port: Number(values.port), prompts: 0 })
const { chat } = seeded
const control = path.join(seeded.stateDir, 'control.json')
let seq = 0
const command = (body: Record<string, unknown>) =>
  writeFileSync(control, JSON.stringify({ seq: seq++, ...body } as SceneCommand))
command({ scroll: 'bottom' })
Object.assign(process.env, {
  CHAT_START: `${CHAT_AGENT_CONFIG_ID}|${CHAT_PROJECT_ID}|${chat.root}`,
  CHAT_DEVICE: chat.deviceId,
  CHAT_BOX: '477,49,794,536',
  CHAT_CONTROL: control
})
try {
  await withGpuix(
    {
      server: { baseUrl: chat.baseUrl, token: chat.token, stateDir: seeded.stateDir, stop: async () => {} },
      entry,
      width: 1280,
      height: 800,
      clientStateDir: path.join(seeded.stateDir, 'gpuix-client')
    },
    async ({ app, grab }) => {
      // The scene starts the chat itself, so it owns the live session; the
      // scripted turns go through the store as the composer sends them.
      await Bun.sleep(4000)
      for (const prompt of SCRIPT_PROMPTS) {
        command({ prompt })
        await app.getByTestId('chat-scene-turn-active').waitFor({ timeoutMs: 15_000 })
        await turnEnded(app)
      }
      await app.getByTestId('chat-scene-ready').waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await Bun.sleep(1500)
      assert('at rest no jump button', (await jumpCount(app)) === 0, `jump buttons=${await jumpCount(app)}`)
      const atRest = await lastRowBottom(app)
      assert(
        'at rest the newest row ends inside the list',
        atRest.row <= atRest.list + 1,
        `row bottom ${atRest.row} list bottom ${atRest.list}`
      )

      const list = app.getByTestId('chat-transcript-list')
      for (let i = 0; i < 4; i++) await app.getByTestId('chat-transcript').wheel(0, 240)
      const shown = await poll(() => jumpCount(app), (n) => n === 1)
      assert('scrolling up shows jump to latest', shown === 1, `jump buttons=${shown}`)
      const scrolled = await rows(app)
      const reading = scrolled.rows.find((row) => row.bounds && row.bounds.y >= scrolled.list.y && row.bounds.height > 0)
      if (!reading?.bounds || !reading.testId) throw new Error('no visible row to anchor on')
      const before = reading.bounds.y
      const rowsBefore = scrolled.rows.length
      await grab('/tmp/gpuix-o2/check-scrolled.png')

      command({ prompt: 'Where else is the chat route parsed?' })
      const grown = await poll(
        async () => (await list.element()).children?.length ?? 0,
        (n) => n > rowsBefore,
        15_000
      )
      await turnEnded(app)
      await Bun.sleep(1000)
      const after = (await rows(app)).rows.find((row) => row.testId === reading.testId)?.bounds?.y ?? Number.NaN
      assert('new rows arrived while scrolled up', grown > rowsBefore, `rows ${rowsBefore} -> ${grown}`)
      assert(
        'auto-follow stays off while scrolled up',
        Math.abs(after - before) <= 1 && (await jumpCount(app)) === 1,
        `row ${reading.testId} y ${before} -> ${after}, jump buttons=${await jumpCount(app)}`
      )

      await app.getByTestId('chat-jump-latest').click()
      const hidden = await poll(() => jumpCount(app), (n) => n === 0)
      await Bun.sleep(800)
      const back = await lastRowBottom(app)
      assert('jump to latest hides the button', hidden === 0, `jump buttons=${hidden}`)
      assert(
        'jump to latest returns to the newest row',
        back.row <= back.list + 1 && back.row >= back.list - 120,
        `row bottom ${back.row} list bottom ${back.list}`
      )
      await grab('/tmp/gpuix-o2/check-bottom.png')

      // Bring the newest turn's activity row to the top, open it, then its thought.
      const allRows = (await rows(app)).rows
      let activityIndex = -1
      allRows.forEach((row, i) => {
        if (row.testId?.startsWith('chat-row-activity:')) activityIndex = i
      })
      command({ scroll: 'row', index: activityIndex, offset: 0 })
      await Bun.sleep(800)
      const transcript = await app.getByTestId('chat-transcript-list').element()
      // Text nodes carry no bounds; the disclosure row around the label does.
      const newest = lowest(
        transcript,
        (node) => (node.bounds?.height ?? 0) < 60 && nodeText(node).includes('Worked for')
      )
      if (!newest) throw new Error('no painted "Worked for" row')
      await app.mouse.click({ x: newest.x + newest.width / 2, y: newest.y + newest.height / 2 })
      await Bun.sleep(800)
      const run = lowest(
        await app.getByTestId('chat-transcript-list').element(),
        (node) => (node.bounds?.height ?? 0) < 60 && nodeText(node).includes('Thought,')
      )
      if (!run) throw new Error('no painted work-run row holding the thought')
      await app.mouse.click({ x: run.x + run.width / 2, y: run.y + run.height / 2 })
      await Bun.sleep(800)
      await grab('/tmp/gpuix-o2/check-activity.png')
      const triggers = await app.getByTestId('thought-group-trigger').count()
      assert('the activity shows a thought group', triggers > 0, `thought triggers=${triggers}`)
      const bodiesBefore = await app.getByTestId('thought-group-body').count()
      const trigger = lowest(await app.getByTestId('chat-transcript-list').element(), (node) => node.testId === 'thought-group-trigger')
      if (!trigger) throw new Error('no painted thought trigger')
      await app.mouse.click({ x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 })
      const body = await poll(() => app.getByTestId('thought-group-body').count(), (n) => n > bodiesBefore)
      assert('expanding a thought group shows its body', body === bodiesBefore + 1, `bodies ${bodiesBefore} -> ${body}`)
      // Native markdown paints its text inside gpui and getPaintedText() is
      // empty on Linux, so the text is checked in pixels: glyphs in the body box.
      const shot = path.join(seeded.stateDir, 'thought.png')
      await grab(shot)
      const bodyBox = lowest(await app.getByTestId('chat-transcript-list').element(), (node) => node.testId === 'thought-group-body')
      const inked = bodyBox ? inkedPixels(shot, bodyBox) : 0
      assert('the thought body paints its text', inked > 300, `glyph pixels in body box=${inked}`)
    }
  )
} finally {
  await seeded.stop()
  console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }))
}
