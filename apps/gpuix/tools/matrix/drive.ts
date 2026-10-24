/**
 * One executor per client for the matrix's actions and checks.
 *
 * The web client runs a surface first and records where each element it
 * acted on was painted. GPUIX then resolves the same target natively (test id
 * or text, picking the match nearest that point) and falls back to the web
 * point for targets only the DOM can name (accessible labels, CSS). The log
 * says which way every GPUIX action went.
 */

import path from 'node:path'
import type { Locator, Page } from 'playwright'
import type { withGpuix } from '../parity/shoot-gpuix'
import type { Action, ActionLog, Check, CheckLog, Target } from './types'

export type GpuixApp = Parameters<Parameters<typeof withGpuix>[1]>[0]['app']
export interface Point {
  x: number
  y: number
}

const PRESENT_TIMEOUT_MS = 15_000
/** GPUIX runs after the web client on the same server, so its data is already there. */
const GPUIX_PRESENT_TIMEOUT_MS = 8_000
const GONE_TIMEOUT_MS = 6_000
const SETTLE_AFTER_ACTION_MS = 250

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

export function describe(action: Action): string {
  const target = (t: Target) =>
    'testId' in t
      ? `#${t.testId}`
      : 'text' in t
        ? `"${t.text}"`
        : 'label' in t
          ? `[${t.label}]`
          : t.css
  switch (action.do) {
    case 'click':
      return `${action.button === 'right' ? 'right-click' : action.modifiers ? `${action.modifiers}-click` : 'click'} ${target(action.target)}`
    case 'dblclick':
    case 'hover':
      return `${action.do} ${target(action.target)}`
    case 'press':
      return `press ${action.keys}`
    case 'type':
      return `type "${action.text}"`
    case 'wheel':
      return `wheel ${action.deltaY} over ${target(action.target)}`
    case 'drag':
      return `drag ${target(action.from)} -> ${target(action.to)}`
    case 'wait':
      return `wait ${action.ms} ms`
  }
}

/** `ctrl-shift-k` -> `Control+Shift+k`, `escape` -> `Escape`. */
export function playwrightKeys(keys: string): string[] {
  const named: Record<string, string> = {
    escape: 'Escape',
    enter: 'Enter',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    space: ' ',
    home: 'Home',
    end: 'End',
    f2: 'F2'
  }
  const mods: Record<string, string> = { ctrl: 'Control', alt: 'Alt', shift: 'Shift', cmd: 'Meta' }
  return keys.split(' ').map((stroke) => {
    const parts = stroke.match(/^((?:(?:ctrl|alt|shift|cmd)-)*)(.+)$/)
    const prefix = (parts?.[1] ?? '').split('-').filter(Boolean)
    const key = parts?.[2] ?? stroke
    return [...prefix.map((m) => mods[m]), named[key] ?? key].join('+')
  })
}

export function gpuiKeystrokes(text: string): string {
  return [...text].map((ch) => (ch === ' ' ? 'space' : ch === '\n' ? 'enter' : ch)).join(' ')
}

async function poll(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await Bun.sleep(150)
  }
}

export interface Driver {
  act(step: string, index: number, action: Action): Promise<ActionLog>
  check(step: string, check: Check): Promise<CheckLog>
}

function webLocator(page: Page, target: Target): Locator {
  if ('testId' in target) return page.getByTestId(target.testId).filter({ visible: true }).first()
  if ('text' in target)
    return page
      .getByText(target.text, { exact: target.exact ?? true })
      .filter({ visible: true })
      .first()
  if ('label' in target) {
    return page
      .getByRole(target.role ?? 'button', { name: target.label, exact: true })
      .filter({ visible: true })
      .first()
  }
  return page.locator(target.css).filter({ visible: true }).first()
}

