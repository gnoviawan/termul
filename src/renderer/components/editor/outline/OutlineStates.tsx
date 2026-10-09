import { List } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

/** Fixed widths and indents so the list does not jump when headings parse. */
const SKELETON_ROWS = [
  { indent: 0, width: 96 },
  { indent: 12, width: 72 },
  { indent: 24, width: 56 },
  { indent: 24, width: 56 },
  { indent: 12, width: 84 },
  { indent: 24, width: 60 }
] as const

export function OutlineSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading outline" className="px-2 pb-2">
      {SKELETON_ROWS.map((row, index) => (
        <div key={index} className="flex h-7 items-center" style={{ paddingLeft: 22 + row.indent }}>
          <span
            className="h-1.5 rounded-full bg-muted animate-pulse motion-reduce:animate-none"
            style={{ width: row.width }}
          />
        </div>
      ))}
    </div>
  )
}

function GlyphTile({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="flex size-8 items-center justify-center rounded-lg border border-border text-xs font-medium text-muted-foreground"
    >
      {children}
    </div>
  )
}

export function OutlineEmpty(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-4 pt-6 text-center">
      <GlyphTile>H</GlyphTile>
      <p className="text-xs font-medium text-foreground">No headings yet</p>
      <p className="text-2xs text-muted-foreground">Start a line with # and it shows up here.</p>
    </div>
  )
}

interface OutlineHiddenProps {
  hiddenCount: number
  maxHeadingLevel: number
  onShowAll: () => void
}

export function OutlineHidden({
  hiddenCount,
  maxHeadingLevel,
  onShowAll
}: OutlineHiddenProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-4 pt-6 text-center">
      <GlyphTile>
        <List size={14} />
      </GlyphTile>
      <p className="text-xs font-medium text-foreground tabular-nums">
        {hiddenCount === 1 ? '1 heading is hidden' : `${hiddenCount} headings are hidden`}
      </p>
      <p className="text-2xs text-muted-foreground">{`They are H${maxHeadingLevel + 1} and deeper.`}</p>
      <button
        type="button"
        onClick={onShowAll}
        className={cn(
          'mt-1 flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03]',
          FOCUS_RING_CLASS
        )}
      >
        Show to H6
      </button>
    </div>
  )
}
