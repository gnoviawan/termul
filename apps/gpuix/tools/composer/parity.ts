/**
 * `bun tools/composer/parity.ts`: the chat composer on the web client and on
 * GPUIX, against one seeded server, in three states: empty, the @-mention menu
 * open on "app", and a draft with two file pills. Each pair is diffed inside
 * the web composer's box (ROI), plus the menu's box when it is open.
 * Needs this worktree's `dist-web` (`bun run build:web` at the repo root).
 * Output: $GPUIX_STATE_ROOT (default /tmp/gpuix-o3)/parity/<state>/{web,gpuix,web-roi,gpuix-roi,diff-roi}.png
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { PNG } from 'pngjs'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { diffPngs } from '../parity/diff'
import { DIST_WEB } from '../parity/shoot-web'
import { WEB_REFERENCE_ARGS } from '../shared/chromium'
import { type GpuixApp, withScene } from './scene/session'
import { STATE_ROOT, seedComposerServer } from './seed'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const OUT = path.join(STATE_ROOT, 'parity')
const STATES = ['empty', 'mention-menu', 'two-pills'] as const
type State = (typeof STATES)[number]

function union(a: Box, b: Box | null): Box {
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  }
}

function cropPng(src: string, box: Box, out: string): void {
  const img = PNG.sync.read(readFileSync(src))
  const dst = new PNG({ width: box.width, height: box.height })
  PNG.bitblt(img, dst, box.x, box.y, box.width, box.height, 0, 0)
  writeFileSync(out, PNG.sync.write(dst))
}

function rounded(b: { x: number; y: number; width: number; height: number }): Box {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
}

async function webBoxes(
  page: Page
): Promise<{ root: Box; composer: Box; menu: Box | null; editor: Box }> {
  const raw = await page.evaluate(() => {
    const composer = document.querySelector('[data-chat-composer]')
    const root = composer?.closest('.max-w-3xl')?.parentElement
    const menu = document.querySelector('[role="listbox"]')
    const editor = document.querySelector('[data-composer-editor="true"]')
    const box = (el: Element | null | undefined) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return { root: box(root), composer: box(composer), menu: box(menu), editor: box(editor) }
  })
  if (!raw.root || !raw.composer || !raw.editor) throw new Error('web composer not found')
  return {
    root: rounded(raw.root),
    composer: rounded(raw.composer),
    menu: raw.menu ? rounded(raw.menu) : null,
    editor: rounded(raw.editor)
  }
}

async function webPick(page: Page, query: string, option: string): Promise<void> {
  await page.keyboard.type(`@${query}`, { delay: 30 })
  try {
    await page.getByText(option, { exact: true }).first().waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.screenshot({ path: path.join(OUT, 'web-failure.png') })
    throw error
  }
  await page.waitForTimeout(400)
}

async function gpuixKeys(app: GpuixApp, keys: string): Promise<void> {
  await app.call('keystrokes', { keys })
  await Bun.sleep(150)
}

async function gpuixWait(_app: GpuixApp, done: () => boolean): Promise<void> {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > 15_000)
      throw new Error('gpuix: the first prompt never reached the agent')
    await Bun.sleep(100)
  }
}

async function gpuixText(app: GpuixApp, exact: string): Promise<void> {
  const started = Date.now()
  while (!(await app.call('getAllText', {})).text.includes(exact)) {
    if (Date.now() - started > 10_000) throw new Error(`gpuix: "${exact}" never painted`)
    await Bun.sleep(100)
  }
  await Bun.sleep(300)
}

if (!existsSync(path.join(DIST_WEB, 'index.html'))) throw new Error(`build ${DIST_WEB} first`)
const seeded = await seedComposerServer()
const rois = new Map<State, Box>()
const webEditors = new Map<State, Box>()
const gpuixEditors = new Map<State, Box>()
try {
  let rootBox: Box
  const browser = await chromium.launch({
    args: WEB_REFERENCE_ARGS
  })
  try {
    const context = await browser.newContext({
      viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    })
    await context.route(`${seeded.server.baseUrl}/**`, async (route) => {
      const url = new URL(route.request().url())
      const file = path.join(DIST_WEB, url.pathname === '/' ? 'index.html' : url.pathname)
      if (
        route.request().method() === 'GET' &&
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
      { token: seeded.server.token, deviceId: seeded.deviceId }
    )
    const page = await context.newPage()
    // A chat the web client starts and owns: the launcher, one prompt, then the chat composer.
    await page.goto(seeded.server.baseUrl)
    const launcher = page.locator('[data-composer-editor="true"]')
    await launcher.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(2000)
    await launcher.click()
    await page.keyboard.type('hello', { delay: 30 })
    await page.getByText('hello', { exact: true }).waitFor({ timeout: 10_000 })
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
    try {
      await page.locator('[data-chat-composer]').waitFor({ timeout: 30_000 })
      await page.getByText('received', { exact: true }).waitFor({ timeout: 30_000 })
    } catch (error) {
      await page.screenshot({ path: path.join(OUT, 'web-failure.png') })
      throw error
    }
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(1500)
    const shoot = async (state: State) => {
      mkdirSync(path.join(OUT, state), { recursive: true })
      const boxes = await webBoxes(page)
      rois.set(state, union(boxes.composer, state === 'mention-menu' ? boxes.menu : null))
      webEditors.set(state, boxes.editor)
      await page.screenshot({ path: path.join(OUT, state, 'web.png') })
      return boxes
    }
    rootBox = (await shoot('empty')).root
    await page.locator('[data-composer-editor="true"]').click()
    await webPick(page, 'app', 'src/app.ts')
    await shoot('mention-menu')
    await page.keyboard.press('Enter')
    await page.keyboard.type('and ', { delay: 30 })
    await webPick(page, 'api', 'src/api.ts')
    await page.keyboard.press('Enter')
    await page.keyboard.type('review', { delay: 30 })
    await page.waitForTimeout(400)
    await shoot('two-pills')
  } finally {
    await browser.close()
  }

  await withScene(
    seeded,
    { x: rootBox.x, y: rootBox.y, width: rootBox.width },
    async ({ app, grab: grabFrame }) => {
      const grab = async (file: string) => {
        const state = path.basename(path.dirname(file)) as State
        gpuixEditors.set(state, rounded(await app.getByTestId('composer-editor').bounds()))
        await grabFrame(file)
      }
      await app.getByTestId('composer-editor').click()
      await gpuixKeys(app, 'h e l l o enter')
      await gpuixWait(app, () => existsSync(seeded.promptLog))
      await Bun.sleep(1500)
      await grab(path.join(OUT, 'empty', 'gpuix.png'))
      await gpuixKeys(app, '@ a p p')
      await gpuixText(app, 'src/app.ts')
      await grab(path.join(OUT, 'mention-menu', 'gpuix.png'))
      await gpuixKeys(app, 'enter')
      await Bun.sleep(300)
      await gpuixKeys(app, 'a n d space @ a p i')
      await gpuixText(app, 'src/api.ts')
      await gpuixKeys(app, 'enter')
      await Bun.sleep(300)
      await gpuixKeys(app, 'r e v i e w')
      await grab(path.join(OUT, 'two-pills', 'gpuix.png'))
    }
  )

  for (const state of STATES) {
    const dir = path.join(OUT, state)
    const roi = rois.get(state)
    if (!roi) continue
    cropPng(path.join(dir, 'web.png'), roi, path.join(dir, 'web-roi.png'))
    // Aligned on the editor: the chat gutter around the composer is a compat gap of its own (@[400px]: variants).
    const web = webEditors.get(state)
    const native = gpuixEditors.get(state)
    const shift = web && native ? { x: native.x - web.x, y: native.y - web.y } : { x: 0, y: 0 }
    cropPng(
      path.join(dir, 'gpuix.png'),
      { ...roi, x: roi.x + shift.x, y: roi.y + shift.y },
      path.join(dir, 'gpuix-roi.png')
    )
    const d = diffPngs(
      path.join(dir, 'web-roi.png'),
      path.join(dir, 'gpuix-roi.png'),
      path.join(dir, 'diff-roi.png')
    )
    let editorLine = ''
    if (web && native) {
      const size = {
        width: Math.min(web.width, native.width),
        height: Math.min(web.height, native.height)
      }
      cropPng(path.join(dir, 'web.png'), { ...web, ...size }, path.join(dir, 'web-editor.png'))
      cropPng(
        path.join(dir, 'gpuix.png'),
        { ...native, ...size },
        path.join(dir, 'gpuix-editor.png')
      )
      const e = diffPngs(
        path.join(dir, 'web-editor.png'),
        path.join(dir, 'gpuix-editor.png'),
        path.join(dir, 'diff-editor.png')
      )
      editorLine = `  editor ${size.width}x${size.height} exact ${e.exact.percent.toFixed(2)}% perceptual ${e.perceptual.percent.toFixed(2)}%`
    }
    console.log(
      `${state.padEnd(13)} roi ${roi.width}x${roi.height}+${roi.x}+${roi.y} gpuix shift ${shift.x},${shift.y}  exact ${d.exact.percent.toFixed(2)}%  perceptual ${d.perceptual.percent.toFixed(2)}%${editorLine}`
    )
  }
} finally {
  await seeded.stop()
}