export function webDriver(page: Page, points: Map<string, Point>): Driver {
  /** Where the web client acts on `target`: its centre, or the `at` / `frac` spot inside it. */
  const pointOf = async (key: string, target: Target): Promise<Point> => {
    const locator = webLocator(page, target)
    await locator.waitFor({ state: 'visible', timeout: PRESENT_TIMEOUT_MS })
    const box = await locator.boundingBox()
    if (!box) throw new Error('no box')
    const spot: { at?: Point; frac?: Point } = 'css' in target ? target : {}
    const point = spot.at
      ? { x: box.x + spot.at.x, y: box.y + spot.at.y }
      : spot.frac
        ? { x: box.x + box.width * spot.frac.x, y: box.y + box.height * spot.frac.y }
        : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    points.set(key, point)
    return point
  }
  return {
    async act(step, index, action) {
      const key = `${step}/${index}`
      const log: ActionLog = { step, action: describe(action), via: 'dom', ok: true }
      try {
        switch (action.do) {
          case 'click': {
            const target = action.target
            if ('css' in target && (target.at || target.frac)) {
              const point = await pointOf(key, target)
              if (action.modifiers) await page.keyboard.down('Control')
              await page.mouse.click(point.x, point.y, { button: action.button })
              if (action.modifiers) await page.keyboard.up('Control')
              break
            }
            const locator = webLocator(page, target)
            await pointOf(key, target)
            await locator.click({
              button: action.button,
              modifiers: action.modifiers ? ['ControlOrMeta'] : undefined
            })
            break
          }
          case 'dblclick': {
            await pointOf(key, action.target)
            await webLocator(page, action.target).dblclick()
            break
          }
          case 'hover': {
            await pointOf(key, action.target)
            await webLocator(page, action.target).hover()
            break
          }
          case 'wheel': {
            const point = await pointOf(key, action.target)
            await page.mouse.move(point.x, point.y)
            await page.mouse.wheel(0, action.deltaY)
            break
          }
          case 'drag': {
            // A drop onto a pane spot uses mouse steps rather than dragTo: HTML5 drags
            // (tabs, explorer rows) reveal the pane's drop zones only once they start.
            const from = await pointOf(key, action.from)
            const to = await pointOf(`${key}/to`, action.to)
            if (!('css' in action.to && action.to.frac)) {
              await webLocator(page, action.from).dragTo(webLocator(page, action.to))
              break
            }
            await page.mouse.move(from.x, from.y)
            await page.mouse.down()
            await page.mouse.move(from.x + 12, from.y + 4, { steps: 4 })
            await page.mouse.move(to.x, to.y, { steps: 16 })
            await page.waitForTimeout(200)
            await page.mouse.up()
            break
          }
          case 'press':
            log.via = 'key'
            for (const stroke of playwrightKeys(action.keys)) await page.keyboard.press(stroke)
            break
          case 'type':
            log.via = 'key'
            await page.keyboard.type(action.text)
            break
          case 'wait':
            log.via = 'none'
            await page.waitForTimeout(action.ms)
            break
        }
        await page.waitForTimeout(SETTLE_AFTER_ACTION_MS)
      } catch (error) {
        log.ok = false
        log.error = error instanceof Error ? error.message.split('\n')[0] : String(error)
      }
      return log
    },
    async check(step, check) {
      if (check.order) {
        const order = check.order
        const inOrder = async () =>
          ordered(
            await page.evaluate(
              (within) =>
                (document.querySelector(`[data-testid="${within}"]`) as HTMLElement | null)
                  ?.innerText ?? '',
              check.within
            ),
            order
          )
        return {
          step,
          text: order.join(' < '),
          expect: 'present',
          pass: await poll(inOrder, PRESENT_TIMEOUT_MS)
        }
      }
      const want = normalize(check.text)
      const painted = () =>
        page.evaluate(
          ({ needle, within }) => {
            const root = within
              ? document.querySelector(`[data-testid="${within}"]`)
              : document.body
            return (
              (root as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').includes(needle) ?? false
            )
          },
          { needle: want, within: check.within }
        )
      const pass = check.gone
        ? await poll(async () => !(await painted()), GONE_TIMEOUT_MS)
        : await poll(painted, PRESENT_TIMEOUT_MS)
      return { step, text: check.text, expect: check.gone ? 'gone' : 'present', pass }
    }
  }
}

interface Node {
  text?: string
  testId?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}

/** Every text in `texts` occurs in `haystack`, each after the previous one. */
function ordered(haystack: string, texts: string[]): boolean {
  let from = 0
  for (const text of texts) {
    const at = normalize(haystack).indexOf(normalize(text), from)
    if (at < 0) return false
    from = at + text.length
  }
  return true
}

function subtreeText(node: Node): string {
  return [node.text ?? '', ...(node.children ?? []).map(subtreeText)].join(' ')
}

function nearest(nodes: Node[], to: Point | undefined): Point | null {
  const painted = nodes.filter(
    (node) => node.bounds && node.bounds.width > 0 && node.bounds.height > 0
  )
  if (painted.length === 0) return null
  const centres = painted.map((node) => {
    const b = node.bounds as NonNullable<Node['bounds']>
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  if (!to) return centres[0]
  return centres.reduce((best, c) =>
    Math.hypot(c.x - to.x, c.y - to.y) < Math.hypot(best.x - to.x, best.y - to.y) ? c : best
  )
}

/** Real X input for clicks: the Xvfb display and the window's origin on it. */
export interface X11Input {
  display: string
  origin: Point
}

const X11_CLICK = path.join(import.meta.dir, 'x11-click.py')

async function x11Click(x11: X11Input, point: Point, button: 1 | 3): Promise<void> {
  const proc = Bun.spawn(
    [
      'uv',
      'run',
      '--quiet',
      '--with',
      'python-xlib==0.33',
      'python',
      '-I',
      X11_CLICK,
      String(x11.origin.x + point.x),
      String(x11.origin.y + point.y),
      String(button)
    ],
    { env: { ...process.env, DISPLAY: x11.display }, stdout: 'ignore', stderr: 'pipe' }
  )
  if ((await proc.exited) !== 0)
    throw new Error(`x11-click failed: ${await new Response(proc.stderr).text()}`)
}

export function gpuixDriver(app: GpuixApp, points: Map<string, Point>, x11?: X11Input): Driver {
  const resolve = async (
    target: Target,
    key: string
  ): Promise<{ point: Point; via: ActionLog['via'] }> => {
    const web = points.get(key)
    let native: Point | null = null
    let via: ActionLog['via'] = 'web-point'
    if ('testId' in target) {
      native = await poll(
        async () => (await app.getByTestId(target.testId).count()) > 0,
        2500
      ).then(async () => nearest(await app.getByTestId(target.testId).all(), web))
      via = 'testid'
    } else if ('text' in target) {
      const exact = target.exact ?? true
      await poll(async () => (await app.getByText(target.text).count()) > 0, 2500)
      const nodes = (await app.getByText(target.text).all()).filter((node) =>
        exact ? normalize(node.text ?? '') === normalize(target.text) : true
      )
      native = nearest(nodes, web)
      via = 'text'
    }
    if (native) return { point: native, via }
    if (web) return { point: web, via: 'web-point' }
    throw new Error('no native match and no web point')
  }
  return {
    async act(step, index, action) {
      const key = `${step}/${index}`
      const log: ActionLog = { step, action: describe(action), via: 'none', ok: true }
      try {
        switch (action.do) {
          case 'click': {
            const { point, via } = await resolve(action.target, key)
            log.via = via
            if (x11 && !action.modifiers)
              await x11Click(x11, point, action.button === 'right' ? 3 : 1)
            else {
              await app.call('click', {
                ...point,
                button: action.button === 'right' ? 2 : 0,
                ...(action.modifiers && { modifiers: action.modifiers })
              })
            }
            break
          }
          case 'dblclick': {
            const { point, via } = await resolve(action.target, key)
            log.via = via
            await app.call('click', { ...point })
            await app.call('click', { ...point })
            break
          }
          case 'hover': {
            const { point, via } = await resolve(action.target, key)
            log.via = via
            await app.mouse.move(point)
            break
          }
          case 'wheel': {
            const { point, via } = await resolve(action.target, key)
            log.via = via
            await app.mouse.wheel(point, 0, action.deltaY)
            break
          }
          case 'drag': {
            const from = await resolve(action.from, key)
            const to = await resolve(action.to, `${key}/to`)
            log.via = from.via
            await app.mouse.drag(from.point, to.point, { steps: 12 })
            break
          }
          case 'press':
            log.via = 'key'
            await app.call('keystrokes', { keys: action.keys })
            break
          case 'type':
            log.via = 'key'
            await app.call('keystrokes', { keys: gpuiKeystrokes(action.text) })
            break
          case 'wait':
            await Bun.sleep(action.ms)
            break
        }
        await Bun.sleep(SETTLE_AFTER_ACTION_MS)
      } catch (error) {
        log.ok = false
        log.error = error instanceof Error ? error.message.split('\n')[0] : String(error)
      }
      return log
    },
    async check(step, check) {
      if (check.order) {
        const order = check.order
        const inOrder = async () => {
          const scope = app.getByTestId(check.within)
          return (await scope.count()) > 0 && ordered(subtreeText(await scope.element()), order)
        }
        return {
          step,
          text: order.join(' < '),
          expect: 'present',
          pass: await poll(inOrder, GPUIX_PRESENT_TIMEOUT_MS)
        }
      }
      const want = normalize(check.text)
      const painted = async () => {
        if (check.within) {
          const scope = app.getByTestId(check.within)
          if ((await scope.count()) === 0) return false
          if ((await scope.getByText(check.text).count()) > 0) return true
          return normalize(subtreeText(await scope.element())).includes(want)
        }
        if ((await app.getByText(check.text).count()) > 0) return true
        const { text } = await app.call('getAllText', {})
        return normalize(text.join(' ')).includes(want)
      }
      const pass = check.gone
        ? await poll(async () => !(await painted()), GONE_TIMEOUT_MS)
        : await poll(painted, GPUIX_PRESENT_TIMEOUT_MS)
      return { step, text: check.text, expect: check.gone ? 'gone' : 'present', pass }
    }
  }
}
