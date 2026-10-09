import type { GitCommit } from '@shared/types/ipc.types'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { GitBranch, History, RefreshCw, Search, Tag } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { PANEL_FIELD_CLASS, PANEL_FIELD_ICON_CLASS } from '@/components/ui/panel-styles'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { computeGraphLayout, type GraphLayout } from '@/lib/git-graph-layout'
import { describeRef } from '@/lib/git-ref'
import { formatRelativeTime } from '@/lib/git-time'
import { cn } from '@/lib/utils'
import { useGitHistoryStore } from '@/stores/git-history-store'

interface GitHistoryPanelProps {
  cwd: string
  isVisible: boolean
}

// Fixed row geometry so the SVG graph and the HTML rows line up exactly. One
// value feeds the lane/row coordinates, the svg size and the row height, so
// the graph and the rows can never drift apart on either shell.
interface GraphGeometry {
  rowHeight: number
  laneWidth: number
  padding: number
  nodeRadius: number
}

const DESKTOP_GRAPH_GEOMETRY: GraphGeometry = {
  rowHeight: 30,
  laneWidth: 16,
  padding: 10,
  nodeRadius: 4
}

// Phone rows are two lines at the 44px touch floor; narrower lanes keep a
// many-lane graph from eating the 390px viewport.
const MOBILE_GRAPH_GEOMETRY: GraphGeometry = {
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

/** Parse a raw `%D` decoration into a display label + kind for chip styling. */

export function GitHistoryPanel({ cwd, isVisible }: GitHistoryPanelProps): React.JSX.Element {
  const commits = useGitHistoryStore((state) => state.commits[cwd])
  const isLoading = useGitHistoryStore((state) => state.loading[cwd] ?? false)
  const error = useGitHistoryStore((state) => state.error[cwd] ?? null)
  const refreshLog = useGitHistoryStore((state) => state.refreshLog)

  const [searchQuery, setSearchQuery] = useState('')
  const isMobileWebShell = useMobileWebShell()

  useEffect(() => {
    // Fetch on first reveal (or when no data yet) and on cwd change.
    if (isVisible && commits === undefined) {
      void refreshLog(cwd)
    }
  }, [isVisible, cwd, commits, refreshLog])

  const filteredCommits = useMemo(() => {
    const list = commits ?? []
    if (!searchQuery.trim()) return list
    const q = searchQuery.toLowerCase()
    return list.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.shortHash.toLowerCase().includes(q) ||
        c.hash.toLowerCase().includes(q) ||
        c.refs.some((r) => r.toLowerCase().includes(q))
    )
  }, [commits, searchQuery])

  // The lane graph reflects true topology, so it is computed from the full
  // commit list, not the filtered view. Filtering only affects the row list.
  const layout: GraphLayout = useMemo(() => computeGraphLayout(commits ?? []), [commits])
  // Hash -> row index, so parent-edge endpoints are an O(1) lookup instead of
  // an O(n) scan per edge inside the render loop.
  const rowByHash = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of layout.rows) map.set(row.commit.hash, row.row)
    return map
  }, [layout])

  const geometry = isMobileWebShell ? MOBILE_GRAPH_GEOMETRY : DESKTOP_GRAPH_GEOMETRY
  const graphWidth = geometry.padding * 2 + Math.max(1, layout.laneCount) * geometry.laneWidth
  const graphHeight = Math.max(1, layout.rows.length) * geometry.rowHeight
  const isFiltering = searchQuery.trim().length > 0

  // Mobile web shell (phone): two-line 44px rows, a full-width 16px filter
  // field on its own row, a 44px refresh and a plain scroll container. Every
  // hook above runs on both shells; only the layout JSX differs. The desktop
  // return below renders the same DOM as before; it only shares LaneGraph,
  // LoadingState and the geometry values with this branch.
  if (isMobileWebShell) {
    return (
      <div className="flex h-full w-full flex-col bg-background overflow-hidden">
        <div className="p-3 border-b border-border flex flex-col gap-1 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <History size={15} className="text-primary" />
              Git History
            </div>
            <Button
              variant="ghost"
              size="touch"
              className="w-11"
              onClick={() => refreshLog(cwd)}
              disabled={isLoading}
              title="Refresh history"
              aria-label="Refresh history"
            >
              {isLoading ? <Spinner size={16} decorative /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
          <div className="relative">
            <Search size={14} aria-hidden className={PANEL_FIELD_ICON_CLASS} />
            <input
              type="text"
              placeholder="Filter commits..."
              aria-label="Filter commits"
              className={cn(PANEL_FIELD_CLASS, 'h-11 w-full pl-9 pr-3 text-base')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {commits === undefined && isLoading ? (
          <LoadingState />
        ) : (commits?.length ?? 0) === 0 ? (
          <EmptyState error={error} />
        ) : (
          <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
            <div className="relative" style={{ minHeight: isFiltering ? undefined : graphHeight }}>
              {!isFiltering && (
                <LaneGraph
                  layout={layout}
                  rowByHash={rowByHash}
                  geometry={geometry}
                  width={graphWidth}
                  height={graphHeight}
                />
              )}

              {/* Unfiltered rows clear the graph column; while filtering the
                 graph is hidden, so rows run full width with a left inset. */}
              <div
                className={isFiltering ? 'pl-3' : undefined}
                style={{ paddingLeft: isFiltering ? undefined : graphWidth }}
              >
                {isFiltering && filteredCommits.length === 0 ? (
                  <div className="break-words px-4 py-8 text-center text-sm text-muted-foreground">
                    No commits match "{searchQuery}"
                  </div>
                ) : (
                  (isFiltering ? filteredCommits : layout.rows.map((r) => r.commit)).map(
                    (commit) => (
                      <MobileCommitRow
                        key={commit.hash}
                        commit={commit}
                        rowHeight={geometry.rowHeight}
                      />
                    )
                  )
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col bg-background overflow-hidden">
      <div className="p-3 border-b border-border flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <History size={15} className="text-primary" />
          Git History
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={14}
            />
            <input
              type="text"
              placeholder="Filter commits..."
              aria-label="Filter commits"
              className="w-44 bg-secondary/50 border-none rounded-md py-1.5 pl-8 pr-3 text-xs focus:ring-1 focus:ring-primary outline-none"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => refreshLog(cwd)}
            disabled={isLoading}
            title="Refresh history"
            aria-label="Refresh history"
          >
            {isLoading ? <Spinner size={16} decorative /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {commits === undefined && isLoading ? (
        <LoadingState />
      ) : (commits?.length ?? 0) === 0 ? (
        <EmptyState error={error} />
      ) : (
        <ScrollArea className="flex-1">
          <div className="relative" style={{ minHeight: isFiltering ? undefined : graphHeight }}>
            {/* SVG lane graph, pinned to the left, aligned row-for-row. The
               graph reflects the full contiguous topology, so it is only drawn
               in the unfiltered view; a filtered subset cannot show meaningful
               branch/merge lanes. */}
            {!isFiltering && (
              <LaneGraph
                layout={layout}
                rowByHash={rowByHash}
                geometry={geometry}
                width={graphWidth}
                height={graphHeight}
              />
            )}

            {/* Commit rows. In the unfiltered view they are offset right to
               clear the graph column; while filtering, the graph is hidden so
               rows use the full width. */}
            <div style={{ paddingLeft: isFiltering ? undefined : graphWidth }}>
              {isFiltering && filteredCommits.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No commits match "{searchQuery}"
                </div>
              ) : (
                (isFiltering ? filteredCommits : layout.rows.map((r) => r.commit)).map((commit) => (
                  <CommitRow key={commit.hash} commit={commit} rowHeight={geometry.rowHeight} />
                ))
              )}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

/** SVG lane graph, pinned to the left and aligned row-for-row. Both shells draw
 * it; only the geometry differs. */
function LaneGraph({
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

function LoadingState(): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <Spinner size={16} decorative className="mr-2" />
      Loading history...
    </div>
  )
}

function CommitRow({
  commit,
  rowHeight
}: {
  commit: GitCommit
  rowHeight: number
}): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-3 pr-3 border-b border-border/40 hover:bg-secondary/40 transition-colors"
      style={{ height: rowHeight }}
      title={`${commit.shortHash} — ${commit.subject}`}
    >
      <div className="flex items-center gap-1.5 shrink-0">
        {commit.refs.map((ref) => (
          <RefChip key={ref} raw={ref} />
        ))}
      </div>
      <span className="text-xs text-foreground truncate flex-1 min-w-0">{commit.subject}</span>
      <span className="text-3xs text-muted-foreground truncate max-w-[120px] shrink-0">
        {commit.author}
      </span>
      <span className="text-3xs tabular-nums text-muted-foreground/70 shrink-0 w-10 text-right">
        {formatRelativeTime(commit.date)}
      </span>
      <span className="font-mono text-3xs text-muted-foreground/60 shrink-0 w-14">
        {commit.shortHash}
      </span>
    </div>
  )
}

/** Phone row: subject over a meta line (refs, author, time, short hash), at the
 * 44px touch pitch the lane graph aligns to. Every line is single-line; time and
 * hash never shrink, the subject and author truncate, refs clip at half the line
 * and, on a very narrow line, shrink before the time or hash is ever cut. */
function MobileCommitRow({
  commit,
  rowHeight
}: {
  commit: GitCommit
  rowHeight: number
}): React.JSX.Element {
  return (
    <div
      className="flex flex-col justify-center overflow-hidden pr-3 border-b border-border/40"
      style={{ height: rowHeight }}
      title={`${commit.shortHash} — ${commit.subject}`}
    >
      {/* min-h-5 keeps the line's 20px when the subject is empty (an
         --allow-empty-message commit), so the meta line stays put. */}
      <div className="min-h-5 min-w-0 truncate text-sm leading-5 text-foreground">
        {commit.subject}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
        {commit.refs.length > 0 && (
          <div className="flex min-w-0 max-w-[50%] items-center gap-1.5 overflow-hidden whitespace-nowrap [&>*]:shrink-0">
            {commit.refs.map((ref) => (
              <RefChip key={ref} raw={ref} />
            ))}
          </div>
        )}
        <span className="min-w-0 flex-1 truncate">{commit.author}</span>
        <span className="shrink-0 tabular-nums">{formatRelativeTime(commit.date)}</span>
        <span className="shrink-0 font-mono">{commit.shortHash}</span>
      </div>
    </div>
  )
}

function RefChip({ raw }: { raw: string }): React.JSX.Element {
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

function EmptyState({ error }: { error: string | null }): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
      <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4 text-muted-foreground/50">
        <History size={24} />
      </div>
      <h3 className="text-sm font-medium text-foreground mb-1">No commit history</h3>
      <p className="text-xs max-w-[260px]">
        {error
          ? 'This folder may not be a Git repository, or git is unavailable.'
          : 'There are no commits to show yet. Make your first commit to see it here.'}
      </p>
    </div>
  )
}
