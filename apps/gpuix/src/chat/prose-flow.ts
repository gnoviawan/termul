/**
 * Vertical rhythm of a reply, from the web stylesheet. Streamdown lays a
 * reply out as sibling blocks in one block flow, where adjoining margins
 * collapse to the larger one. The native transcript paints each block as its
 * own element, so the collapsed gap is computed here.
 *
 * Two sources set the margins, and Tailwind's layer order decides between
 * them: `.chat-streamdown` rules (index.css, components layer) for blocks
 * Streamdown leaves unclassed (paragraphs, lists), and Streamdown's own
 * utility classes, which win, for headings (`mt-6 mb-2`), quotes (`my-4`),
 * rules (`my-6`), code cards (`my-4`) and `ChatMarkdownTable` (`my-1`).
 * Streamdown's root is `space-y-4`, a utility too: on every block but the
 * last it sets `margin-block: 0 1rem`, so the unclassed blocks' own
 * `.chat-streamdown` margins never apply (a `:where()` selector, so the
 * classed blocks' utilities still beat it). The components-layer
 * `:first-child` / `:last-child` resets only zero the unclassed blocks.
 */

import type { BlockKind } from './prose-source'

export type FlowBlock = { kind: BlockKind | 'fence'; depth?: number }

/** Streamdown's root `space-y-4`. */
const SPACE_Y = 16

function margins(block: FlowBlock): [top: number, bottom: number] {
  switch (block.kind) {
    case 'paragraph':
    case 'other':
    case 'list':
    case 'code':
      return [0, SPACE_Y]
    case 'heading':
      return [24, 8]
    case 'blockquote':
    case 'fence':
      return [16, 16]
    case 'table':
      return [4, 4]
    case 'rule':
      return [24, 24]
  }
}

/** Blocks Streamdown renders without utility margins: the edge resets reach them. */
const UNCLASSED: ReadonlySet<FlowBlock['kind']> = new Set(['paragraph', 'other', 'list', 'code'])

/** Margin before the first block of a reply. */
export function leadingMargin(first: FlowBlock): number {
  return UNCLASSED.has(first.kind) ? 0 : margins(first)[0]
}

/** Margin after the last block of a reply. */
export function trailingMargin(last: FlowBlock): number {
  return UNCLASSED.has(last.kind) ? 0 : margins(last)[1]
}

/** The gap between two neighbouring blocks: the larger of the two adjoining margins. */
export function flowGap(before: FlowBlock, after: FlowBlock): number {
  return Math.max(margins(before)[1], margins(after)[0])
}
