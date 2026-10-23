/**
 * Vertical rhythm of a reply, from the web stylesheet. Streamdown lays a
 * reply out as sibling blocks in one block flow, where adjoining margins
 * collapse to the larger one. The native transcript paints each block as its
 * own element, so the collapsed gap is computed here.
 *
 * Margins are `.chat-streamdown` (index.css) at the 14px body size, plus the
 * Streamdown wrappers: a code block card is `my-4`, a table wrapper `my-1`
 * (`ChatMarkdownTable`).
 */

import type { BlockKind } from './prose-source'

export type FlowBlock = { kind: BlockKind | 'fence'; depth?: number }

const EM = 14

function margins(block: FlowBlock): [top: number, bottom: number] {
  switch (block.kind) {
    case 'paragraph':
    case 'other':
      return [0, 1.625 * EM]
    case 'heading': {
      const size = block.depth === 1 ? 1.08 * EM : EM
      return [0.75 * size, 0.3 * size]
    }
    case 'list':
    case 'blockquote':
    case 'code':
      return [0, 0.55 * EM]
    case 'table':
      return [4, 4]
    case 'rule':
      return [12.8, 12.8]
    case 'fence':
      return [16, 16]
  }
}

/** The gap between two neighbouring blocks: the larger of the two adjoining margins. */
export function flowGap(before: FlowBlock, after: FlowBlock): number {
  return Math.max(margins(before)[1], margins(after)[0])
}
