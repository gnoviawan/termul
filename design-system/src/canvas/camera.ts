/** Camera math for the design-system canvas. Pure functions, no DOM. */

export interface Point {
  x: number
  y: number
}

export interface Camera {
  x: number
  y: number
  z: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 3
export const COORD_LIMIT = 100_000
export const DEFAULT_CAMERA: Camera = { x: 64, y: 96, z: 1 }

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function clampCamera(camera: Camera): Camera {
  return {
    x: clamp(camera.x, -COORD_LIMIT, COORD_LIMIT),
    y: clamp(camera.y, -COORD_LIMIT, COORD_LIMIT),
    z: clamp(camera.z, ZOOM_MIN, ZOOM_MAX)
  }
}

export function clampPoint(point: Point): Point {
  return {
    x: clamp(point.x, -COORD_LIMIT, COORD_LIMIT),
    y: clamp(point.y, -COORD_LIMIT, COORD_LIMIT)
  }
}

/** Zoom by `factor`, keeping the screen point (sx, sy) fixed over the same canvas point. */
export function zoomAt(camera: Camera, sx: number, sy: number, factor: number): Camera {
  const z = clamp(camera.z * factor, ZOOM_MIN, ZOOM_MAX)
  const ratio = z / camera.z
  return clampCamera({
    x: sx - (sx - camera.x) * ratio,
    y: sy - (sy - camera.y) * ratio,
    z
  })
}

/** Camera that shows `bounds` inside a viewport, with padding in screen pixels. */
export function fitBounds(
  bounds: Bounds,
  viewport: { width: number; height: number; top: number },
  padding = 48
): Camera {
  const width = Math.max(1, bounds.maxX - bounds.minX)
  const height = Math.max(1, bounds.maxY - bounds.minY)
  const usableW = Math.max(1, viewport.width - padding * 2)
  const usableH = Math.max(1, viewport.height - viewport.top - padding * 2)
  const z = clamp(Math.min(usableW / width, usableH / height), ZOOM_MIN, 1)
  return clampCamera({
    x: (viewport.width - width * z) / 2 - bounds.minX * z,
    y: viewport.top + (viewport.height - viewport.top - height * z) / 2 - bounds.minY * z,
    z
  })
}

export function cameraTransform(camera: Camera): string {
  return `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.z})`
}
