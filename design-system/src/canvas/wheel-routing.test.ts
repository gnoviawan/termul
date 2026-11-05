import { describe, expect, it } from 'vitest'
import {
  routeWheel,
  WHEEL_GESTURE_IDLE_MS,
  type WheelGesture,
  type WheelInput
} from './wheel-routing'

interface Frame {
  id: string
  /** Remaining vertical scroll in px; 0 means at the bottom limit. */
  room: number
}

function input(overrides: Partial<WheelInput<Frame>> & { over?: Frame | null }): WheelInput<Frame> {
  const over = overrides.over ?? null
  return {
    time: 0,
    dx: 0,
    dy: 40,
    zoom: false,
    findContainer: (_dx, dy) => (over && dy > 0 && over.room > 0 ? over : null),
    canScroll: (frame, _dx, dy) => dy > 0 && frame.room > 0,
    containsTarget: (frame) => frame === over,
    ...overrides
  }
}

describe('routeWheel', () => {
  it('latches to a scrollable frame and keeps it at the limit', () => {
    const frame: Frame = { id: 'frame', room: 80 }
    const first = routeWheel(null, input({ time: 0, over: frame }))
    expect(first.action).toBe('native')
    expect(first.gesture?.owner).toEqual({ container: frame })

    frame.room = 0
    const atLimit = routeWheel(first.gesture, input({ time: 16, over: frame }))
    expect(atLimit.action).toBe('block')

    const offFrame = routeWheel(atLimit.gesture, input({ time: 32, over: null }))
    expect(offFrame.action).toBe('block')
  })

  it('latches to the canvas on empty space and keeps panning over a frame', () => {
    const frame: Frame = { id: 'frame', room: 500 }
    const first = routeWheel(null, input({ time: 0, over: null }))
    expect(first.action).toBe('pan')
    expect(first.gesture?.owner).toBe('canvas')

    const overFrame = routeWheel(first.gesture, input({ time: 16, over: frame }))
    expect(overFrame.action).toBe('pan')
  })

  it('latches to the canvas when the frame cannot scroll in the gesture direction', () => {
    const frame: Frame = { id: 'frame', room: 0 }
    const first = routeWheel(null, input({ time: 0, over: frame }))
    expect(first.action).toBe('pan')
    frame.room = 200
    expect(routeWheel(first.gesture, input({ time: 16, over: frame })).action).toBe('pan')
  })

  it('makes a new decision after an idle gap', () => {
    const frame: Frame = { id: 'frame', room: 0 }
    const canvas = routeWheel(null, input({ time: 0, over: null }))
    const within = routeWheel(canvas.gesture, input({ time: WHEEL_GESTURE_IDLE_MS, over: frame }))
    expect(within.action).toBe('pan')

    frame.room = 120
    const later = WHEEL_GESTURE_IDLE_MS * 2 + 1
    const fresh = routeWheel(within.gesture, input({ time: later, over: frame }))
    expect(fresh.action).toBe('native')
    expect(fresh.gesture?.owner).toEqual({ container: frame })
  })

  it('uses only the dominant axis to pick the owner', () => {
    const frame: Frame = { id: 'frame', room: 100 }
    const route = routeWheel(null, input({ time: 0, dx: 60, dy: 10, over: frame }))
    expect(route.action).toBe('pan')
  })

  it('zooms on ctrl/meta wheel even while a frame owns the gesture', () => {
    const frame: Frame = { id: 'frame', room: 100 }
    const latched = routeWheel(null, input({ time: 0, over: frame }))
    const zoom = routeWheel(latched.gesture, input({ time: 16, zoom: true, over: frame }))
    expect(zoom.action).toBe('zoom')
    expect(zoom.gesture).toBeNull()
  })

  it('does not start a gesture on a zero delta', () => {
    const stale: WheelGesture<Frame> = { owner: 'canvas', lastTime: 0 }
    const route = routeWheel(stale, input({ time: 1000, dx: 0, dy: 0 }))
    expect(route).toEqual({ action: 'block', gesture: stale })
  })

  it('scrolls the latched frame explicitly when the pointer moves over another frame', () => {
    const owner: Frame = { id: 'owner', room: 400 }
    const other: Frame = { id: 'other', room: 400 }
    const first = routeWheel(null, input({ time: 0, over: owner }))
    expect(first.action).toBe('native')

    const moved = routeWheel(first.gesture, input({ time: 16, over: other }))
    expect(moved.action).toBe('scroll')
    expect(moved.gesture?.owner).toEqual({ container: owner })

    const offFrames = routeWheel(moved.gesture, input({ time: 32, over: null }))
    expect(offFrames.action).toBe('scroll')
    expect(offFrames.gesture?.owner).toEqual({ container: owner })
  })

  it('leaves native scrolling alone while the pointer stays inside the latched frame', () => {
    const owner: Frame = { id: 'owner', room: 400 }
    const first = routeWheel(null, input({ time: 0, over: owner }))
    const still = routeWheel(first.gesture, input({ time: 16, over: owner }))
    expect(still.action).toBe('native')
  })

  it('blocks instead of scrolling when the latched frame is at its limit off-pointer', () => {
    const owner: Frame = { id: 'owner', room: 400 }
    const other: Frame = { id: 'other', room: 400 }
    const first = routeWheel(null, input({ time: 0, over: owner }))
    owner.room = 0
    expect(routeWheel(first.gesture, input({ time: 16, over: other })).action).toBe('block')
  })
})
