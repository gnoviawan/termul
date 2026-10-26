/**
 * Shoot the ui gallery in Chromium (real Radix components, index.css) and in
 * GPUIX (apps/gpuix/src/ui) for each theme and scene, at 1280x800 with
 * reduced motion, and print the exact and perceptual mismatch per state.
 *
 *   bun tools/ui/gallery/run.ts [--out DIR] [--theme ID]... [--scene ID]...
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { APP_DIR, REPO_DIR } from '../../../build'
import { PERCEPTUAL_THRESHOLD } from '../../parity/diff'
import type { TestServer } from '../../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../../parity/shoot-gpuix'
import { WEB_REFERENCE_ARGS } from '../../shared/chromium'
import { buildGpuixGallery, buildWebGallery } from './build'
import {
  GALLERY_HEIGHT,
  GALLERY_WIDTH,
  type Rect,
  SCENES,
  type SceneId,
  STATE_REGIONS
} from './layout'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-k1/gallery' },
    theme: { type: 'string', multiple: true, default: ['termul', 'termul-light'] },
    scene: { type: 'string', multiple: true, default: [...SCENES] }
  }
})
const outDir = values.out
const scenes = values.scene as SceneId[]
mkdirSync(outDir, { recursive: true })

const NO_SERVER: TestServer = {
  baseUrl: 'http://127.0.0.1:9',
  token: '',
  stateDir: outDir,
  stop: async () => {}
}

function crop(png: PNG, r: Rect): PNG {
  const out = new PNG({ width: r.width, height: r.height })
  PNG.bitblt(png, out, r.x, r.y, r.width, r.height, 0, 0)
  return out
}

function compare(a: PNG, b: PNG, diffPath: string) {
  const diff = new PNG({ width: a.width, height: a.height })
  const perceptual = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: PERCEPTUAL_THRESHOLD
  })
  writeFileSync(diffPath, PNG.sync.write(diff))
  let exact = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      exact++
  }
  const total = a.width * a.height
  return { total, exact, perceptual }
}

// Inside apps/gpuix/dist, so fonts.ts finds ../../assets/fonts from the bundle.
const gpuixEntry = await buildGpuixGallery(path.join(APP_DIR, 'dist/gallery'))
const webDir = await buildWebGallery(path.join(outDir, 'web-dist'))

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html'
    const file = Bun.file(path.join(webDir, rel))
    return file.size > 0 ? new Response(file) : new Response('not found', { status: 404 })
  }
})

const { chromium } = await import(path.join(REPO_DIR, 'node_modules/playwright/index.mjs'))
const browser = await chromium.launch({ args: WEB_REFERENCE_ARGS })
const rows: string[] = []
try {
  for (const theme of values.theme) {
    for (const scene of scenes) {
      const base = path.join(outDir, `${theme}-${scene}`)
      const webPng = `${base}-web.png`
      const gpuixPng = `${base}-gpuix.png`
      const page = await browser.newPage({
        viewport: { width: GALLERY_WIDTH, height: GALLERY_HEIGHT },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce'
      })
      await page.goto(`http://127.0.0.1:${server.port}/?scene=${scene}&theme=${theme}`)
      await page.waitForSelector('body[data-gallery-ready]')
      await page.evaluate(() => document.fonts.ready)
      await page.mouse.move(GALLERY_WIDTH - 1, GALLERY_HEIGHT - 1)
      await page.waitForTimeout(300)
      await page.screenshot({ path: webPng })
      await page.close()

      process.env.GALLERY_SCENE = scene
      process.env.GALLERY_THEME = theme
      process.env.TERMUL_GPUIX_REDUCED_MOTION = '1'
      await withGpuix(
        {
          server: NO_SERVER,
          entry: gpuixEntry,
          width: GALLERY_WIDTH,
          height: GALLERY_HEIGHT,
          clientStateDir: path.join(outDir, 'client-state')
        },
        async ({ app, grab }) => {
          await app.getByTestId('gallery-ready').waitFor({ timeoutMs: READY_TIMEOUT_MS })
          await Bun.sleep(300)
          await grab(gpuixPng)
        }
      )

      const web = PNG.sync.read(readFileSync(webPng))
      const gpuix = PNG.sync.read(readFileSync(gpuixPng))
      const full = compare(web, gpuix, `${base}-diff.png`)
      const pct = (n: number, total: number) => `${((n / total) * 100).toFixed(2)}%`
      rows.push(
        `${theme}\t${scene}\t(full frame)\t${full.exact}\t${pct(full.exact, full.total)}\t${full.perceptual}\t${pct(full.perceptual, full.total)}`
      )
      for (const [state, rect] of Object.entries(STATE_REGIONS[scene])) {
        const r = compare(crop(web, rect), crop(gpuix, rect), `${base}-${state}-diff.png`)
        writeFileSync(`${base}-${state}-web.png`, PNG.sync.write(crop(web, rect)))
        writeFileSync(`${base}-${state}-gpuix.png`, PNG.sync.write(crop(gpuix, rect)))
        rows.push(
          `${theme}\t${scene}\t${state}\t${r.exact}\t${pct(r.exact, r.total)}\t${r.perceptual}\t${pct(r.perceptual, r.total)}`
        )
      }
      console.error(`shot ${theme}/${scene}: ${webPng} ${gpuixPng}`)
    }
  }
} finally {
  await browser.close()
  server.stop(true)
}
const table = ['theme\tscene\tstate\texact px\texact %\tperceptual px\tperceptual %', ...rows].join(
  '\n'
)
writeFileSync(path.join(outDir, 'results.tsv'), `${table}\n`)
console.log(table)
