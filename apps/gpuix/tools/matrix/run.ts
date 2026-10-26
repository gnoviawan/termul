/**
 * `bun run parity:matrix [--only id,id] [--area a,b] [--port N] [--out DIR] [--inactive-window] [--report-only]`
 *
 * Seeds one termul-server (see `world.ts`), then for every surface in
 * `surfaces/` runs the web client (Playwright chromium) and the GPUIX client
 * (Xvfb + lavapipe) through the same steps, each from a fresh device on the
 * dashboard. Records every action and check, shoots a frame per step, diffs
 * full frames and the surface's region, and merges the result into
 * `results.json` (a partial run updates only the surfaces it ran). Finally
 * regenerates the tables in `docs/parity-matrix.md`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type Browser, chromium } from 'playwright'
import { APP_DIR, buildClient } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { cropPng, diffPngs, type Rect } from '../parity/diff'
import { READY_TIMEOUT_MS, windowOrigin, withGpuix } from '../parity/shoot-gpuix'
import { DIST_WEB } from '../parity/shoot-web'
import { WEB_REFERENCE_ARGS } from '../shared/chromium'
import { pickPort } from '../shared/seed'
import { activateWindow, type Driver, gpuixDriver, type Point, webDriver } from './drive'
import { writeReport } from './report'
import { SURFACES } from './surfaces'
import { killTerminals } from './terminals'
import type { AutoStatus, Client, ClientRun, StepDiff, Surface, SurfaceResult } from './types'
import { createWorld, prepareDevice, setTheme, TOKEN, type World } from './world'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    only: { type: 'string' },
    area: { type: 'string' },
    port: { type: 'string' },
    out: { type: 'string', default: path.join(APP_DIR, 'parity-out/matrix') },
    state: { type: 'string', default: process.env.GPUIX_STATE_ROOT ?? '/tmp/gpuix-m1' },
    'web-only': { type: 'boolean', default: false },
    /** Send GPUIX clicks as real X input (XTEST) instead of GPUIX automation's simulated events. */
    'x11-input': { type: 'boolean', default: false },
    /** Leave the GPUIX window inactive (no X focus): GPUI then sends no focus or blur events. */
    'inactive-window': { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false }
  }
})

