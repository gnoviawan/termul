import { TerminalSquare, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CommandChipProps {
  name: string
  onRemove: () => void
  className?: string
}

/** Shows the active slash command above a prompt input as a chip. */
export function CommandChip({ name, onRemove, className }: CommandChipProps): React.JSX.Element {
  return (
    <div className={cn('flex items-start gap-2 border-b border-border/40 px-4 py-1.5', className)}>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        <TerminalSquare size={12} className="shrink-0" />
        <span className="font-medium text-foreground break-words">/{name}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="relative ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground @[400px]:size-10"
        aria-label={`Remove /${name} command`}
        title="Remove command"
      >
        <X size={12} />
      </button>
    </div>
  )
}
