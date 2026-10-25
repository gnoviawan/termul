import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ReactElement } from 'react'
import { hitTree } from '../../src/compat/dnd'
import { jsx } from '../../src/compat/jsx-runtime'
import type { Bounds, TreeJson } from '../../src/compat/live-reads'
import { LAYER, zIndexToken } from '../../src/compat/stacking'
import { translation } from '../../src/compat/translate'

const RENDERER = path.resolve(import.meta.dir, '../../../../src/renderer')

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
  test('dialogs, popovers, tooltips and submenus keep their order above the web overlays z-50', () => {
    expect([LAYER.dialog, LAYER.popover, LAYER.tooltip, LAYER.submenu]).toEqual([51, 52, 53, 54])
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
