/**
 * The HTMLElement a shared component gets from `ref`, `event.target` or
 * `document.activeElement`. One `CompatElement` per GPUIX element id, created
 * on demand. Geometry, focus and scrolling go to the native renderer; tree
 * queries (`contains`, `closest`, `querySelectorAll`, `parentElement`) go to a
 * mirror of the retained tree, rebuilt only when a mutation batch landed.
 *
 * Only elements the compat layer tracks (a user ref, a DOM handler, a DOM
 * attribute, a focusable tag) carry their tag and attributes; an untracked
 * element answers queries as an anonymous `div`.
 */

import { appliedBatchCount } from '@gpuix/native/host'
import type { DomHandlers } from './events'
import { compatWarn } from './log'

/** What the compat layer stores on each GPUIX element it creates, as `props.__dom`. */
export interface DomInfo {
  readonly tag: string
  readonly className: string
  /** id, role, type, href, name, disabled, tabIndex, data-*, aria-*. */
  readonly attrs: Readonly<Record<string, unknown>>
  readonly handlers: DomHandlers | null
  readonly value?: string
}

export interface TrackedInstance {
  readonly id: number
  readonly type: string
  readonly props: { readonly __dom?: DomInfo; readonly value?: string }
}

export interface CompatRenderer {
  focusElement(id: number): void
  getFocusedElementId(): number | null
  blur(): void
  scrollTo(id: number, x: number, y: number): void
  getScrollOffset(id: number): number[] | null
  scrollIntoView(id: number): void
  getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null
  getAutomationTree(): string
}

let renderer: CompatRenderer | null = null

export function bindCompatRenderer(next: CompatRenderer | null): void {
  renderer = next
}

export function compatRenderer(): CompatRenderer | null {
  return renderer
}

const instances = new Map<number, TrackedInstance>()
const nodes = new Map<number, CompatElement>()
/** Live input values reported by onChange, for uncontrolled inputs. */
export const inputValues = new Map<number, string>()

/**
 * The ref every tracked element gets. One function for all of them, so React
 * never detaches and re-attaches it on re-render.
 */
export function trackInstance(instance: TrackedInstance | null): (() => void) | undefined {
  if (!instance) return undefined
  const id = instance.id
  instances.set(id, instance)
  return () => {
    if (instances.get(id) === instance) instances.delete(id)
    nodes.get(id)?.detach()
    inputValues.delete(id)
  }
}

export function trackedInstance(id: number): TrackedInstance | undefined {
  return instances.get(id)
}

export function nodeFor(id: number): CompatElement {
  let node = nodes.get(id)
  if (!node) {
    node = new CompatElement(id)
    nodes.set(id, node)
  }
  return node
}

export function nodeOrNull(id: number | null | undefined): CompatElement | null {
  return id === null || id === undefined ? null : nodeFor(id)
}

interface TreeIndex {
  parent: Map<number, number>
  children: Map<number, number[]>
  root: number | null
}

interface TreeJson {
  id: number
  type: string
  children?: TreeJson[]
}

let index: TreeIndex = { parent: new Map(), children: new Map(), root: null }
let indexBatch = -1

/** The retained tree's parent/child links as of the last applied batch. */
export function treeIndex(): TreeIndex {
  const batch = appliedBatchCount()
  if (batch === indexBatch || !renderer) return index
  const parent = new Map<number, number>()
  const children = new Map<number, number[]>()
  const json = JSON.parse(renderer.getAutomationTree()) as TreeJson | null
  const walk = (node: TreeJson) => {
    if (!node.children?.length) return
    const ids: number[] = []
    for (const child of node.children) {
      if (!child) continue
      ids.push(child.id)
      parent.set(child.id, node.id)
      walk(child)
    }
    children.set(node.id, ids)
  }
  if (json) walk(json)
  index = { parent, children, root: json?.id ?? null }
  indexBatch = batch
  return index
}

