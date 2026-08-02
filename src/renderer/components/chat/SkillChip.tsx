import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SkillChipProps {
  name: string
  className?: string
}

/**
 * Highlighted inline pill for an Agent Skill. Accent-styled
 * (`bg-primary/10 border-primary/40 text-primary`, `Sparkles` icon) so an
 * active skill reads at a glance as distinct from the plain muted
 * `CommandChip`.
 *
 * Inline metrics are tuned for the transparent-textarea overlay so the chip
 * occupies exactly one line box (`inline-flex items-center align-baseline
 * leading-none h-[1.1em]`, horizontal-only `px-1.5` padding, no vertical
 * padding) — the transparent textarea text and the overlay stay caret-aligned.
 *
 * Always non-interactive by construction: there is no `onRemove` or any other
 * interactive/removal prop. In the composer, Backspace removes a chip via the
 * token model (`removeSkillTokenBeforeCaret`), not an X button; in the timeline
 * the chip is a static pill. Callers (`SkillComposerOverlay`, `ChatMessage`)
 * pass only `name` (plus an optional `className`).
 */
export function SkillChip({ name, className }: SkillChipProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[1.1em] max-w-full items-center gap-1 align-baseline leading-none',
        'rounded-full border border-primary/40 bg-primary/10 px-1.5 text-xs font-medium text-primary',
        className
      )}
    >
      <Sparkles size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate">{name}</span>
    </span>
  )
}
