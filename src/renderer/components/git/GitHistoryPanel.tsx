import type { GitCommit } from '@shared/types/ipc.types'
import { GitBranch, History, RefreshCw, Search, Tag } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { computeGraphLayout, type GraphLayout } from '@/lib/git-graph-layout'
import { describeRef } from '@/lib/git-ref'
import { formatRelativeTime } from '@/lib/git-time'
import { cn } from '@/lib/utils'
import { useGitHistoryStore } from '@/stores/git-history-store'

interface GitHistoryPanelProps {
  cwd: string
  isVisible: boolean
}

// Fixed row geometry so the SVG graph and the HTML rows line up exactly.
const ROW_HEIGHT = 30
const LANE_WIDTH = 16
const NODE_RADIUS = 4
const GRAPH_PADDING = 10

// Lane colors cycle through the project palette tokens (see index.css).
const LANE_COLORS = [
  'hsl(var(--project-blue))',
  'hsl(var(--project-green))',
  'hsl(var(--project-purple))',
  'hsl(var(--project-orange))',
  'hsl(var(--project-cyan))',
  'hsl(var(--project-pink))',
  'hsl(var(--project-yellow))',
  'hsl(var(--project-red))'
]

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length]
}

function laneX(lane: number): number {
  return GRAPH_PADDING + lane * LANE_WIDTH
}

function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2
}

/** Parse a raw `%D` decoration into a display label + kind for chip styling. */

export function GitHistoryPanel({ cwd, isVisible }: GitHistoryPanelProps): React.JSX.Element {
  const commits = useGitHistoryStore((state) => state.commits[cwd])
  const isLoading = useGitHistoryStore((state) => state.loading[cwd] ?? false)
  const error = useGitHistoryStore((state) => state.error[cwd] ?? null)
  const refreshLog = useGitHistoryStore((state) => state.refreshLog)

  const [searchQuery, setSearchQuery] = useState('')

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

  const graphWidth = GRAPH_PADDING * 2 + Math.max(1, layout.laneCount) * LANE_WIDTH
  const graphHeight = Math.max(1, layout.rows.length) * ROW_HEIGHT
  const isFiltering = searchQuery.trim().length > 0

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
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {commits === undefined && isLoading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <RefreshCw className="animate-spin mr-2" size={16} />
          Loading history...
        </div>
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
              <svg
                width={graphWidth}
                height={graphHeight}
                className="absolute left-0 top-0 pointer-events-none"
                aria-hidden="true"
              >
                {layout.rows.map((row) =>
                  row.parentEdges.map((edge) => {
                    const x1 = laneX(row.lane)
                    const y1 = rowY(row.row)
                    const x2 = laneX(edge.toLane)
                    // Parent row index drives the edge end; if the parent is
                    // outside the window, run the edge to the bottom edge.
                    const parentRow = rowByHash.get(edge.parentHash)
                    const y2 = parentRow !== undefined ? rowY(parentRow) : graphHeight
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
                    cx={laneX(row.lane)}
                    cy={rowY(row.row)}
                    r={NODE_RADIUS}
                    fill={laneColor(row.lane)}
                    stroke="hsl(var(--background))"
                    strokeWidth={1.5}
                  />
                ))}
              </svg>
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
                  <CommitRow key={commit.hash} commit={commit} />
                ))
              )}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

function CommitRow({ commit }: { commit: GitCommit }): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-3 pr-3 border-b border-border/40 hover:bg-secondary/40 transition-colors"
      style={{ height: ROW_HEIGHT }}
      title={`${commit.shortHash} — ${commit.subject}`}
    >
      <div className="flex items-center gap-1.5 shrink-0">
        {commit.refs.map((ref) => (
          <RefChip key={ref} raw={ref} />
        ))}
      </div>
      <span className="text-xs text-foreground truncate flex-1 min-w-0">{commit.subject}</span>
      <span className="text-[10px] text-muted-foreground truncate max-w-[120px] shrink-0">
        {commit.author}
      </span>
      <span className="text-[10px] text-muted-foreground/70 shrink-0 w-10 text-right">
        {formatRelativeTime(commit.date)}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground/60 shrink-0 w-14">
        {commit.shortHash}
      </span>
    </div>
  )
}

function RefChip({ raw }: { raw: string }): React.JSX.Element {
  const { label, kind } = describeRef(raw)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 h-4 rounded text-[9px] font-medium leading-none',
        kind === 'head' && 'bg-primary/15 text-primary',
        kind === 'tag' && 'bg-amber-500/15 text-amber-500',
        kind === 'remote' && 'bg-muted-foreground/15 text-muted-foreground',
        kind === 'branch' && 'bg-green-500/15 text-green-500'
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
