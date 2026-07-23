import { Paperclip } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface AttachFilesButtonProps {
  onClick: () => void
  disabled?: boolean
  className?: string
}

/**
 * Paperclip control for composer / agent launcher. Radix tooltip (shared
 * fade-blur motion) — not native `title`, so hover matches chat action tips.
 */
export function AttachFilesButton({
  onClick,
  disabled = false,
  className
}: AttachFilesButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label="Attach files"
          className={cn(
            'flex size-8 items-center justify-center text-muted-foreground transition-colors',
            'hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
        >
          <Paperclip size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Attach files</TooltipContent>
    </Tooltip>
  )
}
