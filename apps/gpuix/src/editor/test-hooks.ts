/**
 * Test-only observation of the editor. The automation tree carries neither a
 * view's state nor (on Linux, where GPUI paints on its own thread) the
 * painted text, so under `TERMUL_GPUIX_TEST_HOOKS=1` the view mirrors both
 * into an unpainted text node. `TERMUL_GPUIX_EDITOR_PERF=1` also turns on
 * GPUIX's frame statistics and records each render's JS time.
 */

import type { NativeRenderer } from '@gpuix/react'

/** Under test hooks, a view for a file with this suffix throws on render (the tab boundary check). */
export const CRASH_SUFFIX = '.gpuix-crash'

const env = typeof process === 'undefined' ? {} : process.env

export function testHooksEnabled(): boolean {
  return (
    (globalThis as { __TERMUL_GPUIX_TEST_HOOKS__?: boolean }).__TERMUL_GPUIX_TEST_HOOKS__ ===
      true || env.TERMUL_GPUIX_TEST_HOOKS === '1'
  )
}

const renderMs: number[] = []
const keyToCommitMs: number[] = []
let keyAt: number | null = null

/** A key reached the view; the next commit closes the measurement. */
export function markKey(): void {
  if (env.TERMUL_GPUIX_EDITOR_PERF === '1') keyAt = performance.now()
}
let statsOn = false

export function recordRender(ms: number): void {
  if (env.TERMUL_GPUIX_EDITOR_PERF !== '1') return
  renderMs.push(Math.round(ms * 100) / 100)
  if (renderMs.length > 200) renderMs.shift()
  if (keyAt !== null) {
    keyToCommitMs.push(Math.round((performance.now() - keyAt) * 100) / 100)
    keyAt = null
    if (keyToCommitMs.length > 200) keyToCommitMs.shift()
  }
}

export function perfSnapshot(renderer: NativeRenderer, large: boolean): unknown {
  if (env.TERMUL_GPUIX_EDITOR_PERF !== '1' || !large) return undefined
  if (!statsOn) {
    statsOn = true
    renderer.setDebugFrameOverlay?.('minimal')
  }
  return {
    renderMs: [...renderMs],
    keyToCommitMs: [...keyToCommitMs],
    frames: renderer.getDebugFrameOverlayStats?.()
  }
}
