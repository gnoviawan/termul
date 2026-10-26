import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ReactElement } from 'react'
import { hitTree } from '../../src/compat/dnd'
import { jsx } from '../../src/compat/jsx-runtime'
import type { Bounds, TreeJson } from '../../src/compat/live-reads'
import { type Placement, placeStyle } from '../../src/compat/placement'
import { LAYER, zIndexToken } from '../../src/compat/stacking'
import { translation } from '../../src/compat/translate'

const RENDERER = path.resolve(import.meta.dir, '../../../../src/renderer')
const GPUIX_SRC = path.resolve(import.meta.dir, '../../src')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) sourceFiles(file, out)
    else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) out.push(file)
  }
  return out
}

/** The text from `open` (a `<` or `{`) to the `>` or `}` that closes it, skipping nested braces. */
function balanced(text: string, from: number, close: '>' | '}'): string {
  let depth = 0
  for (let at = from; at < text.length; at++) {
    const ch = text[at]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (close === '}' && depth === 0) return text.slice(from, at + 1)
    } else if (ch === close && depth === 0 && at > from) return text.slice(from, at + 1)
  }
  return text.slice(from)
}

/** Each `<anchored>` element in the GPUIX sources (JSX or `jsx('anchored')`), with its props' text. */
function anchoredSites(): { site: string; props: string }[] {
  const sites: { site: string; props: string }[] = []
  for (const file of sourceFiles(GPUIX_SRC)) {
    const text = readFileSync(file, 'utf8')
    const line = (at: number) => `${path.relative(GPUIX_SRC, file)}:${text.slice(0, at).split('\n').length}`
    for (const match of text.matchAll(/<anchored\s/g)) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1
      if (/^\s*(\*|\/\/)/.test(text.slice(lineStart, match.index))) continue
      sites.push({ site: line(match.index), props: balanced(text, match.index, '>') })
    }
    for (const match of text.matchAll(/\(\s*'anchored' as never,\s*\{/g)) {
      const open = match.index + match[0].length - 1
      sites.push({ site: line(match.index), props: balanced(text, open, '}') })
    }
  }
  return sites
}

type Props = {
  style?: Record<string, unknown>
  priority?: number
  fill?: string
  children?: unknown
}

describe('z-index classes', () => {
  test('an in-flow element carries its z-index as the zIndex style', () => {
    expect(translation('div', 'relative z-10 w-full').base.zIndex).toBe(10)
    expect(translation('div', 'relative z-0 mx-auto -mt-4').base.zIndex).toBe(0)
    expect(translation('div', 'absolute z-[60]').base.zIndex).toBe(60)
    expect(translation('div', 'relative z-9999').base.zIndex).toBe(9999)
    expect(translation('div', 'relative -z-10').base.zIndex).toBe(-10)
    expect(translation('div', 'relative z-auto').base.zIndex).toBeUndefined()
    expect(translation('div', 'relative').base.zIndex).toBeUndefined()
  })

  test('a fixed element takes its z-index as the priority of its window layer', () => {
    const tr = translation('div', 'fixed inset-0 bg-overlay/60 z-50 flex')
    expect(tr.zIndex).toBe(50)
    expect(tr.base.zIndex).toBeUndefined()
    const layer = jsx('div', {
      className: 'fixed inset-0 bg-overlay/60 z-50 flex'
    }) as ReactElement<Props>
    expect(layer.type as unknown).toBe('anchored')
    expect(layer.props.fill).toBe('window')
    expect(layer.props.priority).toBe(50)
    const inner = layer.props.children as ReactElement<Props>
    expect(inner.props.style?.zIndex).toBeUndefined()

    const plain = jsx('div', { className: 'fixed inset-0' }) as ReactElement<Props>
    expect(plain.props.priority).toBe(0)
  })

  test('the composer card and the strip under it keep their classes otherwise', () => {
    const card = jsx('div', {
      className: 'relative z-10 w-full',
      children: 'card'
    }) as ReactElement<Props>
    expect(card.props.style?.zIndex).toBe(10)
    expect(card.props.style?.position).toBe('relative')
  })

  test('every z-index class the shared renderer uses is translated', () => {
    const tokens = new Map<string, number | null>()
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name)
        if (statSync(file).isDirectory()) {
          if (name !== '__tests__') walk(file)
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          for (const match of readFileSync(file, 'utf8').matchAll(
            /(?<=["'`\s])-?z-(?:\[[^\]\s]+\]|\d+|auto)(?=["'`\s])/g
          )) {
            tokens.set(match[0], zIndexToken(match[0]) ?? null)
          }
        }
      }
    }
    walk(RENDERER)
    expect(tokens.size).toBeGreaterThan(8)
    for (const [token, z] of tokens) {
      if (token === 'z-auto') expect(z).toBeNull()
      else expect({ token, z: typeof z }).toEqual({ token, z: 'number' })
    }
  })
})

