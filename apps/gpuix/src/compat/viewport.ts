/**
 * The window width breakpoint variants read. One observer for the whole
 * tree (`CompatRoot` starts it): GPUIX's `useWindowSize` polls the native
 * window every 100 ms per hook, and a hook per stateful host blocked the
 * JS thread for seconds in the bench (cpuprofile: 12 s in getWindowSize).
 */

import { observeWindowSize } from '@gpuix/native/host'
import type { NativeRenderer } from '@gpuix/react'
import { WINDOW_WIDTH } from '../window'

let width = WINDOW_WIDTH
const listeners = new Set<() => void>()

export function viewportWidth(): number {
  return width
}

export function subscribeViewport(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function observeViewport(renderer: NativeRenderer): () => void {
  return observeWindowSize(renderer, (size) => {
    if (size.width === width) return
    width = size.width
    for (const listener of listeners) listener()
  })
}
