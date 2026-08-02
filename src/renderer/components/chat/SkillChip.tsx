import { Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SkillChipProps {
  name: string
  onRemove: () => void
  className?: string
}

/**
 * Highlighted inline pill for an active Agent Skill. Accent-styled
 * (`bg-primary/10 border-primary/40 text-primary`, `Sparkles` icon) so an
 * active skill reads at a glance as distinct from the plain muted
 * `CommandChip`. Pill-shaped (`rounded-full`) and removable via X.
 */
export function SkillChip({ name, onRemove, className }: SkillChipProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2 pr-1 text-xs font-medium text-primary',
        className
      )}
    >
      <Sparkles size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 inline-flex shrink-0 items-center rounded-full p-0.5 hover:bg-primary/20 hover:text-primary"
        aria-label={`Remove ${name} skill`}
        title="Remove skill"
      >
        <X size={12} />
      </button>
    </span>
  )
}
