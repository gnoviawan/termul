/**
 * `bun tools/compat/parity.ts [fixture...] [--port N] [--skip-web-build]`
 *
 * Seeds a throwaway termul-server, shoots each compat fixture in chromium
 * (the web fixture build, real Tailwind CSS) and in GPUIX (the compat bundle
 * under Xvfb + lavapipe), and diffs the target's own box (ROI). Output goes
 * to `parity-out/compat/<fixture>/`, a summary to `parity-out/compat/summary.json`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { APP_DIR, REPO_DIR } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { diffPngs } from '../parity/diff'
import { addProject, startTestServer, type TestServer } from '../parity/server'
import { grabFrame, LAVAPIPE_ICD, SCREEN_MARGIN, startXvfb, windowOrigin } from '../parity/shoot-gpuix'
import { buildFixtures } from './build-fixtures'
import { FIXTURE_NAMES } from './fixtures/names'

const WEB_DIST = '/tmp/gpuix-c1/web-dist'
const STATE = '/tmp/gpuix-c1/parity-state'
const OUT = path.join(APP_DIR, 'parity-out/compat')

/** The target's own box. Full-frame numbers flatter a mostly empty frame. */
const ROI_SELECTOR: Record<string, string> = {
  statusbar: '[data-status-bar]',
  sidebar: '[data-testid="shell-rail"]',
  chat: '[data-testid="fixture-ready"]',
  dialog: '[role="alertdialog"]'
}

type Box = { x: number; y: number; width: number; height: number }

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '8196' },
    'skip-web-build': { type: 'boolean', default: false },
    settle: { type: 'string', default: '9000' }
  }
})
const fixtures = positionals.length ? positionals : [...FIXTURE_NAMES]

function cropPng(src: string, box: Box, out: string): void {
  const img = PNG.sync.read(readFileSync(src))
  const dst = new PNG({ width: box.width, height: box.height })
  PNG.bitblt(img, dst, box.x, box.y, box.width, box.height, 0, 0)
  writeFileSync(out, PNG.sync.write(dst))
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' })
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(p.stderr).text()}`)
}

async function seed(server: TestServer): Promise<void> {
  const root = path.join(server.stateDir, 'projects')
  const alpha = path.join(root, 'alpha')
  await mkdir(alpha, { recursive: true })
  const id = ['-c', 'user.email=c1@example.com', '-c', 'user.name=c1']
  await git(alpha, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(alpha, 'README.md'), '# alpha\n')
  writeFileSync(path.join(alpha, 'app.ts'), 'export const a = 1\n')
  await git(alpha, ...id, 'add', '.')
  await git(alpha, ...id, 'commit', '-qm', 'init')
  writeFileSync(path.join(alpha, 'app.ts'), 'export const a = 2\n')
  writeFileSync(path.join(alpha, 'staged.ts'), 'export const s = 1\n')
  await git(alpha, 'add', 'staged.ts')
  writeFileSync(path.join(alpha, 'notes.txt'), 'untracked\n')
  await addProject(server, { id: 'x1-alpha', name: 'alpha', path: alpha, color: 'blue' })
  for (const [pid, name, color] of [
    ['x1-beta', 'beta', 'green'],
    ['x1-gamma', 'gamma service', 'purple']
  ]) {
    await addProject(server, { id: pid, name, path: path.join(root, name.replace(' ', '-')), color })
  }
}

async function shootWeb(server: TestServer, fixture: string, outPath: string) {
  const browser = await chromium.launch({
    args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks']
  })
  try {
    const context = await browser.newContext({
      viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    })
    await context.route(`${server.baseUrl}/**`, async (route) => {
      const url = new URL(route.request().url())
      const file = path.join(WEB_DIST, url.pathname === '/' ? 'index.html' : url.pathname)
      if (route.request().method() === 'GET' && file.startsWith(WEB_DIST) && existsSync(file)) {
        await route.fulfill({ path: file })
        return
      }
      await route.continue()
    })
    await context.addInitScript(
      ({ token }) => {
        localStorage.setItem('termul.webAuthToken', token)
        localStorage.setItem('termul.deviceId', 'c1-web')
      },
      { token: server.token }
    )
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${server.baseUrl}/?fixture=${fixture}`)
    await page.getByTestId('fixture-ready').first().waitFor({ state: 'attached', timeout: 20_000 })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(800)
    await page.screenshot({ path: outPath })
    const raw = await page.locator(ROI_SELECTOR[fixture]).first().boundingBox()
    const roi = raw
      ? {
          x: Math.max(0, Math.floor(raw.x)),
          y: Math.max(0, Math.floor(raw.y)),
          width: Math.min(WINDOW_WIDTH - Math.floor(raw.x), Math.ceil(raw.width)),
          height: Math.min(WINDOW_HEIGHT - Math.floor(raw.y), Math.ceil(raw.height))
        }
      : null
    return { errors, roi }
  } finally {
    await browser.close()
  }
}

/** The bundle as a plain child, so React errors and compat warnings land in a log. */
async function shootGpuix(server: TestServer, entry: string, fixture: string, outPath: string, dir: string) {
  const xvfb = await startXvfb(WINDOW_WIDTH + SCREEN_MARGIN, WINDOW_HEIGHT + SCREEN_MARGIN)
  try {
    const app = Bun.spawn(['bun', entry], {
      cwd: path.dirname(entry),
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        VK_ICD_FILENAMES: LAVAPIPE_ICD,
        GPUIX_BACKGROUND: '1',
        GPUIX_REDUCED_MOTION: '1',
        TERMUL_SERVER_URL: server.baseUrl,
        TERMUL_SERVER_TOKEN: server.token,
        TERMUL_GPUIX_STATE_DIR: path.join(STATE, 'client', fixture),
        COMPAT_FIXTURE: fixture,
        COMPAT_REPORT: path.join(dir, 'compat-report.json'),
        COMPAT_VERBOSE: '1',
        COMPAT_DUMP: path.join(dir, 'tree.json')
      },
      stdout: Bun.file(path.join(dir, 'gpuix.log')),
      stderr: Bun.file(path.join(dir, 'gpuix.err.log'))
    })
    await Bun.sleep(Number(values.settle))
    if (app.exitCode !== null) return `gpuix exited with ${app.exitCode}`
    await grabFrame(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT, outPath, await windowOrigin(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT))
    app.kill('SIGTERM')
    await Promise.race([app.exited, Bun.sleep(3000)])
    if (app.exitCode === null) app.kill('SIGKILL')
    return null
  } finally {
    xvfb.stop()
  }
}

