import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { jsx, jsxs } from '../../src/compat/jsx-runtime'
import { translation } from '../../src/compat/translate'
import { DiffStatCounts } from '../../src/ui/diff-stat-counts'

interface Shape {
  type: string
  style?: unknown
  children?: Shape[] | string
}

/** The GPUIX element tree as type, style and children, the way the renderer receives it. */
function shape(node: ReactNode): Shape | string {
  if (!isValidElement(node)) return String(node)
  const { style, children } = (node as ReactElement<{ style?: unknown; children?: ReactNode }>).props
  const out: Shape = { type: String(node.type) }
  if (style !== undefined) out.style = style
  if (typeof children === 'string') out.children = children
  else if (children !== undefined) out.children = [children].flat(Number.POSITIVE_INFINITY).map(shape) as Shape[]
  return out
}

describe('inline text', () => {
  test('a plain text run becomes one text node with the span style', () => {
    expect(shape(jsxs('span', { className: 'text-xs', children: ['a ', 'b'] }))).toEqual({
      type: 'text',
      style: { fontSize: 12, lineHeight: 16 },
      children: 'a b'
    })
  })

  test('mixed inline content wraps as a row of word runs that keep their own style', () => {
    const p = jsxs('p', {
      children: ['Done. I renamed ', jsx('strong', { className: 'font-semibold', children: 'StatusItem' }), ' and kept it.']
    })
    expect(shape(p)).toEqual({
      type: 'div',
      style: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
      children: [
        { type: 'text', children: 'Done. ' },
        { type: 'text', children: 'I ' },
        { type: 'text', children: 'renamed ' },
        { type: 'text', style: { fontWeight: 600 }, children: 'StatusItem' },
        { type: 'text', children: ' and ' },
        { type: 'text', children: 'kept ' },
        { type: 'text', children: 'it.' }
      ]
    })
  })
})

describe('lists', () => {
  test('an inside marker sits below the item top padding, on its first line', () => {
    const ul = jsxs('ul', {
      className: 'list-inside list-disc',
      children: [jsx('li', { className: 'py-1', children: 'one' }, 'a'), jsx('li', { children: 'two' }, 'b')]
    })
    const row = (marker: Shape['style'], item: Shape) => ({
      type: 'div',
      style: { display: 'flex', flexDirection: 'row', alignItems: 'flex-start' },
      children: [
        { type: 'text', style: marker, children: '•' },
        {
          type: 'div',
          style: { flexGrow: 1, flexShrink: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
          children: [item]
        }
      ]
    })
    expect(shape(ul)).toEqual({
      type: 'div',
      style: {},
      children: [
        row({ width: 16, flexShrink: 0, paddingTop: 4 }, { type: 'div', style: { paddingTop: 4, paddingBottom: 4 }, children: 'one' }),
        row({ width: 16, flexShrink: 0, paddingTop: 0 }, { type: 'div', style: {}, children: 'two' })
      ]
    })
  })
})

describe('translation cache', () => {
  test('one tag and class string translate once', () => {
    expect(translation('div', 'flex gap-2')).toBe(translation('div', 'flex gap-2'))
    expect(translation('span', 'flex gap-2')).not.toBe(translation('div', 'flex gap-2'))
    expect(translation('div', undefined)).toBe(translation('div', ''))
  })
})

describe('native ui text runs', () => {
  test('DiffStatCounts paints each count as one text node', () => {
    const counts = DiffStatCounts({ added: 3, removed: 1 }) as ReactElement<{ children: ReactNode[] }>
    const texts = counts.props.children.filter(isValidElement).map((child) => (child.props as { children: unknown }).children)
    expect(texts).toEqual(['+3', ' ', '−1'])
  })
})

describe('auto margins in a column', () => {
  const rail = (middle: string) =>
    jsxs('div', {
      className: 'flex h-full flex-col',
      children: [
        jsx('div', { className: middle, children: jsx('button', { className: 'size-9' }) }),
        jsx('div', { className: 'mt-auto flex flex-col', children: jsx('button', { className: 'size-9' }) })
      ]
    })
  const footer = (node: ReactNode) => (shape(node) as Shape).children?.[1] as Shape

  test('beside a flex-1 sibling the mt-auto footer does not grow, so the sibling keeps the free space', () => {
    expect(footer(rail('flex min-h-0 flex-1 flex-col'))).toMatchObject({
      type: 'div',
      style: { flexGrow: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }
    })
  })

  test('with no growing sibling the footer grows to push itself to the bottom', () => {
    expect(footer(rail('flex flex-col'))).toMatchObject({ style: { flexGrow: 1, justifyContent: 'flex-end' } })
  })
})

describe('divide-y', () => {
  test('a line follows every row but the last, in the divide colour', () => {
    const card = jsxs('div', {
      className: 'flex flex-col divide-y divide-border',
      children: [jsx('div', { className: 'h-8' }), false, jsx('div', { className: 'h-8' }), jsx('div', { className: 'h-8' })]
    })
    const line = { type: 'div', style: { height: 1, alignSelf: 'stretch', flexShrink: 0, backgroundColor: '#242526' } }
    const row = { type: 'div', style: { height: 32 } }
    const slots = (shape(card) as Shape).children as (Shape | string)[]
    const flat = slots.flatMap((slot): (Shape | string)[] =>
      typeof slot === 'string' ? ['empty'] : slot.type === String(Symbol.for('react.fragment')) ? (slot.children as Shape[]) : [slot]
    )
    expect(flat).toEqual([row, line, 'empty', row, line, row, 'null'])
  })
})
