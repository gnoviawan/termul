/** A wheel gesture ends after this long without wheel events. */
export const WHEEL_GESTURE_IDLE_MS = 150

/** Who owns the current wheel gesture: the canvas camera or one scroll container. */
export interface WheelGesture<T> {
  owner: 'canvas' | { container: T }
  lastTime: number
}

export interface WheelInput<T> {
  time: number
  dx: number
  dy: number
  /** Ctrl/Meta wheel, which is also how trackpad pinch arrives. */
  zoom: boolean
  /** Scroll container inside a canvas item, under the pointer, that can move along the dominant axis of this delta. */
  findContainer: (dx: number, dy: number) => T | null
  /** True when the container can still move by this delta. */
  canScroll: (container: T, dx: number, dy: number) => boolean
}

/**
 * - `zoom`: zoom the camera at the pointer.
 * - `pan`: pan the camera.
 * - `native`: let the browser scroll the latched container.
 * - `block`: prevent default and do nothing.
 */
export type WheelAction = 'zoom' | 'pan' | 'native' | 'block'

export interface WheelRoute<T> {
  action: WheelAction
  gesture: WheelGesture<T> | null
}

/** Decides the wheel owner once per gesture so a frame at its scroll limit never hands off to the canvas. */
export function routeWheel<T>(
  gesture: WheelGesture<T> | null,
  input: WheelInput<T>
): WheelRoute<T> {
  const { time, dx, dy } = input
  if (input.zoom) return { action: 'zoom', gesture: null }

  const continues = gesture !== null && time - gesture.lastTime <= WHEEL_GESTURE_IDLE_MS
  if (continues) {
    const next = { owner: gesture.owner, lastTime: time }
    if (next.owner === 'canvas') return { action: 'pan', gesture: next }
    return {
      action: input.canScroll(next.owner.container, dx, dy) ? 'native' : 'block',
      gesture: next
    }
  }

  if (dx === 0 && dy === 0) return { action: 'block', gesture }

  const vertical = Math.abs(dy) >= Math.abs(dx)
  const container = input.findContainer(vertical ? 0 : dx, vertical ? dy : 0)
  if (container === null) return { action: 'pan', gesture: { owner: 'canvas', lastTime: time } }
  return { action: 'native', gesture: { owner: { container }, lastTime: time } }
}
