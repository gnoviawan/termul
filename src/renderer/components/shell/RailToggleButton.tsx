import { PanelLeftCollapse, PanelLeftExpand } from '@/components/icons'
import { type RailButtonSize, railButtonClass } from '@/components/shell/rail-button'
import { RAIL_TOGGLE_LABEL, useRailToggle } from '@/components/shell/use-rail-toggle'
import { useShortcutLabel, withShortcut } from '@/components/shell/use-shortcut-label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { RAIL_HOVER_OPEN_DELAY } from './rail-layout'

interface RailToggleButtonProps {
  /** Defaults to `sm` (28px, the top row). */
  size?: RailButtonSize
  /** Defaults to `bottom` (the top row). */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Extra classes on the button. */
  className?: string
}

/**
 * Expands or collapses the Rail. Expanded: the last control of the Rail's top
 * row (`RailHeader`). Collapsed: the first control of the top row bar next
 * to the Rail, right of the macOS traffic lights (`ShowSidePanelSlot`, or the
 * Side panel header). The glyph names the next action (collapse when
 * expanded, expand when collapsed); the accessible name and `aria-pressed`
 * stay stable. No keycap: pressed here means "expanded", not "you are here".
 * It brings its own tooltip provider, so it works in any top row bar.
 */
export function RailToggleButton({
  size = 'sm',
  tooltipSide = 'bottom',
  className
}: RailToggleButtonProps = {}): React.JSX.Element {
  const { expanded, toggle } = useRailToggle()
  const shortcut = useShortcutLabel('sidebarToggle')
  const Icon = expanded ? PanelLeftCollapse : PanelLeftExpand
  return (
    <TooltipProvider delayDuration={RAIL_HOVER_OPEN_DELAY}>
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
    </TooltipProvider>
  )
}
