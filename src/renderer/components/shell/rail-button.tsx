import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useRailCollapsed } from './rail/rail-density'
import { RailHoverTooltipContent } from './rail/rail-hover-panel'

/**
 * `md` = 36px, `base` = 32px (the collapsed Rail footer), `sm` = 28px
 * (the expanded footer row and top-row toggles).
 */
export type RailButtonSize = 'md' | 'base' | 'sm'

const RAIL_BUTTON_SIZE_CLASS: Record<RailButtonSize, string> = {
  md: 'size-9',
  base: 'size-8',
  sm: 'size-7'
}

/**
 * Rail action. Rest = muted icon; hover = 3% foreground wash; the pressed /
 * open view takes the `.keycap` surface. Disabled icons sit at 40% with no
 * hover.
 */
export function railButtonClass(active: boolean, size: RailButtonSize = 'md'): string {
  return cn(
    QUIET_ICON_BUTTON_CLASS,
    'relative flex shrink-0 rounded-lg disabled:pointer-events-none disabled:opacity-40',
    RAIL_BUTTON_SIZE_CLASS[size],
    active && 'keycap text-foreground'
  )
}

interface RailTooltipProps {
  label: string
  /** Muted second line (why the action is off). */
  hint?: string
  /** Keyboard shortcut: a muted line when expanded, a keycap on the collapsed Rail. */
  shortcut?: string
  /** Defaults to `right`, away from the Rail. */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** The trigger: one focusable element that accepts a ref. */
  children: React.ReactElement
}

/**
 * The one tooltip for every Rail control: the name, and an optional muted
 * hint and shortcut under it. Use it instead of a native `title`. On the
 * collapsed Rail it is the hover panel tooltip (label + shortcut keycap) at
 * x = 52.
 */
export function RailTooltip({
  label,
  hint,
  shortcut,
  side = 'right',
  children
}: RailTooltipProps): React.JSX.Element {
  const collapsed = useRailCollapsed()
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {collapsed ? (
        <RailHoverTooltipContent label={label} hint={hint} shortcut={shortcut} />
      ) : (
        <TooltipContent side={side} className="flex flex-col gap-0.5 px-2.5 py-1.5 text-xs">
          <span className="text-popover-foreground">{label}</span>
          {(hint ?? shortcut) && <span className="text-muted-foreground">{hint ?? shortcut}</span>}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

interface RailButtonProps {
  label: string
  /** Muted second line in the tooltip (e.g. why the action is disabled). */
  hint?: string
  /** Keyboard shortcut shown in the tooltip. */
  shortcut?: string
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
  shortcut,
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
    <RailTooltip label={label} hint={hint} shortcut={shortcut}>
      {/* A disabled button gets no pointer events, so the wrapper carries
          the tooltip that explains why the action is off. */}
      {disabled ? <span className="inline-flex">{button}</span> : button}
    </RailTooltip>
  )
}
