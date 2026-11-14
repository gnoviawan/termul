import * as HoverCardPrimitive from '@radix-ui/react-hover-card'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { forwardRef } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import {
  RAIL_HOVER_OPEN_DELAY,
  RAIL_HOVER_PANEL_PADDING,
  RAIL_HOVER_PANEL_SIDE_OFFSET
} from '../rail-layout'

/**
 * Surface of every collapsed Rail hover panel (Sidebar V2): popover fill, a
 * 0.5px `popover-edge` outline and the two-step drop. Motion is the tooltip
 * motion (`animate-tooltip-in`), reduced-motion safe.
 */
export const RAIL_HOVER_SURFACE_CLASS =
  'z-50 bg-popover text-popover-foreground outline-[0.5px] outline-solid outline-popover-edge shadow-rail-hover-panel animate-tooltip-in'

/** Pause between the pointer leaving a trigger and the panel closing (to cross the 12px gap). */
const RAIL_HOVER_CLOSE_DELAY = 100

/**
 * Root of a collapsed Rail hover panel: a hover card that opens after the
 * Rail's intent delay on pointer hover or on keyboard focus of its trigger,
 * and closes on leave, blur or Escape. Compose
 * `RailHoverPanel > RailHoverPanelTrigger + RailHoverPanelContent`.
 */
export function RailHoverPanel({
  openDelay = RAIL_HOVER_OPEN_DELAY,
  closeDelay = RAIL_HOVER_CLOSE_DELAY,
  ...props
}: React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Root>): React.JSX.Element {
  return <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={closeDelay} {...props} />
}

/** The Rail row the panel belongs to. Use `asChild` with the row element. */
export const RailHoverPanelTrigger = HoverCardPrimitive.Trigger

/**
 * The panel: 240px, radius 10, 4px padding, 1px between rows. It opens at
 * x = 52 (Rail edge + 4) and, by default, 4px above its trigger so its first
 * row lines up with the trigger row. Rendered in a portal.
 */
export const RailHoverPanelContent = forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(function RailHoverPanelContent(
  {
    className,
    side = 'right',
    align = 'start',
    sideOffset = RAIL_HOVER_PANEL_SIDE_OFFSET,
    alignOffset = -RAIL_HOVER_PANEL_PADDING,
    ...props
  },
  ref
) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        ref={ref}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className={cn(
          RAIL_HOVER_SURFACE_CLASS,
          'flex w-60 flex-col gap-px rounded-[10px] p-1 text-xs',
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
})

/**
 * Static project row inside a hover panel: 30px, 12px inset, 16px icon, 8px
 * gap, the name in medium `secondary-foreground` fading at its end, then an
 * optional trail (the diff stat).
 */
export function RailHoverPanelProjectRow({
  icon,
  name,
  children,
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> & {
  icon: React.ReactNode
  name: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn('flex h-7.5 shrink-0 items-center gap-2 rounded-md px-3', className)}
      {...props}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="fade-end min-w-0 flex-1 font-medium text-secondary-foreground">{name}</span>
      {children}
    </div>
  )
}

export interface RailHoverTooltipContentProps {
  /** The name of the control. */
  label: string
  /** Why the control is off (muted, after the label). */
  hint?: string
  /** Keyboard shortcut, as a keycap. */
  shortcut?: string
}

/**
 * Tooltip of a collapsed Rail icon: 28px, radius 8, the label in 12px medium,
 * then the shortcut keycap. Opens at x = 52, centred on the icon. Put it
 * inside a Radix `Tooltip` root after its trigger.
 */
export function RailHoverTooltipContent({
  label,
  hint,
  shortcut
}: RailHoverTooltipContentProps): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side="right"
        sideOffset={RAIL_HOVER_PANEL_SIDE_OFFSET}
        className={cn(
          RAIL_HOVER_SURFACE_CLASS,
          'flex h-7 items-center gap-2 rounded-lg pr-1.5 pl-2.5 text-xs leading-4 font-medium',
          !shortcut && 'pr-2.5'
        )}
      >
        <span className="text-foreground">{label}</span>
        {hint && <span className="text-muted-foreground">{hint}</span>}
        {shortcut && (
          <Kbd className="keycap inline-flex h-4.5 shrink-0 items-center border-0 px-1.25 text-xs leading-4">
            {shortcut}
          </Kbd>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}
