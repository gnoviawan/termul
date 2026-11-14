import { useRailCollapsed } from '@/components/shell/rail/rail-density'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

/** Look of a section header's trailing icon button (same box as a group row's `…`). */
export const RAIL_SECTION_BUTTON_CLASS = cn(
  QUIET_ICON_BUTTON_CLASS,
  'size-5 cursor-pointer [&_svg]:size-3.5'
)

interface RailSectionHeaderProps {
  /** Section name, e.g. `Groups` or `Projects`. */
  label: string
  /** Trailing control, usually one {@link RAIL_SECTION_BUTTON_CLASS} icon button. */
  children?: React.ReactNode
  className?: string
}

/**
 * Small muted section label of the shell Rail project list ("Groups",
 * "Projects"): 40px with 12px on top, the label 18px from the Rail edge
 * (Sidebar V2), an icon button at the end. The row is not focusable; only
 * its button is.
 *
 * Collapsed Rail: the same 40px row holds a 20×1 `border` divider (see
 * {@link RailSectionDivider}).
 */
export function RailSectionHeader({
  label,
  children,
  className
}: RailSectionHeaderProps): React.JSX.Element {
  if (useRailCollapsed()) {
    return (
      <RailSectionDivider
        data-testid={`rail-section-${label.toLowerCase()}`}
        className={className}
      />
    )
  }
  return (
    <div
      data-testid={`rail-section-${label.toLowerCase()}`}
      className={cn(
        'flex h-10 w-full select-none items-center justify-between gap-2 pt-3 pr-1.5 pl-2.5',
        className
      )}
    >
      <h3 className="label-panel min-w-0 truncate">{label}</h3>
      {children}
    </div>
  )
}

/**
 * A section header on the collapsed Rail: the 40px header row (12px on top)
 * with a centred 20×1 divider in `border`.
 */
export function RailSectionDivider({
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'div'>, 'children'>): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn('flex h-10 w-full shrink-0 items-center justify-center pt-3', className)}
      {...props}
    >
      <div data-rail-section-divider className="h-px w-5 bg-border" />
    </div>
  )
}
