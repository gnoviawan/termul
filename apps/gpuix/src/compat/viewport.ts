/**
 * The window size breakpoint variants and the env seam read. One observer for
 * the whole tree (`CompatRoot` starts it): GPUIX's `useWindowSize` polls the
 * native window every 100 ms per hook, and a hook per stateful host blocked the
 * JS thread for seconds in the bench (cpuprofile: 12 s in getWindowSize).
 *
 * A size change reaches `window` the way a browser reports it: `innerWidth`
 * and `innerHeight` take the new size, then `resize` fires (the env seam
 * re-evaluates `matchMedia` lists on it).
 */

import { observeWindowSize, readWindowSize } from '@gpuix/native/host'
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

export function observeViewport(renderer: NativeRenderer): () => void {
  const initial = readWindowSize(renderer)
  if (initial.width > 0 && initial.height > 0) publish(initial)
  return observeWindowSize(renderer, publish)
}
