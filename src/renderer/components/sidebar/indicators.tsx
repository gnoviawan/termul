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
      className="mr-2 inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-xs font-medium tabular-nums text-warning transition-[transform,background-color] duration-150 ease-out hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      {label}
    </button>
  )
}

export function RunningMark(): React.JSX.Element {
  return (
    <span
      className="mr-2 shrink-0 text-xs text-muted-foreground"
      title="An agent chat is still running"
    >
      Running
    </span>
  )
}
