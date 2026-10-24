import { describe, expect, test } from 'bun:test'
import { bindCompatRenderer, nodeFor } from '../../src/compat/dom-node'
import { type Bounds, type CompatRenderer, liveReads, type TreeJson } from '../../src/compat/live-reads'

/** A renderer whose painted tree is a row (id 1) of three 100 px tabs scrolled 20 px. */
function fakeRenderer() {
  const calls = { bounds: 0, tree: 0, scroll: 0 }
  const boxes: Record<number, Bounds> = {
    1: { x: 10, y: 0, width: 250, height: 30 },
    2: { x: -10, y: 0, width: 100, height: 30 },
    3: { x: 90, y: 0, width: 100, height: 30 },
    4: { x: 190, y: 0, width: 100, height: 30 }
  }
  const node = (id: number, children?: TreeJson[]): TreeJson => ({ id, type: 'div', bounds: boxes[id], children })
  const renderer: CompatRenderer = {
    focusElement() {},
    getFocusedElementId: () => null,
    blur() {},
    scrollTo() {},
    scrollIntoView() {},
    getScrollOffset() {
      calls.scroll++
      return [-20, 0]
    },
    getElementBounds(id) {
      calls.bounds++
      return boxes[id] ?? null
    },
    getAutomationTree() {
      calls.tree++
      return JSON.stringify(node(0, [node(1, [node(2), node(3), node(4)]), { id: 9, type: 'div' }]))
    }
  }
  return { renderer, calls }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('live reads', () => {
  test('a box read twice in one task asks the renderer once, and again in the next task', async () => {
    const { renderer, calls } = fakeRenderer()
    const reads = liveReads(renderer)
    expect(reads.bounds(3)).toEqual({ x: 90, y: 0, width: 100, height: 30 })
    expect(reads.bounds(3)).toEqual({ x: 90, y: 0, width: 100, height: 30 })
    expect(calls.bounds).toBe(1)
    await nextTask()
    reads.bounds(3)
    expect(calls.bounds).toBe(2)
  })

  test('after a tree read every box comes from it; an unpainted element has none', () => {
    const { renderer, calls } = fakeRenderer()
    const reads = liveReads(renderer)
    expect(reads.tree().bounds.size).toBe(4)
    expect(reads.bounds(4)).toEqual({ x: 190, y: 0, width: 100, height: 30 })
    expect(reads.bounds(9)).toBeNull()
    expect(calls).toEqual({ bounds: 0, tree: 1, scroll: 0 })
  })

  test('invalidate drops the memo', () => {
    const { renderer, calls } = fakeRenderer()
    const reads = liveReads(renderer)
    reads.scrollOffset(1)
    reads.invalidate()
    reads.scrollOffset(1)
    expect(calls.scroll).toBe(2)
  })
})

describe('scroll size', () => {
  test("scrollWidth > clientWidth (WorkspaceTabBar's overflow check) costs one tree read and one scroll read", () => {
    const { renderer, calls } = fakeRenderer()
    bindCompatRenderer(renderer)
    try {
      const row = nodeFor(1)
      // Children extend from x -10 to 290 in a row at x 10, scrolled 20 px: 300 px of content in 250.
      expect(row.scrollWidth).toBe(300)
      expect(row.clientWidth).toBe(250)
      expect(calls).toEqual({ bounds: 0, tree: 1, scroll: 1 })
    } finally {
      bindCompatRenderer(null)
    }
  })
})
