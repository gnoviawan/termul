import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Finding C regression test.
 *
 * The injected annotation overlay used to early-return when a layer already
 * existed (`if (document.getElementById('__termul_annotation_layer')) return;`),
 * which turned re-injection into a silent no-op and left stale/absent capture
 * handlers bound. The overlay now reconciles: it tears the previous layer down
 * and installs a fresh set of capture-phase listeners.
 *
 * These tests load the real resource script and assert the reconcile behavior
 * against the live jsdom DOM.
 */

// Resolve relative to THIS test file (../../../../src-tauri/resources/...) so the
// test is independent of the runner's cwd (monorepo, per-package config, IDE
// single-file runs).
const HERE = dirname(fileURLToPath(import.meta.url))
const OVERLAY_SCRIPT_PATH = resolve(
  HERE,
  '../../../../src-tauri/resources/annotation-overlay.js'
)
const overlaySource = readFileSync(OVERLAY_SCRIPT_PATH, 'utf8')

const CAPTURE_EVENTS = [
  'mousedown',
  'mousemove',
  'mouseup',
  'click',
  'keydown',
  'contextmenu',
]

// addEventListener's 3rd arg signals capture either as the boolean `true` or as
// an options object `{ capture: true }`. Accept both so the test guards behavior,
// not the call style.
function isCapture(arg: unknown): boolean {
  if (arg === true) return true
  return typeof arg === 'object' && arg !== null && (arg as { capture?: boolean }).capture === true
}

interface OverlayWindow {
  __termul_annotation_mode?: string
  __termul_annotation_tab_id?: string
  __termul_remove_annotation_overlay?: () => void
}

function injectOverlay(mode: string, tabId: string): void {
  const w = window as unknown as OverlayWindow
  w.__termul_annotation_mode = mode
  w.__termul_annotation_tab_id = tabId
  // Indirect eval runs the IIFE in global scope where jsdom `window`/`document` live.
  ;(0, eval)(overlaySource)
}

function captureListenerCalls(spy: ReturnType<typeof vi.spyOn>): string[] {
  return (spy.mock.calls as unknown[][])
    .filter((call) => isCapture(call[2]) && CAPTURE_EVENTS.includes(call[0] as string))
    .map((call) => call[0] as string)
}

describe('annotation overlay reconcile (Finding C)', () => {
  let addSpy: ReturnType<typeof vi.spyOn>
  let removeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    const w = window as unknown as OverlayWindow
    delete w.__termul_remove_annotation_overlay
    delete w.__termul_annotation_mode
    delete w.__termul_annotation_tab_id
    addSpy = vi.spyOn(document, 'addEventListener')
    removeSpy = vi.spyOn(document, 'removeEventListener')
  })

  afterEach(() => {
    const w = window as unknown as OverlayWindow
    if (typeof w.__termul_remove_annotation_overlay === 'function') {
      w.__termul_remove_annotation_overlay()
    }
    addSpy.mockRestore()
    removeSpy.mockRestore()
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  })

  it('installs the overlay layer and capture-phase handlers on first injection', () => {
    injectOverlay('select', 'tab-1')

    expect(document.getElementById('__termul_annotation_layer')).not.toBeNull()
    expect(captureListenerCalls(addSpy).sort()).toEqual([...CAPTURE_EVENTS].sort())
    expect(typeof (window as unknown as OverlayWindow).__termul_remove_annotation_overlay).toBe(
      'function'
    )
  })

  it('reconciles a pre-existing layer: tears down old handlers, rewires fresh ones', () => {
    injectOverlay('select', 'tab-1')
    addSpy.mockClear()
    removeSpy.mockClear()

    // Second injection while a layer already exists (e.g. SPA navigation left it behind).
    injectOverlay('select', 'tab-1')

    // Old capture listeners were removed (teardown), and a fresh set was registered.
    expect(captureListenerCalls(removeSpy).sort()).toEqual([...CAPTURE_EVENTS].sort())
    expect(captureListenerCalls(addSpy).sort()).toEqual([...CAPTURE_EVENTS].sort())

    // Exactly one layer remains — no duplicate/orphaned overlay.
    expect(document.querySelectorAll('#__termul_annotation_layer')).toHaveLength(1)
  })

  it('preserves the requested mode/tab globals across reconcile teardown', () => {
    injectOverlay('select', 'tab-1')
    // Re-inject with a different mode/tab; reconcile must not let the previous
    // cleanup `delete` the freshly-set globals.
    injectOverlay('draw', 'tab-2')

    const w = window as unknown as OverlayWindow
    expect(w.__termul_annotation_mode).toBe('draw')
    expect(w.__termul_annotation_tab_id).toBe('tab-2')
  })

  it('removes an orphaned layer that has no cleanup function', () => {
    // Simulate a leftover layer with no associated cleanup fn.
    const orphan = document.createElement('div')
    orphan.id = '__termul_annotation_layer'
    document.body.appendChild(orphan)
    const w = window as unknown as OverlayWindow
    delete w.__termul_remove_annotation_overlay

    injectOverlay('select', 'tab-1')

    expect(document.querySelectorAll('#__termul_annotation_layer')).toHaveLength(1)
    expect(captureListenerCalls(addSpy).sort()).toEqual([...CAPTURE_EVENTS].sort())
  })

  it('cleanup fully tears down and is a safe guarded no-op afterward', () => {
    injectOverlay('select', 'tab-1')
    const w = window as unknown as OverlayWindow

    w.__termul_remove_annotation_overlay?.()

    expect(document.getElementById('__termul_annotation_layer')).toBeNull()
    // Cleanup deletes its own global, so the Rust-side `if (window.__termul_...)`
    // guard short-circuits — calling it again is a no-op.
    expect(w.__termul_remove_annotation_overlay).toBeUndefined()
  })
})
