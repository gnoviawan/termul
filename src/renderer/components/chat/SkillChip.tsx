import { Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SkillChipProps {
  name: string
  /** Click handler for the X button. When omitted or `readOnly` is set, the X
   * button is hidden (timeline + overlay render read-only chips). */
  onRemove?: () => void
  /** Hide the remove button (timeline rendering, transparent-textarea overlay). */
  readOnly?: boolean
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
 * In the composer, the chip is read-only (Backspace removes it via the token
 * model, not the X button); in the timeline it is always read-only.
 */
export function SkillChip({
  name,
  onRemove,
  readOnly = false,
  className
}: SkillChipProps): React.JSX.Element {
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
      {!readOnly && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 inline-flex shrink-0 items-center rounded-full p-0.5 hover:bg-primary/20 hover:text-primary"
          aria-label={`Remove ${name} skill`}
          title="Remove skill"
        >
          <X size={12} />
        </button>
      )}
    </span>
  )
}
