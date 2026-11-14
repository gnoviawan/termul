import { forwardRef } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useRailCollapsed } from './rail-density'
import { RailHoverTooltipContent } from './rail-hover-panel'

/**
 * Nav section at the top of the Rail (Sidebar V2): 8px top and sides, 10px
 * bottom, 1px between rows, in both densities. Put {@link RailNavRow}s inside.
 */
export const RailNav = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function RailNav({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('flex shrink-0 flex-col gap-px px-2 pt-2 pb-2.5', className)}
        {...props}
      />
    )
  }
)

export interface RailNavRowProps
  extends Omit<React.ComponentPropsWithoutRef<'button'>, 'children' | 'name'> {
  /** Visible label. */
  label: string
  /** Leading glyph, drawn in a 14px box. */
  icon: React.ReactNode
  /** Accessible name and tooltip title. Defaults to `label`. */
  name?: string
  /** Muted second tooltip line, for example why the row is off. */
  hint?: string
  /** Keyboard shortcut, shown as a key chip in the tooltip (never on the row). */
  shortcut?: string
  /** Sets `aria-pressed` and the keycap "you are here" surface. */
  pressed?: boolean
}

/**
 * One nav row: 28px, 12px inline padding, 14px icon, 8px to the label, 12/16
 * medium `secondary-foreground`. The label fades at its end instead of an
 * ellipsis. The tooltip on the right carries the name, the shortcut and the
 * hint. A disabled row keeps its tooltip through a wrapper span.
 *
 * Collapsed Rail: the same 28px row with only the icon, centred; hover takes
 * a 6% foreground fill (radius 6) and the tooltip is the hover panel tooltip
 * (label + shortcut keycap) at x = 52.
 */
export const RailNavRow = forwardRef<HTMLButtonElement, RailNavRowProps>(function RailNavRow(
  { label, icon, name, hint, shortcut, pressed, disabled = false, className, onClick, ...props },
  ref
) {
  const collapsed = useRailCollapsed()
  const accessibleName = name ?? label
  const button = (
    <button
      ref={ref}
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
      className={cn(
        QUIET_ICON_BUTTON_CLASS,
        'flex h-7 w-full shrink-0 text-xs leading-4 font-medium text-secondary-foreground',
        collapsed
          ? 'justify-center rounded-md px-0 hover:bg-foreground/[0.06]'
          : 'justify-start gap-2 rounded-lg px-3',
        'disabled:pointer-events-none disabled:opacity-40',
        pressed && 'keycap text-foreground',
        className
      )}
      aria-label={accessibleName}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      {...props}
    >
      <span
        data-rail-icon-column
        className="inline-flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5"
      >
        {icon}
      </span>
      {!collapsed && <span className="fade-end min-w-0 flex-1 text-left">{label}</span>}
    </button>
  )
  const trigger = (
    <TooltipTrigger asChild>
      {disabled ? <span className="block w-full">{button}</span> : button}
    </TooltipTrigger>
  )

  if (collapsed) {
    return (
      <Tooltip>
        {trigger}
        <RailHoverTooltipContent label={accessibleName} hint={hint} shortcut={shortcut} />
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      {trigger}
      <TooltipContent side="right" className="flex flex-col gap-0.5 px-2.5 py-1.5 text-xs">
        <span className="flex items-center gap-2 text-popover-foreground">
          {accessibleName}
          {shortcut && (
            <Kbd className="inline-flex h-4.5 shrink-0 items-center px-1">{shortcut}</Kbd>
          )}
        </span>
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  )
})
