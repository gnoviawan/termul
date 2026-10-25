import { describe, expect, test } from 'bun:test'
import type { EventPayload } from '@gpuix/react'
import { createRoot, flushSync, type NativeRenderer, type StyleDesc } from '@gpuix/react'
import { jsx } from '../../src/compat/jsx-runtime'
import { layoutListener } from '../../src/compat/resize'

/** The last style each native element was given. */
class FakeTree {
  readonly styles = new Map<number, StyleDesc>()
  applyBatch(json: string): number[] {
    for (const [kind, id, style] of JSON.parse(json) as [string, number, unknown][]) {
      if (kind === 'setStyle') this.styles.set(id, style as StyleDesc)
    }
    return []
  }
  /** The newest element whose style matches: the card, or the row inside it. */
  newest(match: (style: StyleDesc) => boolean): [number, StyleDesc] {
    const id = Math.max(...[...this.styles].filter(([, s]) => match(s)).map(([id]) => id))
    return [id, this.styles.get(id) as StyleDesc]
  }
}

const card = () =>
  jsx('div', {
    className: '@container w-full',
    children: jsx('div', { className: 'flex flex-col @[35rem]:flex-row gap-2', children: 'Close idle chats after' })
  })
const isCard = (style: StyleDesc) => style.width === '100%'
const isRow = (style: StyleDesc) => style.display === 'flex'

describe('container queries across a remount', () => {
  test('a remounted container keeps the width it last measured instead of laying out narrow', () => {
    const tree = new FakeTree()
    const root = createRoot(tree as unknown as NativeRenderer)
    flushSync(() => root.render(card()))
    const [first] = tree.newest(isCard)
    expect(tree.newest(isRow)[1].flexDirection).toBe('column')

    flushSync(() =>
      layoutListener({ elementId: first, eventType: 'layout', x: 0, y: 0, width: 624, height: 80 } as EventPayload)
    )
    expect(tree.newest(isRow)[1].flexDirection).toBe('row')

    flushSync(() => root.render(null))
    flushSync(() => root.render(card()))
    expect(tree.newest(isCard)[0]).not.toBe(first)
    expect(tree.newest(isRow)[1].flexDirection).toBe('row')
    root.unmount()
  })
})
