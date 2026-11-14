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

  it('pads the main top row by 24px so the expand toggle lands at x = 72 (Paper 2.3)', () => {
    expect(TRAFFIC_LIGHT_CLEARANCE_PX).toBe(76)
    // 48 (collapsed Rail) + 24 = 72
    expect(getTrafficLightInset(platform(true), false)?.mainStartPx).toBe(24)
  })
})
