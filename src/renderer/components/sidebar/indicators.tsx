import { needsYouLabel } from '@/lib/agent-chat-attention'

export function NeedsYouButton({
  count,
  onOpen
}: {
  count: number
  onOpen?: () => void
}): React.JSX.Element | null {
  if (count <= 0) return null
  const label = needsYouLabel(count)
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.()
      }}
      // #859: next to a long project name the badge text ("3 need you")
      // squeezed the name span to a single letter. The badge keeps its full
      // label for a11y/tooltip but truncates its own visible text under
      // pressure (min-w-0 truncate) instead of starving the name.
      className="mr-2 inline-flex h-6 min-w-0 max-w-24 shrink items-center justify-center rounded-md px-1.5 text-xs font-medium tabular-nums text-warning transition-[transform,background-color] duration-150 ease-out hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <span className="truncate">{label}</span>
    </button>
  )
}

export function RunningMark(): React.JSX.Element {
  return (
    <span
      // #859: shrink-0 starved the project name to a single letter when the
      // Running label and a needs-you badge stacked; let it shrink and clip
      // instead (tooltip keeps the full meaning).
      className="mr-2 min-w-0 shrink text-xs text-muted-foreground"
      title="An agent chat is still running"
    >
      <span className="truncate">Running</span>
    </span>
  )
}
