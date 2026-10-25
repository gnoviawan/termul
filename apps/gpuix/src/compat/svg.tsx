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

export const SVG_CHILD_TAGS = new Set([
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g', 'defs', 'clipPath',
  'mask', 'use', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc', 'symbol', 'text',
  'tspan', 'pattern', 'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'foreignObject'
])

const KEEP_CAMEL = new Set([
  'viewBox', 'preserveAspectRatio', 'gradientUnits', 'gradientTransform', 'patternUnits',
  'clipPathUnits', 'maskUnits', 'stdDeviation'
])
const SKIP = new Set(['children', 'className', 'style', 'ref', 'key', 'color', 'size', 'absoluteStrokeWidth'])

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
  const turned = turn % 360 === 0 ? source : rotateSource(source, turn)
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
