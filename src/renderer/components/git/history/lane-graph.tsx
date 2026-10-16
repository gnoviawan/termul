import type React from 'react'
import { GitBranch, Tag } from '@/components/icons'
import type { GraphLayout } from '@/lib/git-graph-layout'
import { describeRef } from '@/lib/git-ref'
import { cn } from '@/lib/utils'

// Fixed row geometry so the SVG graph and the HTML rows line up exactly. One
// value feeds the lane/row coordinates, the svg size and the row height, so
// the graph and the rows can never drift apart on either shell.
export interface GraphGeometry {
  rowHeight: number
  laneWidth: number
  padding: number
  nodeRadius: number
}

/** Main-panel Git History table rows. */
export const DESKTOP_GRAPH_GEOMETRY: GraphGeometry = {
  rowHeight: 36,
  laneWidth: 16,
  padding: 12,
  nodeRadius: 4
}

// Phone rows are two lines at the 44px touch floor; narrower lanes keep a
// many-lane graph from eating the 390px viewport.
export const MOBILE_GRAPH_GEOMETRY: GraphGeometry = {
  rowHeight: 44,
  laneWidth: 12,
  padding: 8,
  nodeRadius: 4
}

// Lane colors cycle through the project palette tokens (see index.css).
const LANE_COLORS = [
  'oklch(var(--project-blue))',
  'oklch(var(--project-green))',
  'oklch(var(--project-purple))',
  'oklch(var(--project-orange))',
  'oklch(var(--project-cyan))',
  'oklch(var(--project-pink))',
  'oklch(var(--project-yellow))',
  'oklch(var(--project-red))'
]

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length]
}

function laneX(geometry: GraphGeometry, lane: number): number {
  return geometry.padding + lane * geometry.laneWidth
}

function rowY(geometry: GraphGeometry, row: number): number {
  return row * geometry.rowHeight + geometry.rowHeight / 2
}

/** Width of the graph column for a layout's lane count. */
export function graphColumnWidth(geometry: GraphGeometry, laneCount: number): number {
  return geometry.padding * 2 + Math.max(1, laneCount) * geometry.laneWidth
}

/** Height of the graph column: one row pitch per commit. */
export function graphColumnHeight(geometry: GraphGeometry, layout: GraphLayout): number {
  return Math.max(1, layout.rows.length) * geometry.rowHeight
}

/** Hash -> row index, so parent-edge endpoints are an O(1) lookup. */
export function rowIndexByHash(layout: GraphLayout): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of layout.rows) map.set(row.commit.hash, row.row)
  return map
}

/** SVG lane graph, pinned to the left and aligned row-for-row. Both shells draw
 * it; only the geometry differs. */
export function LaneGraph({
  layout,
  rowByHash,
  geometry,
  width,
  height
}: {
  layout: GraphLayout
  rowByHash: Map<string, number>
  geometry: GraphGeometry
  width: number
  height: number
}): React.JSX.Element {
  return (
    <svg
      width={width}
      height={height}
      className="absolute left-0 top-0 pointer-events-none"
      aria-hidden="true"
    >
      {layout.rows.map((row) =>
        row.parentEdges.map((edge) => {
          const x1 = laneX(geometry, row.lane)
          const y1 = rowY(geometry, row.row)
          const x2 = laneX(geometry, edge.toLane)
          // Parent row index drives the edge end; if the parent is
          // outside the window, run the edge to the bottom edge.
          const parentRow = rowByHash.get(edge.parentHash)
          const y2 = parentRow !== undefined ? rowY(geometry, parentRow) : height
          const color = laneColor(x1 === x2 ? row.lane : edge.toLane)
          // Straight segment for same-lane; gentle bend for lane changes.
          const d =
            x1 === x2
              ? `M ${x1} ${y1} L ${x2} ${y2}`
              : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`
          return (
            <path
              key={`${row.commit.hash}-${edge.parentHash}-${edge.toLane}`}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
            />
          )
        })
      )}
      {layout.rows.map((row) => (
        <circle
          key={row.commit.hash}
          cx={laneX(geometry, row.lane)}
          cy={rowY(geometry, row.row)}
          r={geometry.nodeRadius}
          fill={laneColor(row.lane)}
          stroke="oklch(var(--background))"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  )
}

/** One `%D` decoration as a chip: HEAD, branch, remote or tag. */
export function RefChip({ raw }: { raw: string }): React.JSX.Element {
  const { label, kind } = describeRef(raw)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 h-4 rounded text-4xs font-medium leading-none',
        kind === 'head' && 'bg-primary/15 text-primary',
        kind === 'tag' && 'bg-warning/15 text-warning',
        kind === 'remote' && 'bg-muted-foreground/15 text-muted-foreground',
        kind === 'branch' && 'bg-success/15 text-success'
      )}
    >
      {kind === 'tag' ? <Tag size={9} /> : <GitBranch size={9} />}
      {label}
    </span>
  )
}
