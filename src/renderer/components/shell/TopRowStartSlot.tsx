import { RailToggleButton } from '@/components/shell/RailToggleButton'
import { useTopRow } from '@/components/shell/top-row-context'
import { cn } from '@/lib/utils'

/**
 * Whether {@link TopRowStartSlot} renders: the Rail is collapsed (the expand
 * toggle moves here) or the macOS traffic lights need clearance.
 */
export function useTopRowStartSlotVisible(): boolean {
  const topRow = useTopRow()
  return (topRow?.mainStartInsetPx ?? 0) > 0 || Boolean(topRow?.railToggleInMain)
}

/**
 * Start of the top-row bar that touches the Rail (the leftmost top-edge tab
 * bar, the SSH header or the fallback bar, see `showPanelOwner`). With the
 * Rail collapsed it holds the expand-Rail toggle; under the macOS traffic
 * lights it pads its start by `mainStartInsetPx` (24px, so the toggle lands
 * at x = 72 as in Paper 2.3). Renders nothing when neither applies.
 */
export function TopRowStartSlot(): React.JSX.Element | null {
  const topRow = useTopRow()
  const inset = topRow?.mainStartInsetPx ?? 0
  const railToggle = Boolean(topRow?.railToggleInMain)
  if (!railToggle && inset === 0) return null
  return (
    <div
      className={cn('flex h-full shrink-0 items-center', inset === 0 && 'pl-1.5')}
      style={inset > 0 ? { paddingLeft: inset } : undefined}
      data-testid="top-row-start-slot"
    >
      {railToggle && <RailToggleButton />}
    </div>
  )
}