await mkdir(OUT, { recursive: true })
if (!values['skip-web-build']) {
  const vite = Bun.spawn(['bunx', '--bun', 'vite', 'build', '--config', 'apps/gpuix/tools/compat/web/vite.config.ts'], {
    cwd: REPO_DIR,
    stdout: 'ignore',
    stderr: 'pipe'
  })
  if ((await vite.exited) !== 0) throw new Error(`web fixture build failed: ${await new Response(vite.stderr).text()}`)
}
const entry = await buildFixtures()

const port = Number(values.port)
if (await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false)) {
  throw new Error(`port ${port} already serves something; pick another with --port`)
}
const server = await startTestServer({ port, token: 'c1-token', stateDir: path.join(STATE, 'server') })
const summary: Record<string, unknown>[] = []
try {
  await seed(server)
  for (const fixture of fixtures) {
    const dir = path.join(OUT, fixture)
    await mkdir(dir, { recursive: true })
    const webPng = path.join(dir, 'web.png')
    const gpuixPng = path.join(dir, 'gpuix.png')
    const web = await shootWeb(server, fixture, webPng)
    const gpuixError = await shootGpuix(server, entry, fixture, gpuixPng, dir)
    const full = existsSync(gpuixPng) ? diffPngs(webPng, gpuixPng, path.join(dir, 'diff.png')) : null
    let roi: ReturnType<typeof diffPngs> | null = null
    if (full && web.roi) {
      cropPng(webPng, web.roi, path.join(dir, 'web-roi.png'))
      cropPng(gpuixPng, web.roi, path.join(dir, 'gpuix-roi.png'))
      roi = diffPngs(path.join(dir, 'web-roi.png'), path.join(dir, 'gpuix-roi.png'), path.join(dir, 'diff-roi.png'))
    }
    const row = {
      fixture,
      webErrors: web.errors.slice(0, 5),
      gpuixError,
      exact: full?.exact.percent.toFixed(2),
      perceptual: full?.perceptual.percent.toFixed(2),
      roi: web.roi,
      roiExact: roi?.exact.percent.toFixed(2),
      roiPerceptual: roi?.perceptual.percent.toFixed(2),
      dir
    }
    summary.push(row)
    console.log(JSON.stringify(row))
  }
} finally {
  await server.stop()
  await rm(STATE, { recursive: true, force: true })
}
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
