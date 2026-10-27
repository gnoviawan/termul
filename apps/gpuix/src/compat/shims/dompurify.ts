/**
 * `dompurify` for shared code. DOMPurify parses through a live DOM, which
 * GPUIX does not have. One case is served without it: an SVG icon
 * (`USE_PROFILES: { svg: true }`, the agent icons), which compat paints
 * natively. The markup is parsed as strict XML into a tree of allowlisted
 * shapes and written back out canonically, so what reaches the native SVG
 * renderer is only ever this module's own output. Every other call fails
 * closed.
 *
 * The limits bound the native renderer, not the markup: usvg recurses per
 * nesting level on a fixed-size thread stack, and masks, clips and group
 * opacity each cost a full-size layer per use.
 */

import { compatWarn } from '../log'

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const MAX_SVG_BYTES = 64 * 1024
/** Element levels, the root included. */
export const MAX_SVG_DEPTH = 64
export const MAX_SVG_ELEMENTS = 1024
/** Elements with `mask`, `clip-path` or `opacity`: each one renders into its own layer. */
export const MAX_SVG_LAYERS = 32
/** Elements inside clip paths and masks, which render again for every reference. */
export const MAX_SVG_CLIP_CONTENT = 64
/** Characters of `<text>`; usvg shapes every glyph on the UI thread. */
export const MAX_SVG_TEXT = 64

export interface SvgNode {
  name: string
  attrs: [string, string][]
  children: SvgNode[]
  text: string
}

const PRESENTATION = [
  'id', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'opacity', 'color', 'transform',
  'clip-path', 'clip-rule', 'mask', 'display', 'visibility'
]
const FONT = ['font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing']
const GRADIENT = ['gradientUnits', 'gradientTransform', 'spreadMethod', 'href']

const ELEMENTS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    svg: ['viewBox', 'width', 'height', 'preserveAspectRatio', ...PRESENTATION],
    g: PRESENTATION,
    defs: ['id'],
    path: ['d', ...PRESENTATION],
    circle: ['cx', 'cy', 'r', ...PRESENTATION],
    ellipse: ['cx', 'cy', 'rx', 'ry', ...PRESENTATION],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', ...PRESENTATION],
    line: ['x1', 'y1', 'x2', 'y2', ...PRESENTATION],
    polyline: ['points', ...PRESENTATION],
    polygon: ['points', ...PRESENTATION],
    clipPath: ['id', 'clipPathUnits', 'transform', 'clip-path'],
    mask: ['id', 'x', 'y', 'width', 'height', 'maskUnits', 'maskContentUnits', 'mask'],
    linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', ...GRADIENT],
    radialGradient: ['id', 'cx', 'cy', 'r', 'fx', 'fy', 'fr', ...GRADIENT],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    // Two bundled agent icons (dirac, vtcode) letter their mark.
    text: ['x', 'y', 'dx', 'dy', ...FONT, ...PRESENTATION],
    title: [],
    desc: []
  }).map(([name, attrs]) => [name, new Set(attrs)])
)
const TEXT_ELEMENTS = new Set(['text', 'title', 'desc'])
const LAYER_ATTRS = new Set(['mask', 'clip-path', 'opacity'])
/** Inside these, a further mask or clip would multiply the renders per level. */
const CLIP_CONTENT = new Set(['clipPath', 'mask'])

