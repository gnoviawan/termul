/**
 * The renderer the DOM adapters query, with geometry reads memoized for the
 * current task. On Linux and Windows every GPUIX bounds read
 * (`getElementBounds`, `getAutomationTree`) asks the UI thread to paint a
 * frame and blocks until it has, and a scroll read is a round trip to it. A
 * DOM read is free by comparison, so shared code reads geometry freely:
 * WorkspaceTabBar's `scrollWidth > clientWidth` was one painted frame per tab
 * plus one for the tree (1 s of A1's startup profile).
 *
 * Within one task the layout a DOM read sees cannot change unless the task
 * changes it, and the same holds here: a memo lasts until the task ends (a
 * 0 ms timer), a mutation batch lands, or the compat layer scrolls. One tree
 * read answers the parent links and every painted box at once.
 *
 * Focus is not memoized: GPUIX-native code focuses through the renderer
 * directly, which a memo here would not see.
 */

import { appliedBatchCount } from '@gpuix/native/host'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CompatRenderer {
  focusElement(id: number): void
  getFocusedElementId(): number | null
  blur(): void
  scrollTo(id: number, x: number, y: number): void
  getScrollOffset(id: number): number[] | null
  scrollIntoView(id: number): void
  getElementBounds(id: number): Bounds | null
  getAutomationTree(): string
}

export interface TreeJson {
  id: number
  type: string
  bounds?: Bounds
  children?: (TreeJson | null)[]
}

export interface PaintedTree {
  readonly root: TreeJson | null
  /** Every painted element's box. An element missing here did not paint. */
  readonly bounds: ReadonlyMap<number, Bounds>
}

export interface LiveReads {
  readonly renderer: CompatRenderer
  bounds(id: number): Bounds | null
  scrollOffset(id: number): number[] | null
  /** The retained tree with the boxes of the last painted frame. */
  tree(): PaintedTree
  /** Drop the memo after a write that moves layout (scrolling). */
  invalidate(): void
}

function paintedTree(json: string): PaintedTree {
  const root = JSON.parse(json) as TreeJson | null
  const bounds = new Map<number, Bounds>()
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop() as TreeJson
    if (node.bounds) bounds.set(node.id, node.bounds)
    for (const child of node.children ?? []) if (child) stack.push(child)
  }
  return { root, bounds }
}

export function liveReads(renderer: CompatRenderer): LiveReads {
  let batch = -1
  let expiry: ReturnType<typeof setTimeout> | null = null
  let tree: PaintedTree | null = null
  const bounds = new Map<number, Bounds | null>()
  const scroll = new Map<number, number[] | null>()
  const invalidate = () => {
    tree = null
    bounds.clear()
    scroll.clear()
  }
  const fresh = () => {
    const now = appliedBatchCount()
    if (now !== batch) {
      invalidate()
      batch = now
    }
    expiry ??= setTimeout(() => {
      expiry = null
      invalidate()
    }, 0)
  }
  return {
    renderer,
    invalidate,
    bounds(id) {
      fresh()
      if (tree) return tree.bounds.get(id) ?? null
      let hit = bounds.get(id)
      if (hit === undefined) {
        hit = renderer.getElementBounds(id) ?? null
        bounds.set(id, hit)
      }
      return hit
    },
    scrollOffset(id) {
      fresh()
      let hit = scroll.get(id)
      if (hit === undefined) {
        hit = renderer.getScrollOffset(id) ?? null
        scroll.set(id, hit)
      }
      return hit
    },
    tree() {
      fresh()
      tree ??= paintedTree(renderer.getAutomationTree())
      return tree
    }
  }
}
