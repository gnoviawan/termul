import { COLLAPSED_WIDTH, SHELL_GAP } from '@/components/shell/rail-layout'
import { useTopRowPlatform } from '@/components/shell/top-row-context'
import type { TopRowPlatform } from '@/lib/top-row'
import { useSidebarVisible } from '@/stores/sidebar-store'

/** Width the native macOS traffic lights need from the window edge (they end near x=66). */
export const TRAFFIC_LIGHT_CLEARANCE_PX = 80

/**
 * Where the shell steps aside for the macOS traffic lights while the Rail is
 * collapsed. The collapsed Rail (48px) and the shell gap (8px) already sit
 * under the lights, so the Side panel header only adds the rest:
 * 80 - 48 - 8 = 24px of start padding (8px more than the usual 16px).
 */
export interface TrafficLightInset {
  /** Start padding of the Side panel header, so its content clears the lights. */
  panelHeaderStartPx: number
  /** Top margin of the main card: it starts below the lights in both Side panel states. */
  mainTopPx: number
}

const INSET: TrafficLightInset = {
  panelHeaderStartPx: TRAFFIC_LIGHT_CLEARANCE_PX - COLLAPSED_WIDTH - SHELL_GAP,
  mainTopPx: 36
}

/**
 * The one place that decides the inset: `null` unless the traffic lights are
 * native (Tauri on macOS) and the Rail is collapsed. With the Rail expanded
 * its header carries the lights' clearance itself (`TrafficLightClearance`).
 */
export function getTrafficLightInset(
  platform: TopRowPlatform,
  railExpanded: boolean
): TrafficLightInset | null {
  return platform.trafficLights && !railExpanded ? INSET : null
}

/** {@link getTrafficLightInset} for the current platform and Rail state. */
export function useTrafficLightInset(): TrafficLightInset | null {
  return getTrafficLightInset(useTopRowPlatform(), useSidebarVisible())
}