/** Ancestor ids of `id`, nearest first. */
export function ancestorIds(id: number): number[] {
  const { parent } = treeIndex()
  const out: number[] = []
  for (let at = parent.get(id); at !== undefined; at = parent.get(at)) out.push(at)
  return out
}

function descendantIds(id: number): number[] {
  const { children } = treeIndex()
  const out: number[] = []
  const stack = [...(children.get(id) ?? [])].reverse()
  while (stack.length) {
    const next = stack.pop() as number
    out.push(next)
    const kids = children.get(next)
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return out
}

export interface RectLike {
  x: number
  y: number
  width: number
  height: number
  top: number
  left: number
  right: number
  bottom: number
  toJSON(): unknown
}

function rect(x: number, y: number, width: number, height: number): RectLike {
  return {
    x, y, width, height,
    top: y, left: x, right: x + width, bottom: y + height,
    toJSON() {
      return { x, y, width, height }
    }
  }
}

const styleSink: Record<string, unknown> = new Proxy(
  {},
  {
    set(_target, key) {
      compatWarn('dom-style-write', String(key))
      return true
    },
    get(_target, key) {
      if (key === 'setProperty' || key === 'removeProperty') {
        return (name: string) => compatWarn('dom-style-write', name)
      }
      return ''
    }
  }
)

export class CompatElement {
  readonly nodeType = 1
  readonly style = styleSink

  constructor(readonly elementId: number) {}

  detach(): void {}

  get dom(): DomInfo | undefined {
    return instances.get(this.elementId)?.props.__dom
  }

  get tagName(): string {
    return (this.dom?.tag ?? 'div').toUpperCase()
  }

  get nodeName(): string {
    return this.tagName
  }

  get localName(): string {
    return this.dom?.tag ?? 'div'
  }

  get id(): string {
    return String(this.dom?.attrs.id ?? '')
  }

  get className(): string {
    return this.dom?.className ?? ''
  }

  get classList(): { contains(name: string): boolean } {
    const names = this.className.split(/\s+/)
    return { contains: (name: string) => names.includes(name) }
  }

  get dataset(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.dom?.attrs ?? {})) {
      if (!key.startsWith('data-') || value === undefined || value === null || value === false) continue
      out[key.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = String(value)
    }
    return out
  }

  get disabled(): boolean {
    return Boolean(this.dom?.attrs.disabled)
  }

  get value(): string {
    const props = instances.get(this.elementId)?.props
    return inputValues.get(this.elementId) ?? props?.value ?? this.dom?.value ?? ''
  }

  set value(next: string) {
    inputValues.set(this.elementId, next)
  }

  get type(): string {
    return String(this.dom?.attrs.type ?? '')
  }

  get isConnected(): boolean {
    const tree = treeIndex()
    return tree.root === this.elementId || tree.parent.has(this.elementId)
  }

  get ownerDocument(): unknown {
    return (globalThis as { document?: unknown }).document
  }

  getAttribute(name: string): string | null {
    const value = this.dom?.attrs[name]
    if (value === undefined || value === null || value === false) return null
    return value === true ? '' : String(value)
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null
  }

  setAttribute(name: string): void {
    compatWarn('dom-method-noop', `setAttribute(${name})`)
  }

  removeAttribute(name: string): void {
    compatWarn('dom-method-noop', `removeAttribute(${name})`)
  }

  focus(): void {
    if (!renderer) return compatWarn('dom-method-noop', 'focus before the renderer is bound')
    renderer.focusElement(this.elementId)
  }

  blur(): void {
    if (renderer?.getFocusedElementId() === this.elementId) renderer.blur()
  }

  click(): void {
    this.dom?.handlers?.onClick?.(new Event('click') as never)
  }

  scrollIntoView(): void {
    renderer?.scrollIntoView(this.elementId)
  }

  getBoundingClientRect(): RectLike {
    const b = renderer?.getElementBounds(this.elementId) ?? null
    if (!b) compatWarn('dom-method-partial', 'getBoundingClientRect before paint')
    return rect(b?.x ?? 0, b?.y ?? 0, b?.width ?? 0, b?.height ?? 0)
  }

  getClientRects(): RectLike[] {
    return [this.getBoundingClientRect()]
  }

  get offsetWidth(): number {
    return this.getBoundingClientRect().width
  }

  get offsetHeight(): number {
    return this.getBoundingClientRect().height
  }

  get clientWidth(): number {
    return this.offsetWidth
  }

  get clientHeight(): number {
    return this.offsetHeight
  }

  get offsetParent(): CompatElement | null {
    return this.parentElement
  }

  get scrollTop(): number {
    const offset = renderer?.getScrollOffset(this.elementId)
    return offset ? -offset[1] : 0
  }

  set scrollTop(y: number) {
    this.scrollTo({ top: y })
  }

  get scrollLeft(): number {
    const offset = renderer?.getScrollOffset(this.elementId)
    return offset ? -offset[0] : 0
  }

  set scrollLeft(x: number) {
    this.scrollTo({ left: x })
  }

  /** The extent of the children's painted boxes: GPUIX has no content-size query. */
  get scrollHeight(): number {
    return this.contentExtent().height
  }

  get scrollWidth(): number {
    return this.contentExtent().width
  }

  private contentExtent(): { width: number; height: number } {
    const own = this.getBoundingClientRect()
    let right = own.width
    let bottom = own.height
    for (const child of treeIndex().children.get(this.elementId) ?? []) {
      const b = renderer?.getElementBounds(child)
      if (!b) continue
      right = Math.max(right, b.x - own.x + this.scrollLeft + b.width)
      bottom = Math.max(bottom, b.y - own.y + this.scrollTop + b.height)
    }
    return { width: right, height: bottom }
  }

  scrollTo(xOrOptions?: number | { top?: number; left?: number }, y?: number): void {
    if (!renderer) return
    const options = typeof xOrOptions === 'number' ? { left: xOrOptions, top: y } : (xOrOptions ?? {})
    const left = options.left ?? this.scrollLeft
    const top = options.top ?? this.scrollTop
    renderer.scrollTo(this.elementId, left, top)
  }

  scrollBy(xOrOptions?: number | { top?: number; left?: number }, y?: number): void {
    const options = typeof xOrOptions === 'number' ? { left: xOrOptions, top: y } : (xOrOptions ?? {})
    this.scrollTo({ left: this.scrollLeft + (options.left ?? 0), top: this.scrollTop + (options.top ?? 0) })
  }

  get parentElement(): CompatElement | null {
    const parent = treeIndex().parent.get(this.elementId)
    return parent === undefined ? null : nodeFor(parent)
  }

  get parentNode(): CompatElement | null {
    return this.parentElement
  }

  get children(): CompatElement[] {
    return (treeIndex().children.get(this.elementId) ?? []).map(nodeFor)
  }

  get childNodes(): CompatElement[] {
    return this.children
  }

  get firstElementChild(): CompatElement | null {
    return this.children[0] ?? null
  }

  get lastElementChild(): CompatElement | null {
    return this.children.at(-1) ?? null
  }

  contains(other: unknown): boolean {
    if (!(other instanceof CompatElement)) return false
    if (other.elementId === this.elementId) return true
    return ancestorIds(other.elementId).includes(this.elementId)
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector)
  }

  closest(selector: string): CompatElement | null {
    if (this.matches(selector)) return this
    for (const id of ancestorIds(this.elementId)) {
      const node = nodeFor(id)
      if (node.matches(selector)) return node
    }
    return null
  }

  querySelectorAll(selector: string): CompatElement[] {
    return descendantIds(this.elementId)
      .map(nodeFor)
      .filter((node) => node.matches(selector))
  }

  querySelector(selector: string): CompatElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  addEventListener(type: string): void {
    compatWarn('dom-method-noop', `element.addEventListener(${type})`)
  }

  removeEventListener(): void {}

  dispatchEvent(): boolean {
    return true
  }

  setPointerCapture(): void {}

  releasePointerCapture(): void {}

  hasPointerCapture(): boolean {
    return false
  }

  animate(): { finished: Promise<void>; cancel(): void; onfinish: null } {
    compatWarn('dom-method-noop', 'animate')
    return { finished: Promise.resolve(), cancel() {}, onfinish: null }
  }

  select(): void {
    compatWarn('dom-method-noop', 'select')
  }

  setSelectionRange(): void {
    compatWarn('dom-method-noop', 'setSelectionRange')
  }
}

