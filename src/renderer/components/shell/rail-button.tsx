import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** `md` = 36px (the default rail action), `sm` = 28px (secondary footer actions). */
export type RailButtonSize = 'md' | 'sm'

/**
 * Rail action. Rest = muted icon; hover = 3% foreground wash; the pressed /
 * open view takes the `.keycap` surface. Disabled icons sit at 40% with no
 * hover.
 */
export function railButtonClass(active: boolean, size: RailButtonSize = 'md'): string {
  return cn(
    QUIET_ICON_BUTTON_CLASS,
    'relative flex shrink-0 rounded-lg disabled:pointer-events-none disabled:opacity-40',
    size === 'md' ? 'size-9' : 'size-7',
    active && 'keycap text-foreground'
  )
}

interface RailTooltipProps {
  label: string
  /** Muted second line (a shortcut, or why the action is off). */
  hint?: string
  /** Defaults to `right`, away from the Rail. */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** The trigger: one focusable element that accepts a ref. */
  children: React.ReactElement
}

/**
 * The one tooltip for every Rail control: the name, and an optional muted
 * hint under it. Use it instead of a native `title`.
 */
export function RailTooltip({
  label,
  hint,
  side = 'right',
  children
}: RailTooltipProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex flex-col gap-0.5 px-2.5 py-1.5 text-xs">
        <span className="text-popover-foreground">{label}</span>
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

interface RailButtonProps {
  label: string
  /** Muted second line in the tooltip (e.g. why the action is disabled). */
  hint?: string
  'aria-label': string
  /** Accessible description: status that is not part of the name (the click does not act on it). */
  description?: string
  disabled?: boolean
  /** Sets `aria-pressed` and the keycap "you are here" surface. */
  pressed?: boolean
  badge?: React.ReactNode
  /** Defaults to `md` (36px). */
  size?: RailButtonSize
  /** Runs after the click stops propagating. */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}

export function RailButton({
  label,
  hint,
  'aria-label': ariaLabel,
  description,
  disabled = false,
  pressed,
  badge,
  size = 'md',
  onClick,
  children
}: RailButtonProps): React.JSX.Element {
  const button = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
      className={railButtonClass(pressed ?? false, size)}
      aria-label={ariaLabel}
      aria-description={description}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      disabled={disabled}
    >
      {children}
      {badge}
    </button>
  )

  return (
    <RailTooltip label={label} hint={hint}>
      {/* A disabled button gets no pointer events, so the wrapper carries
          the tooltip that explains why the action is off. */}
      {disabled ? <span className="inline-flex">{button}</span> : button}
    </RailTooltip>
  )
}
