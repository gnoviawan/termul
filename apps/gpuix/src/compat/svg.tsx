/**
 * DOM `<svg>` trees (hugeicons, inline icons) -> one GPUIX `<svg source>`.
 * The child tags (`path`, `circle`, …) are inert markers the runtime never
 * mounts; this serialises them back to SVG markup.
 */

import type { StyleDesc } from '@gpuix/react'
import { Children, isValidElement, type ReactElement, type ReactNode, useContext } from 'react'
import { jsx } from 'react/jsx-runtime'
import { ColorContext, RotateContext, SvgClassContext } from './color'
import { translation } from './translate'
import { compatWarn } from './log'
import { parseSvgIcon, SVG_NS, type SvgNode, serializeSvg } from './shims/dompurify'

export const SVG_CHILD_TAGS = new Set([
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g', 'defs', 'clipPath',
  'mask', 'use', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc', 'symbol', 'text',
  'tspan', 'pattern', 'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'foreignObject'
])

const KEEP_CAMEL = new Set([
  'viewBox', 'preserveAspectRatio', 'gradientUnits', 'gradientTransform', 'patternUnits',
  'clipPathUnits', 'maskUnits', 'stdDeviation'
])
const SKIP = new Set(['children', 'className', 'style', 'ref', 'key', 'color', 'size', 'absoluteStrokeWidth', 'dangerouslySetInnerHTML'])

function attrName(key: string): string {
  if (KEEP_CAMEL.has(key)) return key
  if (key === 'xlinkHref') return 'xlink:href'
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function attrs(props: Record<string, unknown>): string {
  let out = ''
  for (const key in props) {
    const value = props[key]
    if (SKIP.has(key) || key.startsWith('on') || key.startsWith('data-') || key.startsWith('aria-')) continue
    if (value === undefined || value === null || value === false || typeof value === 'object' || typeof value === 'function') continue
    out += ` ${attrName(key)}="${escape(String(value).replace(/currentColor/g, '#000'))}"`
  }
  return out
}

function markup(node: ReactNode): string {
  let out = ''
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return
    if (typeof child.type !== 'string') {
      compatWarn('svg-child-component', String((child.type as { name?: string }).name ?? 'anonymous'))
      return
    }
    const props = child.props as Record<string, unknown>
    out += `<${child.type}${attrs(props)}>${markup(props.children as ReactNode)}</${child.type}>`
  })
  return out
}

function size(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^[\d.]+(px)?$/.test(value)) return Number.parseFloat(value)
  return undefined
}

const sources = new WeakMap<object, string>()

function sourceOf(props: Record<string, unknown>): string {
  const inner = (props.dangerouslySetInnerHTML as { __html?: unknown } | undefined)?.__html
  if (typeof inner === 'string') {
    const head = `<svg xmlns="${SVG_NS}"${attrs(props)}>`
    const tree = parseSvgIcon(`${head}${inner}</svg>`)
    return (tree ? serializeSvg(tree) : `${head}</svg>`).replace(/currentColor/g, '#000')
  }
  const children = props.children as object | undefined
  const cached = children && typeof children === 'object' ? sources.get(children) : undefined
  const head = `<svg xmlns="http://www.w3.org/2000/svg"${attrs(props)}>`
  if (cached !== undefined) return head + cached + '</svg>'
  const body = markup(props.children as ReactNode)
  if (children && typeof children === 'object') sources.set(children, body)
  return `${head}${body}</svg>`
}

interface CompatSvgProps {
  native: Record<string, unknown>
  /** The svg's own `rotate-*` class. */
  rotate: number | null
}

const VIEW_BOX = /^<svg[^>]*\sviewBox="\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/
const SIZE_ATTR = (name: string) => new RegExp(`^<svg[^>]*\\s${name}="([\\d.]+)`)

