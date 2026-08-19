import { Paperclip } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRuntimeTranslation } from '@/i18n/use-runtime-translation'
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
  const t = useRuntimeTranslation('chat')
  const label = t('composer.attachFiles', 'Attach files')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            'relative flex size-8 items-center justify-center text-muted-foreground transition-colors',
            // Expand hit to ~44×44 without growing toolbar chrome.
            "after:absolute after:-inset-1.5 after:content-['']",
            'hover:text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/50',
            className
          )}
        >
          <Paperclip size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
