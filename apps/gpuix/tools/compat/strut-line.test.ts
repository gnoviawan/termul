import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { jsx } from '../../src/compat/jsx-runtime'
import { Label } from '../../src/ui/label'

type Props = { style?: Record<string, unknown>; children?: unknown }

/** A context provider (the font a `text-sm` element hands down) is not a slot. */
const isProvider = (node: unknown): node is ReactElement<Props> =>
  typeof node === 'object' && node !== null && typeof (node as ReactElement).type === 'object'

const kids = (element: unknown): ReactElement<Props>[] => {
  let children = (element as ReactElement<Props>).props.children
  while (isProvider(children)) children = children.props.children
  return (Array.isArray(children) ? children : [children]) as ReactElement<Props>[]
}
const lineOf = (slot: ReactElement<Props>) => slot.props.style?.minHeight

describe('an inline box alone on a line of a block container sits on the strut', () => {
  test("SettingsRow's label over its description gets the 16 px root's 24 px line", () => {
    const label = jsx(Label, { className: 'text-sm font-medium text-foreground', children: 'Sound' })
    const column = jsx('div', {
      className: 'min-w-0 flex-1',
      children: [label, jsx('p', { className: 'mt-0.5 text-xs leading-relaxed', children: 'Plays a sound.' })]
    })
    const [line, description] = kids(column)
    expect(lineOf(line)).toBe(24)
    expect(line.props.children).toBe(label)
    expect(lineOf(description)).toBeUndefined()
  })

  test('a lone label takes the line-height its container sets', () => {
    const [line] = kids(jsx('div', { className: 'text-sm', children: jsx(Label, { children: 'Name' }) }))
    expect(lineOf(line)).toBe(20)
  })

  test('a span between blocks is on its own line; a span next to text is not wrapped', () => {
    const between = kids(
      jsx('div', {
        children: [jsx('p', { children: 'a' }), jsx('span', { className: 'text-xs', children: 'b' }), jsx('p', { children: 'c' })]
      })
    )
    expect(between.map(lineOf)).toEqual([undefined, 24, undefined])
  })

  test('flex items and positioned boxes keep their own height', () => {
    const row = kids(jsx('div', { className: 'flex items-center gap-2', children: [jsx(Label, { children: 'On' }), jsx('p', { children: 'x' })] }))
    expect(row.map(lineOf)).toEqual([undefined, undefined])
    const positioned = kids(
      jsx('div', { className: 'relative', children: [jsx('span', { className: 'absolute right-0', children: 'x' }), jsx('p', { children: 'y' })] })
    )
    expect(positioned.map(lineOf)).toEqual([undefined, undefined])
  })
})
