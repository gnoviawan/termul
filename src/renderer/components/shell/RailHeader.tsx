import { RailToggleButton } from '@/components/shell/RailToggleButton'
import { ShellBrandMark } from '@/components/shell/ShellBrandMark'
import { TrafficLightClearance } from '@/components/shell/TopRowChrome'
import { useTopRowPlatform } from '@/components/shell/top-row-context'

/**
 * Top row part of the expanded Rail, 48px tall: the 8px window gutter, then
 * the 40px row that lines up with the Side panel header. Left to right:
 * - macOS: the traffic-light clearance, then the Termul mark.
 * - Elsewhere: a 48px slot that centers the mark on the Rail icon column
 *   (x = 24).
 * Then drag space, then the 28px Rail toggle: the row's last control, just
 * left of the Side panel header. On desktop every part except the toggle is
 * a window drag handle.
 */
export function RailHeader(): React.JSX.Element {
  const platform = useTopRowPlatform()
  const drag = platform.dragRegions ? true : undefined
  return (
    <div
      className="flex h-12 shrink-0 items-center pt-2 pr-1.5"
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
      <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region={drag} />
      <RailToggleButton size="sm" tooltipSide="bottom" />
    </div>
  )
}
