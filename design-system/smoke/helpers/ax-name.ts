import type { CDPSession, Page } from 'playwright/test'

/**
 * Accessible names as Chrome computes them, read over CDP.
 *
 * Why not jsdom or Testing Library: their name computation ignores layout, so
 * they miss bugs that only a real renderer produces. #1512 shipped one: an
 * absolutely positioned `sr-only` span made Chrome insert a space, and the
 * selected row read "Claude 4.7 Opus Thinking , thinking High" while every
 * jsdom test passed. Ported from QA's `axname.cjs` harness for that bug.
 */

export interface AxNode {
  role: string
  name: string
  /** `aria-pressed="true"` (or a pressed toggle button). */
  pressed: boolean
  /** `data-canvas-item` id of the canvas entry that contains the node, or null for canvas chrome. */
  entryId: string | null
}

interface CdpAxNode {
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  properties?: { name: string; value: { value?: unknown } }[]
  backendDOMNodeId?: number
}

/** Finds the canvas entry that owns a DOM node. Runs in the page. */
function owningEntry(this: Element): string | null {
  return this.closest('[data-canvas-item]')?.getAttribute('data-canvas-item') ?? null
}

async function entryOf(cdp: CDPSession, backendNodeId: number): Promise<string | null> {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId })
  if (!object.objectId) return null
  try {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: owningEntry.toString(),
      returnByValue: true
    })
    return typeof result.value === 'string' ? result.value : null
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId })
  }
}

/**
 * Every non-ignored AX node with one of `roles` on the page, with the canvas
 * entry it sits in. Uses `Accessibility.getFullAXTree`, the same read as QA's harness.
 */
export async function readAxNodes(
  page: Page,
  roles: readonly string[] = ['button']
): Promise<AxNode[]> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('Accessibility.enable')
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: CdpAxNode[] }
    const wanted = nodes.filter((node) => !node.ignored && roles.includes(node.role?.value ?? ''))
    const out: AxNode[] = []
    for (const node of wanted) {
      out.push({
        role: node.role?.value ?? '',
        name: node.name?.value ?? '',
        pressed:
          node.properties?.some((p) => p.name === 'pressed' && p.value.value === 'true') ?? false,
        entryId:
          node.backendDOMNodeId === undefined ? null : await entryOf(cdp, node.backendDOMNodeId)
      })
    }
    return out
  } finally {
    await cdp.detach()
  }
}

/**
 * The Chrome-only bug from #1512: whitespace before any comma ('Opus ,High'
 * too), or before a period that ends a word (followed by whitespace or the
 * end). Not '.env', '...' or '.x'.
 */
export const SPACE_BEFORE_PUNCTUATION = /\s,|\s\.(?=\s|$)/

/** Names that read wrong to a screen reader. Empty when every name is clean. */
export function nameProblems(name: string): string[] {
  const problems: string[] = []
  if (SPACE_BEFORE_PUNCTUATION.test(name)) problems.push('space before comma or period')
  if (name !== name.trim()) problems.push('leading or trailing whitespace')
  return problems
}
