import { File } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FileChipProps {
  name: string
  className?: string
}

/**
 * Muted inline pill for a file @-mention. Sibling of `SkillChip.tsx` — same
 * inline metrics (`inline-flex items-center align-baseline leading-none
 * h-[1.1em]`, `px-2`, `font-medium`, `rounded-md`, `max-w-[40ch] truncate`) so
 * a file pill occupies exactly one line box and stays caret-aligned with the
 * surrounding text in the Tiptap editor (the pill is a real inline DOM node,
 * same as `SkillChip`). The visual treatment is distinct from `SkillChip`
 * (which uses `Sparkles` + accent `text-primary`): a muted
 * `border-border/60 bg-muted/60 text-muted-foreground` with a `File` lucide
 * icon so a file pill and a skill pill are distinguishable at a glance when
 * both are inline together.
 *
 * Always non-interactive by construction: there is no `onRemove` or any other
 * interactive/removal prop. In the composer, Backspace removes a chip via the
 * token model (`removeFileTokenBeforeCaret`), not an X button; in the timeline
 * the chip is a static pill. Callers (`FilePillNode`, `ChatMessage`) pass only
 * `name` (plus an optional `className`).
 */
export function FileChip({ name, className }: FileChipProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[1.1em] max-w-full items-center gap-1 align-baseline leading-none',
        'rounded-md border border-border/60 bg-muted/60 px-2 text-inherit font-medium text-muted-foreground',
        className
      )}
    >
      <File size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate">{name}</span>
    </span>
  )
}
