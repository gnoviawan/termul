/**
 * The DOM members shared components read beyond P0's location/storage/event
 * targets: `document.activeElement` and focus events, the element classes
 * `instanceof` checks name, tree queries, `requestAnimationFrame`,
 * `matchMedia`, the observers and `getComputedStyle`. Element-level behaviour
 * lives in `src/compat/dom-node.ts`; this file only puts it on the globals.
 */

import {
  CompatElement,
  CompatNode,
  compatRenderer,
  nodeOrNull,
  treeIndex,
  nodeFor
} from '../compat/dom-node'
import { domEvent, setFocusSink } from '../compat/events'
import { compatWarn } from '../compat/log'
import { CompatResizeObserver } from '../compat/resize'
import type { Viewport } from './index'

const MEDIA_FEATURES: Readonly<Record<string, string>> = {
  'prefers-color-scheme': 'dark',
  hover: 'hover',
  'any-hover': 'hover',
  pointer: 'fine',
  'any-pointer': 'fine',
  'display-mode': 'standalone',
  'prefers-contrast': 'no-preference'
}

/** A desktop window: size features against the window, input features as mouse and keyboard. */
export function evaluateMediaQuery(query: string, viewport: Viewport, reducedMotion: boolean): boolean {
  return query.split(',').some((part) => {
    const negate = /^\s*not\s/.test(part)
    const holds = [...part.matchAll(/\(([^)]+)\)/g)].every(([, feature]) => {
      const [name, raw] = feature.split(':').map((x) => x.trim())
      const px = Number.parseFloat(raw ?? '')
      if (name === 'max-width') return viewport.width <= px
      if (name === 'min-width') return viewport.width >= px
      if (name === 'max-height') return viewport.height <= px
      if (name === 'min-height') return viewport.height >= px
      if (name === 'prefers-reduced-motion') return raw === undefined ? reducedMotion : (raw === 'reduce') === reducedMotion
      if (name in MEDIA_FEATURES) return raw === undefined || MEDIA_FEATURES[name] === raw
      compatWarn('media-query-unknown', feature)
      return false
    })
    return negate ? !holds : holds
  })
}

class NoopObserver {
  constructor(_callback: unknown) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return []
  }
}

/** `document.body` / `documentElement`: the root of the retained tree. */
class RootElement extends CompatElement {
  constructor(private readonly tag: string) {
    super(-1)
  }
  private get root(): CompatElement | null {
    const id = treeIndex().root
    return id === null ? null : nodeFor(id)
  }
  override get tagName(): string {
    return this.tag.toUpperCase()
  }
  override contains(other: unknown): boolean {
    return other instanceof CompatElement
  }
  override querySelectorAll(selector: string): CompatElement[] {
    const root = this.root
    if (!root) return []
    return [root, ...root.querySelectorAll(selector)].filter((node) => node.matches(selector))
  }
  override getBoundingClientRect() {
    return this.root?.getBoundingClientRect() ?? super.getBoundingClientRect()
  }
  appendChild<T>(child: T): T {
    compatWarn('dom-method-noop', 'body.appendChild')
    return child
  }
  removeChild<T>(child: T): T {
    return child
  }
}

export interface DomEnvOptions {
  reducedMotion: boolean
}

export function installDom(viewport: Viewport, options: DomEnvOptions): void {
  const g = globalThis as Record<string, unknown>
  const win = g.window as EventTarget & Record<string, unknown>
  const doc = g.document as EventTarget & Record<string, unknown>
  const body = new RootElement('body')
  const html = new RootElement('html')

  Object.defineProperty(doc, 'activeElement', {
    get: () => nodeOrNull(compatRenderer()?.getFocusedElementId()) ?? body,
    configurable: true
  })
  Object.assign(doc, {
    body,
    documentElement: html,
    head: new RootElement('head'),
    hasFocus: () => true,
    getElementById: (id: string) => body.querySelector(`#${id}`),
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    createElement: (tag: string) => {
      compatWarn('dom-method-noop', `document.createElement(${tag})`)
      return new CompatElement(-1)
    },
    getSelection: () => null,
    elementFromPoint: () => null,
    fonts: Object.assign(new EventTarget(), { ready: Promise.resolve(), status: 'loaded' })
  })

  setFocusSink((type, target, related) => {
    doc.dispatchEvent(domEvent(type, { target, relatedTarget: related }))
  })

  for (const name of [
    'HTMLElement', 'HTMLDivElement', 'HTMLSpanElement', 'HTMLButtonElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLAnchorElement', 'HTMLImageElement', 'HTMLLIElement', 'HTMLUListElement',
    'HTMLFormElement', 'HTMLLabelElement', 'HTMLSelectElement', 'SVGElement', 'SVGSVGElement', 'Element'
  ]) {
    g[name] = CompatElement
  }
  g.Node = CompatNode

  let size = viewport
  const raf = (callback: (time: number) => void) =>
    setTimeout(() => callback(performance.now()), 16) as unknown as number
  const caf = (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
  const matchMedia = (query: string) => ({
    get matches() {
      return evaluateMediaQuery(query, size, options.reducedMotion)
    },
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true
  })
  const getComputedStyle = () => {
    compatWarn('dom-method-noop', 'getComputedStyle')
    return new Proxy({ getPropertyValue: () => '' }, { get: (target, key) => (key in target ? target[key as 'getPropertyValue'] : '') })
  }
  const globals = {
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    matchMedia,
    getComputedStyle,
    ResizeObserver: CompatResizeObserver,
    IntersectionObserver: NoopObserver,
    MutationObserver: NoopObserver,
    devicePixelRatio: 1,
    scrollTo: () => {},
    getSelection: () => null
  }
  Object.assign(g, globals)
  Object.assign(win, globals, { navigator: g.navigator })
  win.addEventListener('resize', () => {
    size = { width: Number(win.innerWidth), height: Number(win.innerHeight) }
  })
}
