import { describe, expect, test } from 'bun:test'
import { createRoot, flushSync, type NativeRenderer, type StyleDesc } from '@gpuix/react'
import type { ReactElement } from 'react'
import { jsx, jsxs } from '../../src/compat/jsx-runtime'

/** The last style each native element was given, by its test id. */
class FakeTree {
  readonly styles = new Map<number, StyleDesc>()
  readonly ids = new Map<string, number>()
  applyBatch(json: string): number[] {
    for (const [kind, id, a, b] of JSON.parse(json) as [string, number, unknown, unknown][]) {
      if (kind === 'setStyle') this.styles.set(id, a as StyleDesc)
      if (kind === 'setCustomProp' && a === 'testId') this.ids.set(b as string, id)
    }
    return []
  }
  style(testId: string): StyleDesc {
    const id = this.ids.get(testId)
    expect(id).toBeDefined()
    return this.styles.get(id as number) ?? {}
  }
}

function render(element: ReactElement): FakeTree {
  const tree = new FakeTree()
  const root = createRoot(tree as unknown as NativeRenderer)
  flushSync(() => root.render(element))
  root.unmount()
  return tree
}

const hairline = (peerProps: Record<string, unknown>) =>
  jsxs('div', {
    className: 'flex flex-col',
    children: [
      jsx('button', { className: 'peer h-4', ...peerProps }),
      jsx('div', { className: 'h-2' }),
      jsx('div', {
        'data-testid': 'line',
        className: 'h-px opacity-100 peer-disabled:opacity-50 peer-data-[state=open]:h-1'
      })
    ]
  })

describe('peer-* rules read the nearest earlier peer sibling, as CSS ~ does', () => {
  test('a disabled peer applies peer-disabled: to a later sibling', () => {
    expect(render(hairline({ disabled: true })).style('line').opacity).toBe(0.5)
  })

  test('an enabled peer leaves it alone', () => {
    expect(render(hairline({})).style('line').opacity).toBe(1)
  })

  test("the peer's data attribute drives peer-data-[state=open]:", () => {
    expect(render(hairline({ 'data-state': 'open' })).style('line').height).toBe(4)
    expect(render(hairline({ 'data-state': 'closed' })).style('line').height).toBe(1)
  })

  test('an element before the peer is not its consumer', () => {
    const tree = render(
      jsxs('div', {
        children: [
          jsx('div', { 'data-testid': 'before', className: 'opacity-100 peer-disabled:opacity-50' }),
          jsx('button', { className: 'peer', disabled: true })
        ]
      })
    )
    expect(tree.style('before').opacity).toBe(1)
  })
})
