import { cn } from '@/lib/utils'

interface OpenableChipProps {
  /** The chip's own visual classes (shared by both forms). */
  className: string
  /** Skill whose `SKILL.md` the button opens (labels + `data-skill-open`). */
  skillName: string
  /** When set the chip is a button; otherwise a static span. */
  onOpen?: (chip: HTMLElement) => void
  tabIndex?: number
  children: React.ReactNode
}

/**
 * Shell shared by `SkillChip` and `CommandChip`: a static span, or — when the
 * chip names a skill with a known `SKILL.md` — an inline button that opens it.
 * The button keeps the chip's look and adds only a pointer, a hover underline,
 * and a keyboard focus ring. Press scale is off: the chip sits inside text.
 */
export function OpenableChip({
  className,
  skillName,
  onOpen,
  tabIndex,
  children
}: OpenableChipProps): React.JSX.Element {
  if (!onOpen) return <span className={className}>{children}</span>
  return (
    <button
      type="button"
      data-press-feedback="off"
      data-skill-open={skillName}
      title={`Open ${skillName} SKILL.md`}
      aria-label={`Open skill ${skillName}`}
      tabIndex={tabIndex}
      onClick={(event) => onOpen(event.currentTarget)}
      className={cn(
        className,
        'cursor-pointer appearance-none rounded-sm underline-offset-2 hover:underline',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      {children}
    </button>
  )
}
