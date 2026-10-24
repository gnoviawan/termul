/**
 * The layout arithmetic of `react-resizable-panels` 2.x, as pure functions
 * over percentages: default sizes, validation against min/max, and the
 * pivot resize a handle drag performs.
 */

export interface PanelConstraints {
  defaultSize?: number
  minSize?: number
  maxSize?: number
}

const EPSILON = 1e-9

function bounds(c: PanelConstraints): { min: number; max: number } {
  return { min: c.minSize ?? 0, max: c.maxSize ?? 100 }
}

function clamp(size: number, c: PanelConstraints): number {
  const { min, max } = bounds(c)
  return Math.min(max, Math.max(min, size))
}

/** Panels with a `defaultSize` keep it; the rest share what is left equally. */
export function defaultLayout(panels: readonly PanelConstraints[]): number[] {
  const unsized = panels.filter((p) => p.defaultSize === undefined).length
  const taken = panels.reduce((sum, p) => sum + (p.defaultSize ?? 0), 0)
  const share = unsized > 0 ? Math.max(0, 100 - taken) / unsized : 0
  return validateLayout(
    panels.map((p) => p.defaultSize ?? share),
    panels
  )
}

/**
 * Scale the layout to total 100, clamp every panel into its bounds, and hand
 * what clamping freed or took to the panels after it, in order.
 */
export function validateLayout(layout: readonly number[], panels: readonly PanelConstraints[]): number[] {
  if (layout.length !== panels.length) {
    throw new Error(`Invalid ${panels.length} panel layout: ${layout.join(', ')}`)
  }
  if (layout.length === 0) return []
  const total = layout.reduce((sum, size) => sum + size, 0)
  const next = total > EPSILON ? layout.map((size) => (size / total) * 100) : layout.map(() => 100 / layout.length)
  let remainder = 0
  for (let i = 0; i < next.length; i++) {
    const clamped = clamp(next[i], panels[i])
    remainder += next[i] - clamped
    next[i] = clamped
  }
  for (let i = 0; i < next.length && Math.abs(remainder) > EPSILON; i++) {
    const grown = clamp(next[i] + remainder, panels[i])
    remainder -= grown - next[i]
    next[i] = grown
  }
  return next
}

/**
 * The layout after dragging the handle between panels `pivot` and `pivot + 1`
 * by `delta` percent of the group, starting from `start`. The panel on the
 * side the handle moves away from grows; the panels on the other side shrink
 * nearest first, each down to its minimum.
 */
export function resizeAtHandle(
  start: readonly number[],
  delta: number,
  pivot: number,
  panels: readonly PanelConstraints[]
): number[] {
  const next = [...start]
  if (Math.abs(delta) < EPSILON) return next
  const growing = delta > 0 ? pivot : pivot + 1
  const step = delta > 0 ? 1 : -1
  const room = bounds(panels[growing]).max - next[growing]
  const wanted = Math.min(Math.abs(delta), Math.max(0, room))
  let taken = 0
  for (let i = delta > 0 ? pivot + 1 : pivot; i >= 0 && i < next.length && wanted - taken > EPSILON; i += step) {
    const give = Math.min(next[i] - bounds(panels[i]).min, wanted - taken)
    if (give <= 0) continue
    next[i] -= give
    taken += give
  }
  next[growing] += taken
  return next
}

export function sameLayout(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((size, i) => Math.abs(size - b[i]) < 1e-6)
}
