import { RailToggleButton } from '@/components/shell/RailToggleButton'
import { ShellBrandMark } from '@/components/shell/ShellBrandMark'
import { TrafficLightClearance } from '@/components/shell/TopRowChrome'
import { useTopRowPlatform } from '@/components/shell/top-row-context'
import { useRailCollapsed } from './rail/rail-density'

/**
 * Top row part of the expanded Rail (Paper "Rail header"), 44px tall, in
 * line with the tab bar and the right panel header. Left to right:
 * - macOS: the traffic-light clearance, then the Troupe mark.
 * - Elsewhere: a 48px slot that centers the mark on the Rail icon column
 *   (x = 24).
 * Then the 28px Rail toggle 4px after the mark, then drag space. On desktop
 * every part except the toggle is a window drag handle.
 *
 * Collapsed Rail: the same row, empty (only the macOS traffic lights sit over
 * it) and a drag handle; the expand toggle moves to the start of the main
 * area's top row (`TopRowStartSlot`).
 */
export function RailHeader(): React.JSX.Element {
  const platform = useTopRowPlatform()
  const collapsed = useRailCollapsed()
  const drag = platform.dragRegions ? true : undefined
  if (collapsed) {
    return <div className="h-11 shrink-0" data-testid="rail-header" data-tauri-drag-region={drag} />
  }
  return (
    <div
      className="flex h-11 shrink-0 items-center"
      data-testid="rail-header"
      data-tauri-drag-region={drag}
    >
      {platform.trafficLights ? (
        <>
          <TrafficLightClearance trafficLights />
          <ShellBrandMark dragRegion={platform.dragRegions} />
        </>
      ) : (
        <div
          className="flex w-12 shrink-0 items-center justify-center self-stretch"
          data-testid="rail-header-mark-slot"
          data-tauri-drag-region={drag}
        >
          <ShellBrandMark dragRegion={platform.dragRegions} />
        </div>
      )}
      <RailToggleButton className="ml-1" />
      <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region={drag} />
    </div>
  )
}
