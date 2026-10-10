/**
 * Dock clearance for the mobile toast stack.
 *
 * The mobile web shell pins a "dock" to the bottom of the screen: the chat
 * composer with its approval, changed-files and queue bars, or the terminal key
 * bar. Its height varies with the state of the chat (an open approval, a
 * queued prompt, an attachment, the iOS keyboard) and with the key bar's one or
 * two rows, so no constant can keep a toast clear of it. Instead this hook
 * measures the highest edge among the registered dock elements and publishes
 * the distance from the viewport bottom to that edge as the CSS variable
 * `--mobile-dock-height` on `document.documentElement`
 * (`ui/sonner.tsx` adds a 12px gap to it for both mobile offsets).
 *
 * Why `:root`: sonner renders its list inline beside the router, outside the
 * shell, so only an ancestor of the Toaster can supply the variable. The
 * precedent is `--termul-keyboard-height` in `use-osk-viewport.ts`.
 *
 * Why the viewport bottom: both sonner offsets are measured from there, so the
 * value already includes the dock's own padding, the iOS keyboard spacer and
 * the safe-area inset. No constant is added for any of them.
 *
 * The registry is module-level and shared by every caller (the chat dock and
 * the key bar never show together, but a hidden chat stays mounted, so callers
 * must coexist). The highest registered top wins. One `ResizeObserver` watches
 * every registered element and its parent (an iOS keyboard moves the dock by
 * growing the root's padding, which shrinks the parent's content box without
 * resizing the dock itself); one set of `window` / `visualViewport` listeners
 * re-measures on viewport changes. Everything is released with the last
 * registrant and the property is removed, so the CSS fallback applies.
 */

import { useCallback, useEffect, useRef } from 'react'
import { logFrontendError } from '@/lib/log-api'

export const DOCK_CLEARANCE_VAR = '--mobile-dock-height'

/** Registered dock elements: the highest top edge among them sets the variable. */
const registry = new Set<HTMLElement>()
/** The shared observer and listener state, alive while the registry is not empty. */
let observer: ResizeObserver | null = null
let listeningViewport: VisualViewport | null = null
let frameId: number | null = null
/** The missing-`ResizeObserver` warning is logged once per page load. */
let warnedNoObserver = false

/** Distance (px) from the viewport bottom to the highest laid-out registered top, or null. */
function readClearance(): number | null {
  const viewportHeight = window.innerHeight
  let highestTop: number | null = null
  for (const element of registry) {
    if (!element.isConnected) continue
    const rect = element.getBoundingClientRect()
    // `display: none` (and `display: contents`) elements report an all-zero rect.
    if (rect.width === 0 || rect.height === 0) continue
    if (highestTop === null || rect.top < highestTop) highestTop = rect.top
  }
  if (highestTop === null) return null
  return Math.max(0, Math.min(viewportHeight, Math.ceil(viewportHeight - highestTop)))
}

/** Publish the current clearance, writing only when the value changed. */
function measure(): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  const style = document.documentElement.style
  const next = readClearance()
  const current = style.getPropertyValue(DOCK_CLEARANCE_VAR)
  if (next === null) {
    if (current !== '') style.removeProperty(DOCK_CLEARANCE_VAR)
    return
  }
  const value = `${next}px`
  if (current !== value) style.setProperty(DOCK_CLEARANCE_VAR, value)
}

/** Coalesce window and visual-viewport events into one measurement per frame. */
function scheduleMeasure(): void {
  if (frameId !== null) return
  frameId = requestAnimationFrame(() => {
    frameId = null
    measure()
  })
}

/** Point the observer at every registered element and its parent. */
function observeRegistered(): void {
  if (!observer) return
  observer.disconnect()
  for (const element of registry) {
    observer.observe(element)
    if (element.parentElement) observer.observe(element.parentElement)
  }
}

function start(): void {
  if (typeof ResizeObserver === 'function') {
    // Synchronous on purpose: the notification arrives after layout and before
    // paint, so the variable follows a growing dock in the same frame.
    observer = new ResizeObserver(() => measure())
  } else if (!warnedNoObserver) {
    warnedNoObserver = true
    void logFrontendError({
      level: 'warn',
      source: 'dock-clearance',
      message:
        'ResizeObserver is unavailable; the toast clearance follows window and visualViewport resizes only'
    })
  }
  window.addEventListener('resize', scheduleMeasure)
  // iOS Safari scrolls the visual viewport instead of resizing the layout one
  // when the keyboard rises: both events are needed (see use-osk-viewport.ts).
  listeningViewport = window.visualViewport ?? null
  listeningViewport?.addEventListener('resize', scheduleMeasure)
  listeningViewport?.addEventListener('scroll', scheduleMeasure)
}

function stop(): void {
  observer?.disconnect()
  observer = null
  window.removeEventListener('resize', scheduleMeasure)
  listeningViewport?.removeEventListener('resize', scheduleMeasure)
  listeningViewport?.removeEventListener('scroll', scheduleMeasure)
  listeningViewport = null
  if (frameId !== null) {
    cancelAnimationFrame(frameId)
    frameId = null
  }
}

function register(element: HTMLElement): void {
  if (registry.has(element)) return
  registry.add(element)
  if (registry.size === 1) start()
  observeRegistered()
  measure()
}

function unregister(element: HTMLElement): void {
  if (!registry.delete(element)) return
  if (registry.size === 0) stop()
  else observeRegistered()
  // Re-measure the rest; with none left this removes the property.
  measure()
}

/**
 * Report an element's top edge to the toast stack while `enabled`. Returns a
 * callback ref: attach it to the dock's outermost element. The hook keeps the
 * element in a ref rather than state, so it adds no render to the component
 * that uses it, and an element that mounts later (behind the component's early
 * returns) still registers.
 */
export function useDockClearance(enabled: boolean): (element: HTMLElement | null) => void {
  const elementRef = useRef<HTMLElement | null>(null)
  const enabledRef = useRef(enabled)
  const registeredRef = useRef<HTMLElement | null>(null)

  // Register the element only while enabled and mounted; unregister otherwise.
  const sync = useCallback(() => {
    const target = enabledRef.current ? elementRef.current : null
    const registered = registeredRef.current
    if (registered === target) return
    if (registered) unregister(registered)
    registeredRef.current = target
    if (target) register(target)
  }, [])

  const setElement = useCallback(
    (element: HTMLElement | null) => {
      elementRef.current = element
      sync()
    },
    [sync]
  )

  useEffect(() => {
    enabledRef.current = enabled
    sync()
    return () => {
      enabledRef.current = false
      sync()
    }
  }, [enabled, sync])

  return setElement
}
