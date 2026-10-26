import { describe, expect, test } from 'bun:test'
import { createRoot, flushSync, type NativeRenderer, type StyleDesc } from '@gpuix/react'
import type { ReactElement } from 'react'
import { jsx } from '../../src/compat/jsx-runtime'

/** The last style each native element was given. */
class FakeTree {
  readonly styles = new Map<number, StyleDesc>()
  applyBatch(json: string): number[] {
    for (const [kind, id, style] of JSON.parse(json) as [string, number, unknown][]) {
      if (kind === 'setStyle') this.styles.set(id, style as StyleDesc)
    }
    return []
  }
  find(match: (style: StyleDesc) => boolean): StyleDesc {
    const found = [...this.styles.values()].filter(match)
    expect(found).toHaveLength(1)
    return found[0] as StyleDesc
  }
}

function render(element: ReactElement): FakeTree {
  const tree = new FakeTree()
  const root = createRoot(tree as unknown as NativeRenderer)
  flushSync(() => root.render(element))
  root.unmount()
  return tree
}

const badge = (parent: string) =>
  jsx('div', {
    className: parent,
    children: jsx('span', {
      className: 'rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-semibold tabular-nums',
      children: '1'
    })
  })
const isBadge = (style: StyleDesc) => style.borderRadius === 9999

describe('a font half the classes leave out is inherited, as in CSS', () => {
  test("ChatChangedFilesPanel's count badge under text-xs takes text-xs's ratio: 16 px", () => {
    expect(render(badge('flex items-center gap-2 text-xs')).find(isBadge).lineHeight).toBe(16)
  })

  test('the same badge under text-sm: 12 px times 20/14', () => {
    expect(render(badge('flex text-sm')).find(isBadge).lineHeight).toBe(17.14)
  })

  test('with no sized ancestor it takes the root 1.5: 18 px', () => {
    expect(render(badge('flex')).find(isBadge).lineHeight).toBe(18)
  })

  test('a px line height is inherited as px', () => {
    expect(render(badge('flex text-sm leading-5')).find(isBadge).lineHeight).toBe(20)
  })

  test('leading-none without a size multiplies the inherited size', () => {
    const tree = render(
      jsx('div', {
        className: 'flex text-xs',
        children: jsx('div', { className: 'truncate leading-none border', children: 'main' })
      })
    )
    expect(tree.find((style) => style.borderWidth === 1).lineHeight).toBe(12)
  })

  test('a size-only element passes the inherited ratio on to its children', () => {
    const tree = render(
      jsx('div', {
        className: 'flex text-xs',
        children: jsx('div', {
          className: 'flex text-2xs',
          children: jsx('div', { className: 'leading-none border', children: 'x' })
        })
      })
    )
    expect(tree.find((style) => style.borderWidth === 1).lineHeight).toBe(12)
  })
})