describe('overlay layers sort above in-flow z-50', () => {
  test('every <anchored> layer names its priority, so none sorts at 0 under a z-index box by accident', () => {
    const sites = anchoredSites()
    expect(sites.length).toBeGreaterThan(5)
    const missing = sites.filter(({ props }) => !/\bpriority\b/.test(props)).map(({ site }) => site)
    expect(missing).toEqual([])
  })

  test('a top-full or bottom-full popup takes its z-index as its layer priority', () => {
    const popup = (classes: string) => {
      const tr = translation('div', classes)
      const placed = placeStyle(tr.base, tr.placement as Placement)
      return { inner: placed?.inner, props: placed?.wrap(jsx('div', {})).props as { priority?: number } }
    }
    const lifted = popup('absolute bottom-full left-0 z-50 mb-1')
    expect(lifted.props.priority).toBe(50)
    expect(lifted.inner).not.toHaveProperty('zIndex')
    expect(popup('absolute top-full left-0 mt-1').props.priority).toBe(0)
  })

  test('dialogs, popovers and submenus keep their order above the web overlays z-50', () => {
    expect([LAYER.dialog, LAYER.popover, LAYER.submenu]).toEqual([51, 52, 54])
  })

  test('a tooltip takes its own z-50, as the web leaves it unportalled beside its trigger', () => {
    expect(LAYER.tooltip).toBe(50)
  })
})

const box = (x: number, y: number, width: number, height: number): Bounds => ({
  x,
  y,
  width,
  height
})
const div = (id: number, bounds: Bounds, children?: TreeJson[], layer?: number): TreeJson => ({
  id,
  type: 'div',
  bounds,
  children,
  ...(layer !== undefined ? { layer } : {})
})

describe('the DnD hit test reads paint layers', () => {
  // The card (z-10) above the strip that follows it and overlaps its bottom.
  const card = div(2, box(0, 0, 100, 50), [], 10)
  const strip = div(3, box(0, 40, 100, 50))

  test('a z-index layer is hit over a later sibling', () => {
    expect(
      hitTree(div(1, box(0, 0, 100, 100), [div(2, box(0, 0, 100, 50)), strip]), { x: 10, y: 45 })
    ).toBe(3)
    expect(hitTree(div(1, box(0, 0, 100, 100), [card, strip]), { x: 10, y: 45 })).toBe(2)
    expect(hitTree(div(1, box(0, 0, 100, 100), [card, strip]), { x: 10, y: 80 })).toBe(3)
  })

  test('equal priorities go by tree order, a higher priority wins', () => {
    const dialog = (layer: number) => ({
      ...div(2, box(0, 0, 100, 100), [div(4, box(0, 0, 100, 100))]),
      type: 'anchored',
      layer
    })
    const bar = div(3, box(0, 90, 100, 10), [], 50)
    expect(hitTree(div(1, box(0, 0, 100, 100), [dialog(50), bar]), { x: 10, y: 95 })).toBe(3)
    expect(hitTree(div(1, box(0, 0, 100, 100), [dialog(51), bar]), { x: 10, y: 95 })).toBe(4)
  })

  test('a layer inside a layer is hit before its container', () => {
    const inner = div(4, box(0, 0, 50, 50), [], 51)
    const dialog = {
      ...div(2, box(0, 0, 100, 100), [div(3, box(0, 0, 100, 100), [inner])]),
      type: 'anchored',
      layer: 51
    }
    const later = div(5, box(0, 0, 100, 100), [], 51)
    expect(hitTree(div(1, box(0, 0, 100, 100), [dialog]), { x: 10, y: 10 })).toBe(4)
    expect(hitTree(div(1, box(0, 0, 100, 100), [dialog]), { x: 80, y: 80 })).toBe(3)
    // The nested layer paints in the later round, over a later sibling of its container.
    expect(hitTree(div(1, box(0, 0, 100, 100), [dialog, later]), { x: 10, y: 10 })).toBe(4)
    expect(hitTree(div(1, box(0, 0, 100, 100), [dialog, later]), { x: 80, y: 80 })).toBe(5)
  })
})
