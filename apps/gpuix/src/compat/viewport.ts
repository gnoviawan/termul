/**
 * The window size breakpoint variants and the env seam read. Nothing polls
 * it: GPUIX's `useWindowSize` polls the native window every 100 ms per hook,
 * and each poll waits for the UI thread (a hook per stateful host blocked the
 * JS thread for 12 s in the bench; one 100 ms poll still cost 1.2 s of
 * startup). `CompatRoot` reads the size on mount and whenever its root box,
 * which fills the window, changes size.
 *
 * A size change reaches `window` the way a browser reports it: `innerWidth`
 * and `innerHeight` take the new size, then `resize` fires (the env seam
 * re-evaluates `matchMedia` lists on it).
 */

import { readWindowSize } from '@gpuix/native/host'
import type { NativeRenderer } from '@gpuix/react'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../window'

let width = WINDOW_WIDTH
let height = WINDOW_HEIGHT
const listeners = new Set<() => void>()

export function viewportWidth(): number {
  return width
}

/** Window height, for `vh` lengths. */
export function viewportHeight(): number {
  return height
}

export function subscribeViewport(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

interface ResizableWindow extends EventTarget {
  innerWidth: number
  innerHeight: number
}

function publish(size: { width: number; height: number }): void {
  const widthChanged = size.width !== width
  width = size.width
  height = size.height
  const win = (globalThis as { window?: ResizableWindow }).window
  if (win && (win.innerWidth !== size.width || win.innerHeight !== size.height)) {
    win.innerWidth = size.width
    win.innerHeight = size.height
    win.dispatchEvent(new Event('resize'))
  }
  if (widthChanged) for (const listener of listeners) listener()
}

export function syncViewport(renderer: NativeRenderer): void {
  const size = readWindowSize(renderer)
  if (size.width > 0 && size.height > 0) publish(size)
}