/** `source` turned `degrees` clockwise about its viewBox centre, as CSS `rotate()` turns the box. */
export function rotateSource(source: string, degrees: number): string {
  if (degrees % 360 === 0) return source
  const box = source.match(VIEW_BOX)
  const [x, y, w, h] = box
    ? box.slice(1).map(Number)
    : [0, 0, Number(source.match(SIZE_ATTR('width'))?.[1] ?? 24), Number(source.match(SIZE_ATTR('height'))?.[1] ?? 24)]
  const open = source.indexOf('>') + 1
  const close = source.lastIndexOf('</svg>')
  return `${source.slice(0, open)}<g transform="rotate(${degrees} ${x + w / 2} ${y + h / 2})">${source.slice(open, close)}</g>${source.slice(close)}`
}

function CompatSvg({ native, rotate }: CompatSvgProps): ReactElement {
  const inherited = useContext(ColorContext)
  const descendant = useContext(SvgClassContext)
  const turn = useContext(RotateContext) + (rotate ?? 0)
  let style = native.style as StyleDesc
  if (descendant) style = { ...style, ...translation('svg', descendant).base }
  if (style.color === undefined && inherited !== undefined) style = { ...style, color: inherited }
  const source = native.source as string
  const turned = rotateSource(source, turn)
  if (style === native.style && turned === source) return jsx('svg', native)
  return jsx('svg', { ...native, style, source: turned })
}

export function svgElement(
  props: Readonly<Record<string, unknown>>,
  style: StyleDesc,
  native: Record<string, unknown>,
  key: string | undefined,
  rotate: number | null = null
): ReactElement {
  native.source = sourceOf(props as Record<string, unknown>)
  native.style = {
    ...style,
    width: style.width ?? size(props.width) ?? 16,
    height: style.height ?? size(props.height) ?? 16
  }
  return jsx(CompatSvg, { native, rotate }, key)
}

/** Largest side, in px, an `<img>` icon rasterises at; gpui doubles it for smoothness. */
const MAX_RASTER = 256

function rootSize(tree: SvgNode, name: string): number | undefined {
  const value = tree.attrs.find(([attr]) => attr === name)?.[1]
  return value && /^\s*[\d.]+(px)?\s*$/.test(value) ? Number.parseFloat(value) : undefined
}

function paintsOwnColours(node: SvgNode): boolean {
  for (const [name, value] of node.attrs) {
    if ((name === 'fill' || name === 'stroke' || name === 'stop-color') && /^\s*[#a-z]/i.test(value) && !/^\s*(?:currentColor|none|transparent)\b/i.test(value) && !/^\s*url\(/i.test(value)) return true
  }
  return node.children.some(paintsOwnColours)
}

/**
 * Markup set through `dangerouslySetInnerHTML` that is one `<svg>` (the
 * sanitized agent icons): the GPUIX `<svg source>` the same tree would make,
 * tinted by the inherited colour and sized by the parent's `[&_svg]` classes.
 * GPUIX's svg is one colour, so markup that paints its own colours becomes a
 * full-colour `<img>` of the SVG instead, rasterised at its box rather than
 * its intrinsic size. The markup is re-parsed here whoever sanitized it, so
 * only the allowlisted tree reaches the native renderer. Null for any other
 * markup.
 */
export function innerHtmlSvg(html: unknown): ReactElement | null {
  if (typeof html !== 'string') return null
  const tree = parseSvgIcon(html.trim())
  if (!tree) return null
  const width = rootSize(tree, 'width') ?? 16
  const height = rootSize(tree, 'height') ?? 16
  if (paintsOwnColours(tree)) {
    const raster = Math.min(1, MAX_RASTER / Math.max(width, height, 1))
    const markup = serializeSvg(tree, { width: String(Math.max(1, Math.round(width * raster))), height: String(Math.max(1, Math.round(height * raster))) })
    return jsx('img', { src: `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`, style: { width, height } })
  }
  const source = serializeSvg(tree).replace(/currentColor/g, '#000')
  return jsx(CompatSvg, { native: { source, style: { width, height } }, rotate: null })
}
