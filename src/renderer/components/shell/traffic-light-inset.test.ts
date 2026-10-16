import { describe, expect, it } from 'vitest'
import type { TopRowPlatform } from '@/lib/top-row'
import { getTrafficLightInset, TRAFFIC_LIGHT_CLEARANCE_PX } from './traffic-light-inset'

const platform = (trafficLights: boolean): TopRowPlatform => ({
  dragRegions: true,
  windowControls: !trafficLights,
  trafficLights
})

describe('getTrafficLightInset', () => {
  it('applies only with native traffic lights and the Rail collapsed', () => {
    expect(getTrafficLightInset(platform(true), false)).not.toBeNull()
    expect(getTrafficLightInset(platform(true), true)).toBeNull()
    expect(getTrafficLightInset(platform(false), false)).toBeNull()
  })

  it('derives the header padding from the clearance, the collapsed Rail and the shell gap', () => {
    expect(TRAFFIC_LIGHT_CLEARANCE_PX).toBe(80)
    // 80 - 48 (collapsed Rail) - 8 (shell gap)
    expect(getTrafficLightInset(platform(true), false)?.panelHeaderStartPx).toBe(24)
  })

  it('starts the main card 36px down', () => {
    expect(getTrafficLightInset(platform(true), false)?.mainTopPx).toBe(36)
  })
})
