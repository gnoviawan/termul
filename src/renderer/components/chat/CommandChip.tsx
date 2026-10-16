import { TerminalSquare } from '@/components/icons'
import { cn } from '@/lib/utils'

interface CommandChipProps {
  /** Command name without the leading slash. The chip renders `/name`. */
  name: string
  className?: string
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
 * Always non-interactive. Backspace removes the pill in the composer. The
 * timeline chip is static. Callers (`CommandPillNode`, `ChatMessage`) pass the
 * bare command name.
 */
export function CommandChip({ name, className }: CommandChipProps): React.JSX.Element {
  const label = `/${name}`
  return (
    <span
      className={cn(
        'inline-flex h-[1.1em] max-w-full items-center gap-1 align-baseline leading-none',
        'text-inherit font-medium text-muted-foreground',
        className
      )}
    >
      <TerminalSquare size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate" title={label}>
        {label}
      </span>
    </span>
  )
}
