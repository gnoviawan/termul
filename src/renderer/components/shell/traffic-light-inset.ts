import type { TopRowPlatform } from '@/lib/top-row'

/**
 * Width the native macOS traffic lights need from the window edge: they sit
 * at x = 14 and end at x = 66, then the 10px gap of Paper's rail header.
 */
export const TRAFFIC_LIGHT_CLEARANCE_PX = 76

/**
 * Where the shell steps aside for the macOS traffic lights while the Rail is
 * collapsed. The collapsed Rail (48px) sits under the lights, so the main
 * area's top row only pads its start by 24px (Paper 2.3: tab bar
 * `padding-left: 24`), which puts the expand-Rail toggle at x = 72, just
 * right of the lights. Nothing moves down.
 */
export interface TrafficLightInset {
  /** Start padding of the main area's top row (the bar that touches the Rail). */
  mainStartPx: number
}

const INSET: TrafficLightInset = { mainStartPx: 24 }

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
