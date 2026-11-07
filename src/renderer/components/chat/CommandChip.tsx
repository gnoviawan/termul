import { TerminalSquare } from '@/components/icons'
import { cn } from '@/lib/utils'
import { OpenableChip } from './OpenableChip'

interface CommandChipProps {
  /** Command name without the leading slash. The chip renders `/name`. */
  name: string
  className?: string
  /** Opens the `SKILL.md` behind a skill-backed command. When set the chip
   * renders as a button. */
  onOpen?: (chip: HTMLElement) => void
  /** Tab order for the button form (the composer passes `-1`). */
  tabIndex?: number
}

/**
 * Muted inline chip for a slash command. Sibling of `SkillChip` and `FileChip`
 * — same inline metrics (`inline-flex items-center align-baseline leading-none
 * h-[1.1em]`, `font-medium`, `max-w-[40ch] truncate`) so the chip stays on one
 * line and flush with the surrounding text.
 *
 * A command is a prefix, not a skill mention. It uses the terminal icon and
 * `text-muted-foreground`, with the name shown as `/name`. A skill keeps
 * `Sparkles` and `text-primary`. No background, border, or horizontal padding.
 *
 * Backspace removes the pill in the composer. A harness can publish a skill
 * as a command (OpenCode does this for every skill); for those `onOpen` makes
 * the chip a button that opens the skill's `SKILL.md`. Other commands stay
 * static. Callers (`CommandPillNode`, `ChatMessage`) pass the bare name.
 */
export function CommandChip({
  name,
  className,
  onOpen,
  tabIndex
}: CommandChipProps): React.JSX.Element {
  const label = `/${name}`
  return (
    <OpenableChip
      skillName={name}
      onOpen={onOpen}
      tabIndex={tabIndex}
      className={cn(
        'inline-flex h-[1.1em] max-w-full items-center gap-1 align-baseline leading-none',
        'text-inherit font-medium text-muted-foreground',
        className
      )}
    >
      <TerminalSquare size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate" title={onOpen ? undefined : label}>
        {label}
      </span>
    </OpenableChip>
  )
}
