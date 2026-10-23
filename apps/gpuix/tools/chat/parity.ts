/**
 * `bun tools/chat/parity.ts [--port 8191] [--out parity-out/chat]`
 *
 * Seeds one scripted chat on a throwaway server, shoots the DOM web client on
 * that chat (Playwright chromium, 1280x800, dark) at the bottom, the middle
 * and the top of the transcript, then the GPUIX transcript scene at the same
 * three positions. The scene puts the transcript in the box the web gives its
 * viewport, and each position puts the same row at the same offset as the web
 * shot did, so the two crops show the same content. Prints the ROI diff of
 * each pair and writes `summary.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import { APP_DIR } from '../../build'
import { diffPngs } from '../parity/diff'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import type { SceneCommand } from './scene/contract'
import { buildScene } from './scene/build'
import { seedChat } from './seed'
import { openWebChat, TRANSCRIPT_SELECTOR } from './web'

const WIDTH = 1280
const HEIGHT = 800
const SETTLE_MS = 1200

type Box = { x: number; y: number; width: number; height: number }
type Position = 'bottom' | 'middle' | 'top'
type Anchor = { scroll: 'bottom' } | { scroll: 'row'; index: number; offset: number }

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '8191' },
    out: { type: 'string', default: path.join(APP_DIR, 'parity-out/chat') }
  }
})
const OUT = path.resolve(values.out as string)

function cropPng(src: string, box: Box, out: string): void {
  const img = PNG.sync.read(readFileSync(src))
  const dst = new PNG({ width: box.width, height: box.height })
  PNG.bitblt(img, dst, box.x, box.y, box.width, box.height, 0, 0)
  writeFileSync(out, PNG.sync.write(dst))
}

await mkdir(OUT, { recursive: true })
const entry = await buildScene()
const seeded = await seedChat({ port: Number(values.port) })
const { chat } = seeded
const anchors = new Map<Position, Anchor>()
let roi: Box | null = null
try {
  const web = await openWebChat(chat, { width: WIDTH, height: HEIGHT })
  try {
    const { page } = web
    const viewport = page.locator(TRANSCRIPT_SELECTOR).first()
    await page.waitForTimeout(2500)
    const raw = await viewport.boundingBox()
    if (!raw) throw new Error('web transcript viewport has no box')
    roi = { x: Math.round(raw.x), y: Math.round(raw.y), width: Math.round(raw.width), height: Math.round(raw.height) }
    const shots: Array<[Position, (el: HTMLElement) => void]> = [
      ['bottom', () => {}],
      ['middle', (el) => el.scrollTo({ top: Math.round((el.scrollHeight - el.clientHeight) / 2) })],
      ['top', (el) => el.scrollTo({ top: 0 })]
    ]
    for (const [position, scroll] of shots) {
      await viewport.evaluate(scroll)
      await page.waitForTimeout(SETTLE_MS)
      await mkdir(path.join(OUT, position), { recursive: true })
      await page.screenshot({ path: path.join(OUT, position, 'web.png') })
      // The row under the viewport's top edge and how far into it the edge sits.
      const anchor = await viewport.evaluate((el): Anchor => {
        const top = el.getBoundingClientRect().top
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distance <= 1) return { scroll: 'bottom' }
        const rows = [...el.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]')]
        for (const row of rows) {
          const rect = row.getBoundingClientRect()
          if (rect.bottom > top) {
            const index = Number(row.dataset.index ?? rows.indexOf(row))
            // Row 0 sits under the viewport's py-4; the GPUIX row carries that padding itself.
            return { scroll: 'row', index, offset: top - rect.top + (index === 0 ? 16 : 0) }
          }
        }
        return { scroll: 'bottom' }
      })
      anchors.set(position, anchor)
      console.log(`[chat-parity] web ${position} ${JSON.stringify(anchor)}`)
    }
  } finally {
    await web.close()
  }

  const box = roi
  const control = path.join(OUT, 'control.json')
  Object.assign(process.env, {
    CHAT_SESSION: chat.sessionId,
    CHAT_DEVICE: chat.deviceId,
    CHAT_BOX: `${box.x},${box.y},${box.width},${box.height}`,
    CHAT_CONTROL: control
  })
  writeFileSync(control, JSON.stringify({ seq: 0, scroll: 'bottom' }))
  await withGpuix(
    {
      server: { baseUrl: chat.baseUrl, token: chat.token, stateDir: seeded.stateDir, stop: async () => {} },
      entry,
      width: WIDTH,
      height: HEIGHT,
      clientStateDir: path.join(seeded.stateDir, 'gpuix-client')
    },
    async ({ app, grab }) => {
      await app.getByTestId('chat-scene-ready').waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await Bun.sleep(2500)
      let seq = 1
      for (const position of ['bottom', 'middle', 'top'] as Position[]) {
        const anchor = anchors.get(position) ?? { scroll: 'bottom' }
        const command: SceneCommand = { seq: seq++, ...anchor }
        writeFileSync(control, JSON.stringify(command))
        await Bun.sleep(SETTLE_MS)
        await grab(path.join(OUT, position, 'gpuix.png'))
      }
    }
  )
} finally {
  await seeded.stop()
}

const summary: Record<string, unknown>[] = []
for (const position of ['bottom', 'middle', 'top'] as Position[]) {
  const dir = path.join(OUT, position)
  if (!roi) break
  cropPng(path.join(dir, 'web.png'), roi, path.join(dir, 'web-roi.png'))
  cropPng(path.join(dir, 'gpuix.png'), roi, path.join(dir, 'gpuix-roi.png'))
  const diff = diffPngs(path.join(dir, 'web-roi.png'), path.join(dir, 'gpuix-roi.png'), path.join(dir, 'diff-roi.png'))
  const row = {
    position,
    roi,
    anchor: anchors.get(position),
    roiExact: Number(diff.exact.percent.toFixed(2)),
    roiPerceptual: Number(diff.perceptual.percent.toFixed(2)),
    dir
  }
  summary.push(row)
  console.log(JSON.stringify(row))
}
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
await rm(path.join(OUT, 'control.json'), { force: true })