/** The DOM node types shared code tests with `instanceof`. */
export class CompatNode {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof CompatElement
  }
}

interface AttrTest {
  name: string
  op?: '=' | '^=' | '$=' | '*=' | '~='
  value?: string
}

interface Compound {
  tag?: string
  id?: string
  classes: string[]
  attrs: AttrTest[]
  not: Compound[][]
}

type Complex = { compound: Compound; combinator: ' ' | '>' | null }[]

const parsed = new Map<string, Complex[]>()

function splitTop(selector: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth === 0 && ch === sep) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

function parseCompound(text: string): Compound {
  const compound: Compound = { classes: [], attrs: [], not: [] }
  const re = /^([a-zA-Z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*]?=)["']?([^"'\]]*)["']?)?\]|:not\((.+?)\)(?=$|[.#[:])/g
  for (const m of text.matchAll(re)) {
    if (m[1]) compound.tag = m[1] === '*' ? undefined : m[1].toLowerCase()
    else if (m[2]) compound.id = m[2]
    else if (m[3]) compound.classes.push(m[3])
    else if (m[4]) compound.attrs.push({ name: m[4], op: m[5] as AttrTest['op'], value: m[6] })
    else if (m[7]) compound.not.push(...parseSelector(m[7]).map((c) => c.map((part) => part.compound)))
  }
  return compound
}

function parseSelector(selector: string): Complex[] {
  const hit = parsed.get(selector)
  if (hit) return hit
  const list = splitTop(selector, ',').map((complex) => {
    const parts: Complex = []
    const tokens = complex.replace(/\s*>\s*/g, ' > ').split(/\s+/)
    let combinator: ' ' | '>' | null = null
    for (const token of tokens) {
      if (token === '>') {
        combinator = '>'
        continue
      }
      parts.push({ compound: parseCompound(token), combinator })
      combinator = ' '
    }
    return parts
  })
  parsed.set(selector, list)
  return list
}

function matchesCompound(node: CompatElement, compound: Compound): boolean {
  if (compound.tag && node.localName !== compound.tag) return false
  if (compound.id && node.id !== compound.id) return false
  for (const name of compound.classes) if (!node.classList.contains(name)) return false
  for (const test of compound.attrs) {
    const actual = node.getAttribute(test.name === 'tabindex' ? 'tabIndex' : test.name)
    if (actual === null) return false
    if (test.op === undefined) continue
    const want = test.value ?? ''
    if (test.op === '=' && actual !== want) return false
    if (test.op === '^=' && !actual.startsWith(want)) return false
    if (test.op === '$=' && !actual.endsWith(want)) return false
    if (test.op === '*=' && !actual.includes(want)) return false
    if (test.op === '~=' && !actual.split(/\s+/).includes(want)) return false
  }
  if (compound.not.some((chain) => chain.every((c) => matchesCompound(node, c)))) return false
  return true
}

function matchesComplex(node: CompatElement, complex: Complex): boolean {
  let i = complex.length - 1
  if (!matchesCompound(node, complex[i].compound)) return false
  let at: CompatElement | null = node
  while (i > 0) {
    const combinator = complex[i].combinator
    i--
    if (combinator === '>') {
      at = at?.parentElement ?? null
      if (!at || !matchesCompound(at, complex[i].compound)) return false
    } else {
      at = at?.parentElement ?? null
      while (at && !matchesCompound(at, complex[i].compound)) at = at.parentElement
      if (!at) return false
    }
  }
  return true
}

export function matchesSelector(node: CompatElement, selector: string): boolean {
  return parseSelector(selector).some((complex) => matchesComplex(node, complex))
}
