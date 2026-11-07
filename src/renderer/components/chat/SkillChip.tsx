import { Sparkles } from '@/components/icons'
import { cn } from '@/lib/utils'
import { OpenableChip } from './OpenableChip'

interface SkillChipProps {
  name: string
  className?: string
  /** Opens the skill's `SKILL.md`. When set the chip renders as a button. */
  onOpen?: (chip: HTMLElement) => void
  /** Tab order for the button form (the composer passes `-1`). */
  tabIndex?: number
}

/**
 * Highlighted inline chip for an Agent Skill. Colored-text-only treatment
 * (`text-primary font-medium`, `Sparkles` icon) — no background, no border,
 * no horizontal padding — so the chip reads at a glance as distinct from a
 * muted command chip (`CommandChip`) and a muted file chip (`FileChip`).
 *
 * Inline metrics keep the chip inside exactly one line box (`inline-flex
 * items-center align-baseline leading-none h-[1.1em]`); font size inherits
 * from the surrounding text (`text-inherit`) so the chip tracks composer
 * `text-base` and timeline `text-sm` without a hardcoded size.
 *
 * There is no `onRemove` prop. In the composer, Backspace removes a chip via
 * the token model (`removeSkillTokenBeforeCaret` and the editor's pill keymap),
 * not an X button. The only interaction is `onOpen` (see `skill-file-links`):
 * with it the chip is a button that opens the skill's `SKILL.md`; without it
 * the chip is a static pill.
 */
export function SkillChip({
  name,
  className,
  onOpen,
  tabIndex
}: SkillChipProps): React.JSX.Element {
  return (
    <OpenableChip
      skillName={name}
      onOpen={onOpen}
      tabIndex={tabIndex}
      className={cn(
        'inline-flex h-[1.1em] max-w-full items-center gap-1 align-baseline leading-none',
        'text-inherit font-medium text-primary',
        className
      )}
    >
      <Sparkles size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate" title={onOpen ? undefined : name}>
        {name}
      </span>
    </OpenableChip>
  )
}