const OUT = path.resolve(values.out as string)
const RESULTS = path.join(OUT, 'results.json')
const SIZE = { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
/** A region whose perceptual mismatch is at or under this counts as visually matching. */
export const PORTED_PERCEPTUAL_PCT = 2
const BOOT_TEXT = 'What should we do in alpha?'

function loadResults(): Record<string, SurfaceResult> {
  return existsSync(RESULTS)
    ? (JSON.parse(readFileSync(RESULTS, 'utf8')) as Record<string, SurfaceResult>)
    : {}
}

function selected(): Surface[] {
  const only = values.only?.split(',').filter(Boolean)
  const areas = values.area?.split(',').filter(Boolean)
  const ids = new Set(SURFACES.map((s) => s.id))
  for (const id of only ?? []) if (!ids.has(id)) throw new Error(`unknown surface ${id}`)
  return SURFACES.filter(
    (s) => (!only || only.includes(s.id)) && (!areas || areas.includes(s.area))
  )
}

const slug = (id: string) => id.replace(/[^a-z0-9-]/gi, '-')

async function runSteps(
  surface: Surface,
  client: Client,
  driver: Driver,
  grab: (file: string) => Promise<void>,
  measure?: () => Promise<Rect | null>
): Promise<{ run: ClientRun; rects: (Rect | null)[] }> {
  const started = performance.now()
  const run: ClientRun = { ok: true, ms: 0, actions: [], checks: [], frames: [] }
  const rects: (Rect | null)[] = []
  for (const step of surface.steps) {
    for (const [i, action] of step.actions.entries()) {
      const log = await driver.act(step.name, i, action)
      run.actions.push(log)
      if (!log.ok) run.ok = false
    }
    for (const check of step.expect) {
      const checkStarted = performance.now()
      const log = {
        ...(await driver.check(step.name, check)),
        ms: Math.round(performance.now() - checkStarted)
      }
      run.checks.push(log)
      if (!log.pass) run.ok = false
    }
    const dir = path.join(OUT, slug(surface.id), step.name)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${client}.png`)
    await grab(file)
    run.frames.push(file)
    rects.push(measure ? await measure() : null)
  }
  run.ms = Math.round(performance.now() - started)
  return { run, rects }
}

async function sweepTerminals(world: World): Promise<void> {
  const killed = await killTerminals(world)
  if (killed > 0) console.error(`[matrix] closed ${killed} terminals an earlier run left open`)
}

function failedRun(error: unknown, started: number): ClientRun {
  return {
    ok: false,
    error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    ms: Math.round(performance.now() - started),
    actions: [],
    checks: [],
    frames: []
  }
}

async function runWeb(
  browser: Browser,
  world: World,
  surface: Surface,
  points: Map<string, Point>
) {
  const deviceId = `m1-${slug(surface.id)}-web`
  await sweepTerminals(world)
  await prepareDevice(world, deviceId)
  await setTheme(world, 'termul', 'dark')
  await surface.prepare?.(world)
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block'
  })
  try {
    await context.route(`${world.server.baseUrl}/**`, async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const file = path.join(DIST_WEB, url.pathname === '/' ? 'index.html' : url.pathname)
      if (
        request.method() === 'GET' &&
        file.startsWith(DIST_WEB) &&
        existsSync(file) &&
        !file.endsWith(path.sep)
      ) {
        await route.fulfill({ path: file })
        return
      }
      await route.continue()
    })
    await context.addInitScript(
      ({ token, deviceId }) => {
        localStorage.setItem('termul.webAuthToken', token)
        localStorage.setItem('termul.deviceId', deviceId)
      },
      { token: TOKEN, deviceId }
    )
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${world.server.baseUrl}/`)
    await page.getByText(BOOT_TEXT).first().waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS })
    const result = await runSteps(
      surface,
      'web',
      webDriver(page, points, world.root),
      async (file) => {
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(400)
        await page.screenshot({ path: file })
      },
      surface.roi
        ? async () => {
            const locator = page
              .locator(surface.roi as string)
              .filter({ visible: true })
              .first()
            return (await locator.count()) > 0 ? locator.boundingBox() : null
          }
        : undefined
    )
    if (errors.length > 0) result.run.error = `page errors: ${errors.slice(0, 3).join(' | ')}`
    return result
  } finally {
    await context.close()
  }
}

async function runGpuix(entry: string, world: World, surface: Surface, points: Map<string, Point>) {
  const deviceId = `m1-${slug(surface.id)}-gpuix`
  await sweepTerminals(world)
  await prepareDevice(world, deviceId)
  await setTheme(world, 'termul', 'dark')
  await surface.prepare?.(world)
  const clientStateDir = path.join(values.state as string, 'clients', slug(surface.id))
  await rm(clientStateDir, { recursive: true, force: true })
  const host = new URL(world.server.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
  mkdirSync(path.join(clientStateDir, 'web-storage'), { recursive: true })
  writeFileSync(
    path.join(clientStateDir, 'web-storage', `${host}.json`),
    JSON.stringify({ 'termul.deviceId': deviceId })
  )
  return withGpuix(
    { server: world.server, entry, clientStateDir, ...SIZE },
    async ({ app, display, grab }) => {
      await app.getByText(BOOT_TEXT).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const origin = await windowOrigin(display, SIZE.width, SIZE.height)
      if (!values['inactive-window']) await activateWindow(display, origin)
      const x11 = values['x11-input'] ? { display, origin } : undefined
      return runSteps(
        surface,
        'gpuix',
        gpuixDriver(app, points, {
          x11,
          display,
          filesDir: world.root,
          activeAt: values['inactive-window'] ? undefined : origin
        }),
        grab
      )
    }
  )
}

function autoStatus(
  surface: Surface,
  web?: ClientRun,
  gpuix?: ClientRun,
  diffs: StepDiff[] = []
): AutoStatus {
  if (surface.pending) return 'pending-unit'
  if (surface.blocked) return 'blocked'
  if (!web?.ok) return 'unverified'
  if (!gpuix?.ok) return 'broken'
  const last = diffs.at(-1)
  const pct = last ? (last.roi?.diff ?? last.full).perceptual.percent : 100
  return pct <= PORTED_PERCEPTUAL_PCT ? 'ported' : 'partial'
}

function diffSurface(
  surface: Surface,
  web: ClientRun,
  gpuix: ClientRun,
  rects: (Rect | null)[]
): StepDiff[] {
  const out: StepDiff[] = []
  for (const [i, step] of surface.steps.entries()) {
    const webPng = web.frames[i]
    const gpuixPng = gpuix.frames[i]
    if (!webPng || !gpuixPng) continue
    const dir = path.dirname(webPng)
    const diffPng = path.join(dir, 'diff.png')
    const entry: StepDiff = { step: step.name, full: diffPngs(webPng, gpuixPng, diffPng), diffPng }
    const rect = rects[i]
    if (rect && rect.width >= 4 && rect.height >= 4) {
      const files = { web: path.join(dir, 'roi-web.png'), gpuix: path.join(dir, 'roi-gpuix.png') }
      cropPng(webPng, rect, files.web)
      cropPng(gpuixPng, rect, files.gpuix)
      entry.roi = {
        rect,
        diff: diffPngs(files.web, files.gpuix, path.join(dir, 'roi-diff.png')),
        ...files
      }
    }
    out.push(entry)
  }
  return out
}

function summarize(result: SurfaceResult): string {
  const failed = (run?: ClientRun) =>
    run
      ? [
          ...run.actions.filter((a) => !a.ok).map((a) => `${a.action}: ${a.error}`),
          ...run.checks.filter((c) => !c.pass).map((c) => `${c.expect} "${c.text}"`),
          ...(run.error ? [run.error] : [])
        ].join('; ')
      : ''
  const last = result.diffs.at(-1)
  const diff = last
    ? `full ${last.full.exact.percent.toFixed(1)}/${last.full.perceptual.percent.toFixed(2)}%` +
      (last.roi
        ? ` roi ${last.roi.diff.exact.percent.toFixed(1)}/${last.roi.diff.perceptual.percent.toFixed(2)}%`
        : '')
    : ''
  return `${result.auto.padEnd(12)} ${result.id.padEnd(34)} ${diff}  web[${failed(result.web)}] gpuix[${failed(result.gpuix)}]`
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const results = loadResults()
  if (values['report-only']) {
    writeReport(results)
    return
  }
  const surfaces = selected()
  const build = await buildClient()
  if (!build.ok) {
    for (const line of build.logs) console.error(line)
    process.exit(1)
  }
  const port = await pickPort(values.port ? Number(values.port) : undefined)
  const root = path.join(values.state as string, 'matrix')
  await rm(root, { recursive: true, force: true })
  console.error(`[matrix] seeding server on ${port} under ${root}`)
  const world = await createWorld({ port, root })
  const browser = await chromium.launch({
    args: WEB_REFERENCE_ARGS
  })
  try {
    for (const surface of surfaces) {
      const result: SurfaceResult = {
        id: surface.id,
        ranAt: new Date().toISOString(),
        auto: 'pending-unit',
        diffs: []
      }
      if (surface.pending || surface.blocked) {
        result.pending = surface.pending
        result.blocked = surface.blocked
      } else {
        const points = new Map<string, Point>()
        let started = performance.now()
        let rects: (Rect | null)[] = []
        try {
          const web = await runWeb(browser, world, surface, points)
          result.web = web.run
          rects = web.rects
        } catch (error) {
          result.web = failedRun(error, started)
        }
        if (!values['web-only']) {
          started = performance.now()
          try {
            result.gpuix = (await runGpuix(build.entry, world, surface, points)).run
          } catch (error) {
            result.gpuix = failedRun(error, started)
          }
          if (result.web && result.gpuix)
            result.diffs = diffSurface(surface, result.web, result.gpuix, rects)
        }
      }
      result.auto = autoStatus(surface, result.web, result.gpuix, result.diffs)
      results[surface.id] = result
      writeFileSync(RESULTS, JSON.stringify(results, null, 2))
      console.log(summarize(result))
    }
  } finally {
    await browser.close()
    world.ws.close()
    await world.server.stop()
    await rm(root, { recursive: true, force: true })
  }
  writeReport(results)
}

await main()
