/**
 * A grid whose column template GPUIX cannot draw (`grid-cols-[1fr_6rem]`;
 * GPUIX takes only a count of equal tracks, gpuix#103) becomes a column of
 * flex rows, one cell per track. A fixed track is a cell of that width, an
 * `fr` track grows by its share of what the fixed tracks and gaps leave, and
 * a content track (auto, max-content) is as wide as its cell's content. Every
 * row spans the grid, so fixed and `fr` columns line up from row to row; a
 * content track is sized per row.
 *
 * Items are placed in order, as CSS auto-placement does. A grid whose items
 * place themselves (`col-span-2`, `row-start-1`) is left to the native grid
 * (`placedGrid`): the patched addon draws its track list and places its items
 * (gpuix/0016 spans, gpuix/0019 tracks and starts); the published addon
 * ignores both and draws equal tracks.
 */

import type { StyleDesc } from '@gpuix/react'
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { jsx } from 'react/jsx-runtime'
import type { GridTrack } from '../style/grid-tracks'
import { childInfo } from './children'

const EXPLICIT_PLACEMENT = /(^|\s|:)(col-(span|start|end)-|row-(span|start|end)-)/

const ALIGN: Readonly<Record<string, StyleDesc['alignItems']>> = {
  start: 'flex-start',
  'flex-start': 'flex-start',
  end: 'flex-end',
  'flex-end': 'flex-end',
  center: 'center',
  baseline: 'baseline'
}

function cellStyle(track: GridTrack): StyleDesc {
  if (track.kind === 'fixed') return { width: track.px, flexShrink: 0, display: 'flex', flexDirection: 'column' }
  if (track.kind === 'fr') {
    return { flexGrow: track.fr, flexShrink: 1, flexBasis: 0, minWidth: track.min, display: 'flex', flexDirection: 'column' }
  }
  return { flexShrink: 0, display: 'flex', flexDirection: 'column' }
}

/** The grid's own style minus what only CSS grid understands. */
function withoutTracks(style: StyleDesc): StyleDesc {
  const { gridTracks: _tracks, ...rest } = style
  return rest
}

/** The grid's style for the native grid: its track list instead of the compat-only `gridTracks`. */
export function placedGrid(style: StyleDesc, tracks: readonly GridTrack[]): StyleDesc {
  return { ...withoutTracks(style), gridColumnTracks: tracks }
}

export interface GridLayout {
  style: StyleDesc
  children: ReactElement[]
}

/**
 * Rows of cells for `children`, or null when an item places itself.
 * `classNameOf` answers a compat element's DOM class string.
 */
export function gridLayout(
  style: StyleDesc,
  tracks: readonly GridTrack[],
  children: ReactNode,
  classNameOf: (node: ReactElement) => string | undefined
): GridLayout | null {
  const items: { node: ReactElement; key: string }[] = []
  const positioned: ReactElement[] = []
  // Not Children.toArray: it clones, and the clones miss the childInfo and
  // domSource entries of the elements shared code made.
  const visit = (node: ReactNode, path: string): boolean => {
    if (node === null || node === undefined || typeof node === 'boolean') return true
    if (Array.isArray(node)) return node.every((child, i) => visit(child, `${path}.${i}`))
    if (!isValidElement(node)) {
      items.push({ node: jsx('text', { children: String(node) }), key: path })
      return true
    }
    if (EXPLICIT_PLACEMENT.test(classNameOf(node) ?? '')) return false
    if (childInfo.get(node)?.positioned) positioned.push(node)
    else items.push({ node, key: node.key === null ? path : `${path}$${node.key}` })
    return true
  }
  if (!visit(children, '')) return null

  const { gridTemplateColumns: _count, gridTemplateRows: _rows, gap, rowGap, columnGap, alignItems, ...rest } = withoutTracks(style)
  const align = alignItems === undefined || alignItems === 'stretch' ? undefined : ALIGN[alignItems]
  const rowStyle: StyleDesc = {
    display: 'flex',
    flexDirection: 'row',
    columnGap: columnGap ?? gap,
    ...(align ? { alignItems: align } : {})
  }
  const cells = tracks.map(cellStyle)
  const rows: ReactElement[] = []
  for (let start = 0; start < items.length; start += tracks.length) {
    const row = tracks.map((_, column) => {
      const slot = items[start + column]
      if (!slot) return jsx('div', { style: cells[column] }, `$pad${column}`)
      const item = slot.node
      // A grid item stretches to its row's height unless the grid aligns it.
      const content =
        align === undefined && typeof item.type === 'string'
          ? cloneElement(item as ReactElement<{ style?: StyleDesc }>, {
              style: { ...(item.props as { style?: StyleDesc }).style, flexGrow: 1 }
            })
          : item
      return jsx('div', { style: cells[column], children: content }, slot.key)
    })
    const element = jsx('div', { style: rowStyle, children: row }, `$row${start / tracks.length}`)
    childInfo.set(element, { inline: false })
    rows.push(element)
  }
  return {
    style: { ...rest, display: 'flex', flexDirection: 'column', rowGap: rowGap ?? gap },
    children: [...rows, ...positioned]
  }
}
