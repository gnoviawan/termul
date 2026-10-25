import type { TreeNode } from '@gpuix/native/automation'

/**
 * What one GPUIX frame builds, read off the automation tree. GPUI builds and
 * lays out every element reachable from the window root on every frame,
 * except a `virtual-list`'s rows outside its window. A subtree with no
 * painted box at all is therefore either culled by its list or built,
 * laid out and then not drawn (`visibility: hidden`).
 */
export interface TreeCensus {
  /** Elements reachable from the root. */
  reachable: number
  /** Elements with a painted box in the last frame. */
  painted: number
  /** Unpainted elements under a `virtual-list`: not built. */
  listCulled: number
  /** Unpainted elements anywhere else: built every frame, never drawn. */
  hidden: number
  /** The largest hidden subtrees, with test ids and text to tell what they are. */
  topHidden: Array<{ size: number; type: string; testIds: string[]; text: string }>
  /**
   * The heaviest chain from the root: each step is the child holding most of
   * its parent's elements, down to the first node whose elements spread over
   * its children. That node is what dominates the per-frame build.
   */
  heaviest: Array<{ size: number; type: string; children: number; testId?: string; text: string }>
}

interface Counted {
  node: TreeNode
  size: number
  painted: number
  children: Counted[]
}

function count(node: TreeNode): Counted {
  const children = (node.children ?? []).map(count)
  let size = 1
  let painted = node.bounds ? 1 : 0
  for (const child of children) {
    size += child.size
    painted += child.painted
  }
  return { node, size, painted, children }
}

function sample(root: Counted): { testIds: string[]; text: string } {
  const testIds: string[] = []
  let text = ''
  const visit = (c: Counted) => {
    if (c.node.testId && testIds.length < 4) testIds.push(c.node.testId)
    if (c.node.text && text.length < 60) text += `${c.node.text} `
    for (const child of c.children) visit(child)
  }
  visit(root)
  return { testIds, text: text.trim().slice(0, 60) }
}

export function treeCensus(tree: TreeNode | null, top = 6): TreeCensus {
  const out: TreeCensus = { reachable: 0, painted: 0, listCulled: 0, hidden: 0, topHidden: [], heaviest: [] }
  if (!tree) return out
  const root = count(tree)
  out.reachable = root.size
  out.painted = root.painted
  const hidden: Counted[] = []
  const visit = (c: Counted, parentType: string | null) => {
    if (c.painted === 0) {
      if (parentType === 'virtual-list') out.listCulled += c.size
      else {
        out.hidden += c.size
        hidden.push(c)
      }
      return
    }
    for (const child of c.children) visit(child, c.node.type)
  }
  visit(root, null)
  out.topHidden = hidden
    .sort((a, b) => b.size - a.size)
    .slice(0, top)
    .map((c) => ({ size: c.size, type: c.node.type, ...sample(c) }))
  for (let at: Counted | undefined = root; at; ) {
    const largest: Counted | undefined = at.children.reduce<Counted | undefined>((a, b) => (a && a.size >= b.size ? a : b), undefined)
    const step = { size: at.size, type: at.node.type, children: at.children.length, text: sample(at).text }
    out.heaviest.push(at.node.testId ? { ...step, testId: at.node.testId } : step)
    at = largest && largest.size * 2 >= at.size ? largest : undefined
  }
  return out
}