const NAME = /[A-Za-z_][\w.:-]*/y
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y
const TAG_END = /\s*(\/?)>/y
const CLOSE = /<\/([A-Za-z_][\w.:-]*)\s*>/y
const SPACE = /\s*/y
const XML_DECL = /<\?xml\s[^?]*\?>/y
const DOCTYPE = /<!DOCTYPE\s[^[>]*>/y
const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#x([\da-fA-F]{1,6}));|&/g
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const FRAGMENT = /^#[\w.-]+$/
const REMOTE_URL = /url\(\s*(?!#)/i

class Rejected extends Error {}

function decode(raw: string): string {
  return raw.replace(ENTITY, (match, named?: string, dec?: string, hex?: string) => {
    if (named) return NAMED[named] as string
    const code = dec ? Number(dec) : hex ? Number.parseInt(hex, 16) : 0
    if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Rejected(`entity ${match}`)
    return String.fromCodePoint(code)
  })
}

function keepAttr(element: string, name: string, value: string, inClip: boolean): boolean {
  if (!ELEMENTS[element]?.has(name)) return false
  if (name === 'href') return FRAGMENT.test(value)
  if (inClip && (name === 'mask' || name === 'clip-path')) return false
  return !REMOTE_URL.test(value)
}

function parse(src: string): SvgNode {
  let at = 0
  let elements = 0
  let layers = 0
  let clipContent = 0

  const sticky = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = at
    const m = re.exec(src)
    if (m) at = re.lastIndex
    return m
  }
  const skipComment = (): boolean => {
    if (!src.startsWith('<!--', at)) return false
    const end = src.indexOf('-->', at + 4)
    if (end < 0) throw new Rejected('unclosed comment')
    at = end + 3
    return true
  }

  function element(depth: number, keep: boolean, inClip: boolean): SvgNode | null {
    if (depth >= MAX_SVG_DEPTH) throw new Rejected('nesting')
    if (++elements > MAX_SVG_ELEMENTS) throw new Rejected('elements')
    if (inClip && ++clipContent > MAX_SVG_CLIP_CONTENT) throw new Rejected('clip content')
    at++
    const name = sticky(NAME)?.[0]
    if (!name) throw new Rejected('tag name')
    const raw = new Map<string, string>()
    for (let m = sticky(ATTR); m; m = sticky(ATTR)) {
      if (raw.has(m[1] as string)) throw new Rejected('duplicate attribute')
      raw.set(m[1] as string, decode(m[2] ?? m[3] ?? ''))
    }
    const end = sticky(TAG_END)
    if (!end) throw new Rejected(`malformed <${name}>`)
    const ns = raw.get('xmlns')
    if (depth === 0 && (name !== 'svg' || (ns !== undefined && ns !== SVG_NS))) throw new Rejected('root')
    const kept = keep && name in ELEMENTS && (depth === 0) === (name === 'svg') && (ns === undefined || ns === SVG_NS)
    let node: SvgNode | null = null
    if (kept) {
      node = { name, attrs: [], children: [], text: '' }
      const seen = new Set<string>()
      for (const [rawName, value] of raw) {
        const attr = rawName === 'xlink:href' ? 'href' : rawName
        if (seen.has(attr) || !keepAttr(name, attr, value, inClip)) continue
        seen.add(attr)
        node.attrs.push([attr, value])
        if (LAYER_ATTRS.has(attr) && ++layers > MAX_SVG_LAYERS) throw new Rejected('layers')
      }
    }
    if (end[1]) return node
    const childClip = inClip || CLIP_CONTENT.has(name)
    for (;;) {
      if (at >= src.length) throw new Rejected(`unclosed <${name}>`)
      if (src.startsWith('</', at)) {
        if (sticky(CLOSE)?.[1] !== name) throw new Rejected(`mismatched </${name}>`)
        return node
      }
      if (skipComment()) continue
      if (src.startsWith('<![CDATA[', at)) {
        const close = src.indexOf(']]>', at)
        if (close < 0) throw new Rejected('unclosed CDATA')
        text(node, src.slice(at + 9, close))
        at = close + 3
        continue
      }
      if (src.startsWith('<!', at) || src.startsWith('<?', at)) throw new Rejected('markup declaration')
      if (src[at] === '<') {
        const child = element(depth + 1, kept, childClip)
        if (child && node) node.children.push(child)
        continue
      }
      const next = src.indexOf('<', at)
      const run = src.slice(at, next < 0 ? src.length : next)
      at += run.length
      text(node, decode(run))
    }
  }

  function text(node: SvgNode | null, run: string): void {
    if (!node || !TEXT_ELEMENTS.has(node.name)) return
    node.text += run
    if (node.name === 'text' && node.text.length > MAX_SVG_TEXT) throw new Rejected('text')
  }

  for (;;) {
    sticky(SPACE)
    if (!(sticky(XML_DECL) || sticky(DOCTYPE) || skipComment())) break
  }
  if (src[at] !== '<') throw new Rejected('root')
  const root = element(0, true, false) as SvgNode
  for (;;) {
    sticky(SPACE)
    if (at >= src.length) return root
    if (!skipComment()) throw new Rejected('content after </svg>')
  }
}

const cache = new Map<string, SvgNode | null>()
const CACHE_LIMIT = 256

/** `markup` as an allowlisted SVG tree, or null when it is not one well-formed `<svg>` within the limits. */
export function parseSvgIcon(markup: string): SvgNode | null {
  const hit = cache.get(markup)
  if (hit !== undefined) return hit
  let tree: SvgNode | null = null
  if (markup.length > MAX_SVG_BYTES) compatWarn('svg-rejected', 'size')
  else {
    try {
      tree = parse(markup)
    } catch (error) {
      if (!(error instanceof Rejected)) throw error
      compatWarn('svg-rejected', error.message)
    }
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(markup, tree)
  return tree
}

function escape(value: string, quote: boolean): string {
  const out = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return quote ? out.replace(/"/g, '&quot;') : out
}

/** Canonical markup for `node`; `rootAttrs` replace or add attributes on the root. */
export function serializeSvg(node: SvgNode, rootAttrs?: Record<string, string>): string {
  let attrs = node.attrs
  let head = ''
  if (rootAttrs) {
    attrs = attrs.filter(([name]) => !(name in rootAttrs)).concat(Object.entries(rootAttrs))
  }
  if (node.name === 'svg') head = ` xmlns="${SVG_NS}"`
  for (const [name, value] of attrs) head += ` ${name}="${escape(value, true)}"`
  const body = escape(node.text, false) + node.children.map((child) => serializeSvg(child)).join('')
  return body ? `<${node.name}${head}>${body}</${node.name}>` : `<${node.name}${head}/>`
}

interface Config {
  USE_PROFILES?: { svg?: boolean }
}

function sanitize(dirty: unknown, config?: Config): string {
  if (config?.USE_PROFILES?.svg && typeof dirty === 'string') {
    const tree = parseSvgIcon(dirty)
    if (tree) return serializeSvg(tree)
  }
  compatWarn('library-stub', 'dompurify sanitize (fails closed)')
  return ''
}

const DOMPurify = {
  isSupported: false,
  sanitize,
  addHook(): void {},
  removeHook(): void {},
  removeAllHooks(): void {},
  setConfig(): void {},
  clearConfig(): void {}
}

export default DOMPurify
