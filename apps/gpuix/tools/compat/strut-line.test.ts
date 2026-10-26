import { describe, expect, test } from 'bun:test'
import { createRoot, flushSync, type NativeRenderer, type StyleDesc } from '@gpuix/react'
import type { ReactElement } from 'react'
import { jsx } from '../../src/compat/jsx-runtime'
import { Label } from '../../src/ui/label'

/** The styles of the strut lines (centring column wrappers) the tree renders, in order. */
function strutStyles(element: ReactElement): StyleDesc[] {
  const styles: StyleDesc[] = []
  const tree = {
    applyBatch(json: string): number[] {
      for (const [kind, , style] of JSON.parse(json) as [string, number, StyleDesc][]) {
        if (kind === 'setStyle') styles.push(style)
      }
      return []
    }
  }
  const root = createRoot(tree as unknown as NativeRenderer)
  flushSync(() => root.render(element))
  root.unmount()
  return styles.filter((s) => s.justifyContent === 'center' && s.flexDirection === 'column' && typeof s.minHeight === 'number')
}

const strutLines = (element: ReactElement): number[] => strutStyles(element).map((s) => s.minHeight as number)

describe('an inline box alone on a line of a block container sits on the strut', () => {
  test("SettingsRow's label over its description gets the 16 px root's 24 px line", () => {
    const label = jsx(Label, { className: 'text-sm font-medium text-foreground', children: 'Sound' })
    const column = jsx('div', {
      className: 'min-w-0 flex-1',
      children: [label, jsx('p', { className: 'mt-0.5 text-xs leading-relaxed', children: 'Plays a sound.' })]
    })
    expect(strutLines(column)).toEqual([24])
  })

  test('a lone label takes the line-height its container sets', () => {
    expect(strutLines(jsx('div', { className: 'text-sm', children: jsx(Label, { children: 'Name' }) }))).toEqual([20])
  })

  test('a lone label in a container that sets none takes the line-height an ancestor sets (ssh New host fields)', () => {
    const field = jsx('div', { className: 'space-y-1.5', children: [jsx(Label, { className: 'text-xs', children: 'Address' }, 'l'), jsx('div', { className: 'flex h-9 w-full' }, 'i')] })
    expect(strutLines(jsx('div', { className: 'text-sm', children: field }))).toEqual([20])
  })

  test("space-y's margin under a lone label is ignored, as CSS ignores an inline box's block margins", () => {
    const field = jsx('div', { className: 'space-y-1.5', children: [jsx(Label, { children: 'Address' }, 'l'), jsx('div', { className: 'h-9' }, 'i')] })
    expect(strutStyles(field).map((s) => s.marginBottom)).toEqual([-6])
    const last = jsx('div', { className: 'space-y-1.5', children: [jsx('div', { className: 'h-9' }, 'i'), jsx(Label, { children: 'Note' }, 'l')] })
    expect(strutStyles(last).map((s) => s.marginBottom)).toEqual([undefined])
  })

  test('a span between blocks is on its own line; a span next to text is not wrapped', () => {
    const between = jsx('div', {
      children: [jsx('p', { children: 'a' }, 'a'), jsx('span', { className: 'text-xs', children: 'b' }, 'b'), jsx('p', { children: 'c' }, 'c')]
    })
    expect(strutLines(between)).toEqual([24])
    expect(strutLines(jsx('div', { children: ['x ', jsx('span', { className: 'text-xs', children: 'b' }, 'b')] }))).toEqual([])
  })

  test('flex items and positioned boxes keep their own height', () => {
    const row = jsx('div', {
      className: 'flex items-center gap-2',
      children: [jsx(Label, { children: 'On' }, 'l'), jsx('p', { children: 'x' }, 'p')]
    })
    expect(strutLines(row)).toEqual([])
    const positioned = jsx('div', {
      className: 'relative',
      children: [jsx('span', { className: 'absolute right-0', children: 'x' }, 's'), jsx('p', { children: 'y' }, 'p')]
    })
    expect(strutLines(positioned)).toEqual([])
  })
})
