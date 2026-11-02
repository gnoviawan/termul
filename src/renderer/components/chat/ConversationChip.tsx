import { MessageSquare } from '@/components/icons'
import { cn } from '@/lib/utils'

interface ConversationChipProps {
  title: string
  className?: string
}

/**
 * Inline chip for a conversation @-mention, shared by the composer pill and
 * the timeline bubble. Same line-box metrics as `FileChip`/`SkillChip` so it
 * sits flush with the text around it; the primary tint tells it apart.
 */
export function ConversationChip({ title, className }: ConversationChipProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[1.3em] max-w-full items-center gap-1 rounded-md border border-primary/35 bg-primary/10 px-1 align-baseline leading-none',
        'text-inherit font-medium text-primary',
        className
      )}
    >
      <MessageSquare size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate" title={title}>
        {title}
      </span>
    </span>
  )
}
