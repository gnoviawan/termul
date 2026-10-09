import { AlertTriangle, Folder } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { treeRowPaddingLeft } from './explorer-inline-input'

/** 32px bordered glyph tile above an empty / error title. */
function GlyphTile({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-card">
      {children}
    </span>
  )
}

export function ExplorerNoProject(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <GlyphTile>
        <Folder size={16} className="text-muted-foreground" />
      </GlyphTile>
      <p className="text-xs font-medium text-foreground">No project open</p>
      <p className="text-2xs text-muted-foreground">Pick a project on the left to see its files.</p>
    </div>
  )
}

/** Fixed skeleton shape: [depth, bar width in px]. */
const SKELETON_ROWS: Array<[number, number]> = [
  [0, 72],
  [0, 96],
  [1, 84],
  [1, 120],
  [1, 64],
  [0, 88],
  [0, 110],
  [0, 76]
]

export function ExplorerLoading(): React.JSX.Element {
  return (
    <div role="status" aria-live="polite" className="px-2">
      <span className="sr-only">Loading files…</span>
      {SKELETON_ROWS.map(([depth, width], index) => (
        <div
          key={index}
          aria-hidden
          className="flex h-7 items-center gap-1.5"
          style={{ paddingLeft: treeRowPaddingLeft(depth) + 16 }}
        >
          <span className="size-3.5 shrink-0 animate-pulse rounded-sm bg-foreground/[0.06]" />
          <span className="h-2 animate-pulse rounded-full bg-foreground/[0.06]" style={{ width }} />
        </div>
      ))}
    </div>
  )
}

interface ExplorerErrorProps {
  message: string
  onRetry: () => void
}

export function ExplorerError({ message, onRetry }: ExplorerErrorProps): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <GlyphTile>
        <AlertTriangle size={16} className="text-destructive" />
      </GlyphTile>
      <p className="text-xs font-medium text-foreground">Couldn’t read this folder</p>
      <p className="break-words text-2xs text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          'mt-1 h-7 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors duration-150 ease-out',
          'hover:bg-foreground/[0.03]',
          FOCUS_RING_CLASS
        )}
      >
        Try again
      </button>
    </div>
  )
}
