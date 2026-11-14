import { forwardRef } from 'react'
import { RailHoverTooltipContent } from '@/components/shell/rail/rail-hover-panel'
import { RAIL_HOVER_OPEN_DELAY } from '@/components/shell/rail-layout'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Tooltip, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Width of the tool strip (Paper "Tool strip": 44px). */
export const TOOL_STRIP_WIDTH = 44

/**
 * Tooltip gap: the strip button sits 6px inside the strip edge, so 10px puts
 * the tooltip 4px left of the strip (the mirror of the Rail's x = edge + 4).
 */
const TOOL_STRIP_TOOLTIP_OFFSET = 10

interface ToolStripProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Accessible name of the strip. */
  'aria-label': string
}

/**
 * Right edge tool strip of the shell (Sidebar V2, Paper "Tool strip"): a
 * 44px column with a 0.5px start hairline, the panel views at the top and
 * pinned tools at the bottom. Compose
 * `ToolStrip > ToolStrip.Group > ToolStrip.Button`, with a `ToolStrip.Spacer`
 * between the groups.
 */
function ToolStripRoot({ className, children, ...props }: ToolStripProps): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={RAIL_HOVER_OPEN_DELAY}>
      <div
        role="toolbar"
        aria-orientation="vertical"
        className={cn(
          'flex h-full w-11 shrink-0 flex-col items-center border-l-[0.5px] border-border bg-background pt-1.5',
          className
        )}
        {...props}
      >
        {children}
      </div>
    </TooltipProvider>
  )
}

/** A column of strip buttons, 4px apart. */
function ToolStripGroup({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return (
    <div role="group" className={cn('flex flex-col items-center gap-1', className)} {...props} />
  )
}

/** Pushes the next group to the bottom of the strip. */
function ToolStripSpacer({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return <div aria-hidden className={cn('min-h-0 flex-1', className)} {...props} />
}

interface ToolStripButtonProps extends Omit<React.ComponentPropsWithoutRef<'button'>, 'children'> {
  /** Name and tooltip label. */
  label: string
  /** Keyboard shortcut shown as a keycap in the tooltip. */
  shortcut?: string
  /** The open view: raised (`.keycap`) with a foreground glyph. */
  active?: boolean
  /** A 14px glyph. */
  icon: React.ReactNode
  /** Corner badge (a count). */
  badge?: React.ReactNode
}

/**
 * 32px strip button, radius 8: a muted 14px glyph at rest, the 3% wash on
 * hover, the keycap while its view is open. The tooltip opens on the left
 * with the label and the shortcut. Forwards its ref and extra props to the
 * button, so it works as a Radix `asChild` trigger (a popover).
 */
const ToolStripButton = forwardRef<HTMLButtonElement, ToolStripButtonProps>(
  function ToolStripButton(
    { label, shortcut, active = false, icon, badge, className, type = 'button', ...props },
    ref
  ) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type={type}
            aria-label={label}
            className={cn(
              QUIET_ICON_BUTTON_CLASS,
              'relative size-8 shrink-0 rounded-lg disabled:pointer-events-none disabled:opacity-40',
              active && 'keycap text-foreground',
              className
            )}
            {...props}
          >
            {icon}
            {badge}
          </button>
        </TooltipTrigger>
        <RailHoverTooltipContent
          label={label}
          shortcut={shortcut}
          side="left"
          sideOffset={TOOL_STRIP_TOOLTIP_OFFSET}
        />
      </Tooltip>
    )
  }
)

export const ToolStrip = Object.assign(ToolStripRoot, {
  Group: ToolStripGroup,
  Spacer: ToolStripSpacer,
  Button: ToolStripButton
})
