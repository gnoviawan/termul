import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SkillChipProps {
  name: string
  className?: string
}

/**
 * Highlighted inline chip for an Agent Skill or a slash command (commands
 * pass the name prefixed by `/`). Colored-text-only treatment
 * (`text-primary font-medium`, `Sparkles` icon) — no background, no border,
 * no horizontal padding — so the chip reads at a glance as distinct from the
 * muted `FileChip` while staying flush with the surrounding text.
 *
 * Inline metrics keep the chip inside exactly one line box (`inline-flex
 * items-center align-baseline leading-none h-[1.1em]`); font size inherits
 * from the surrounding text (`text-inherit`) so the chip tracks composer
 * `text-base` and timeline `text-sm` without a hardcoded size.
 *
 * Always non-interactive by construction: there is no `onRemove` or any other
 * interactive/removal prop. In the composer, Backspace removes a chip via the
 * token model (`removeSkillTokenBeforeCaret`/`removeCommandTokenBeforeCaret`
 * + the editor's pill keymap), not an X button; in the timeline the chip is a
 * static pill. Callers (`CommandPillNode`, `SkillPillNode`, `ChatMessage`)
 * pass only `name` (plus an optional `className`).
 */
export function SkillChip({ name, className }: SkillChipProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[1.1em] max-w-full items-center gap-1 align-baseline leading-none',
        'text-inherit font-medium text-primary',
        className
      )}
    >
      <Sparkles size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate">{name}</span>
    </span>
  )
}
