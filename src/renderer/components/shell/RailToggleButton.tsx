import { PanelLeftCollapse, PanelLeftExpand } from '@/components/icons'
import { type RailButtonSize, railButtonClass } from '@/components/shell/rail-button'
import { RAIL_TOGGLE_LABEL, useRailToggle } from '@/components/shell/use-rail-toggle'
import { useShortcutLabel, withShortcut } from '@/components/shell/use-shortcut-label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface RailToggleButtonProps {
  /** Defaults to `md` (36px, the collapsed Rail). The expanded header uses `sm` (28px). */
  size?: RailButtonSize
  /** Defaults to `right`. The expanded header uses `bottom`. */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Extra classes on the button (the collapsed swap insets its focus ring). */
  className?: string
}

/**
 * Expands or collapses the Rail. Expanded: the last control of the Rail's top
 * row, just left of the Side panel header. Collapsed: it shares the Termul
 * mark's slot at the top — it slides in while the pointer is over the Rail
 * and stays pinned where no input can hover (see `RailCollapsed`). The glyph
 * names the next action (collapse when expanded,
 * expand when collapsed); the accessible name and `aria-pressed` stay
 * stable. No keycap: pressed here means "expanded", not "you are here".
 */
export function RailToggleButton({
  size = 'md',
  tooltipSide = 'right',
  className
}: RailToggleButtonProps = {}): React.JSX.Element {
  const { expanded, toggle } = useRailToggle()
  const shortcut = useShortcutLabel('sidebarToggle')
  const Icon = expanded ? PanelLeftCollapse : PanelLeftExpand
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            toggle()
          }}
          className={cn(railButtonClass(false, size), className)}
          aria-label={RAIL_TOGGLE_LABEL}
          aria-pressed={expanded}
          data-testid="rail-toggle"
        >
          <Icon size={16} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} className="px-2.5 py-1.5 text-xs">
        <span className="text-popover-foreground">
          {withShortcut(expanded ? 'Collapse projects' : 'Expand projects', shortcut)}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
