/**
 * Lenis-style inertial wheel scrolling for the app's DOM scroll areas
 * (spec: _bmad-output/implementation-artifacts/spec-smooth-scroll-areas.md).
 *
 * A single document-level `wheel` listener (BUBBLE phase, `{passive:false}`)
 * resolves the nearest vertically-scrollable ancestor of the event target
 * and eases its `scrollTop` toward an accumulated target on a rAF loop,
 * replacing the browser's instant per-notch step. Pure DOM — no framework
 * state — so desktop webview, web, and mobile-browser surfaces behave
 * identically once installed by `useSmoothWheelScroll`.
 *
 * Boundaries:
 *  - Element-level wheel consumers are never disturbed: the listener bails
 *    on `event.defaultPrevented` (tab bars `preventDefault` to scroll
 *    horizontally), and `stopPropagation` consumers (Mermaid zoom) never
 *    bubble to `document` at all.
 *  - Self-managed scroll engines are excluded via `closest()`:
 *    `.xterm`, `.cm-scroller`, `[data-virtuoso-scroller]`, and the generic
 *    `[data-smooth-scroll="off"]` opt-out.
 *  - Pass-through (no `preventDefault`, native behavior): modifier-chorded
 *    wheels (`ctrlKey` pinch-zoom, `shiftKey` horizontal scroll,
 *    `altKey`/`metaKey` gestures), `|deltaX| >= |deltaY|`,
 *    fractional/sub-threshold deltas (precision touchpads and free-spin
 *    wheels are already inertial natively), wheel events on native form
 *    controls (`<select>` option cycling, `input[type=number]` steppers),
 *    and events at the resolved scroller's edge in the delta direction
 *    (native scroll-chaining must reach the next ancestor).
 *  - Radix scroll lock: `react-remove-scroll`'s document `wheel` listener
 *    is BUBBLE-phase `{passive:false}` — same phase as ours, registered
 *    later (dialogs mount after this engine) — so it CANNOT pre-consume
 *    outside-lock events via `defaultPrevented`. While `body` carries
 *    `data-scroll-locked`, only events inside the locked layer
 *    (`[role="dialog"]`/`"alertdialog"`/`"menu"`/`"listbox"` /
 *    `[data-vaul-drawer]`) are smoothed; outside events fall through to
 *    react-remove-scroll's own `preventDefault`.
 *  - `scrollTop` stays the single source of truth — no transform hijacking —
 *    so virtualizers and `scrollIntoView` keep working. An external writer
 *    (ResizeObserver follow in `message-scroller.tsx`, virtualizer
 *    prepend-restore in `ChatMessageList.tsx`, `scrollToEnd`) is detected by
 *    comparing `scrollTop` against the last value we wrote; on divergence
 *    the animation target resyncs to the real position instead of fighting.
 *    The target is also re-clamped to the live scroll range every frame —
 *    a mid-animation `scrollHeight`/`clientHeight` change can shrink the
 *    range below the accumulated target — and a write that makes zero
 *    progress stops the loop rather than spinning rAF.
 *  - Any failure in the listener or a frame is reported to
 *    `logFrontendError` and disables the interceptor — scrolling wedges are
 *    worse than stepping.
 */

import { logFrontendError } from '@/lib/log-api'
import { easeOutCurve } from '@/lib/motion'

/**
 * Subtrees that own their wheel stream — events targeting anything inside
 * them pass through untouched. `.xterm` covers the terminal viewport/screen
 * descendants; `.cm-scroller` is CodeMirror's scroller; virtuoso marks its
 * scroller with `data-virtuoso-scroller`; `data-smooth-scroll="off"` is the
 * generic opt-out.
 */
const EXCLUDED_SCROLL_SELECTOR =
  '.xterm, .cm-scroller, [data-virtuoso-scroller], [data-smooth-scroll="off"]'

/**
 * Native form controls whose wheel events carry widget semantics — a focused
 * `<select>` cycles its options and `input[type="number"]` steps the value.
 * Intercepting those wheels would eat the control's behavior.
 */
const FORM_CONTROL_SELECTOR = 'select, input[type="number"]'

/**
 * Elements that can host the active layer while `body[data-scroll-locked]`
 * is set (react-remove-scroll, mounted by Radix Dialog/AlertDialog/modal
 * Select/Menu/Popover and — via Radix Dialog — vaul drawers). Radix marks
 * those content elements with these roles; vaul adds `data-vaul-drawer`.
 * Events elsewhere in the document while a lock is active belong to
 * react-remove-scroll's own `preventDefault` — never smoothed.
 */
const SCROLL_LOCK_LAYER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-vaul-drawer]'

/** `WheelEvent.deltaMode` unit identifiers (DOM_DELTA_PIXEL is 0). */
const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
/**
 * Approximate px per line for `deltaMode === DOM_DELTA_LINE` (Firefox
 * discrete wheels report ~3 lines/notch; native turns that into ~48-57px
 * at the default line-height, so 17px/line keeps the normalized distance
 * close to native).
 */
const LINE_HEIGHT_PX = 17

/**
 * Minimum |normalized deltaY| treated as a discrete wheel notch.
 * Mouse-wheel notches arrive well above this floor (Chromium ~100px/notch,
 * Firefox ≈120px after line normalization, Edge ~120px); precision
 * touchpads and free-spin wheels emit high-frequency streams of small or
 * fractional deltas that are already inertial natively, so smoothing them
 * again would double-apply inertia.
 */
const MIN_NOTCH_DELTA_PX = 40

/**
 * Divergence (px) between `scrollTop` and our last write that counts as an
 * external write. Fractional `scrollTop` rounding stays under 1px, so a 1px
 * tolerance cleanly separates our writes from RO follow /
 * `scrollTo({behavior:'smooth'})` / virtualizer prepend-restore.
 */
const RESYNC_EPSILON_PX = 1

/** |target - scrollTop| below which a frame snaps to target and stops. */
const SNAP_EPSILON_PX = 0.5

/**
 * Per-frame approach factor = `easeOutCurve(min(1, dt / FRAME_SPAN_MS))`,
 * sampling the renderer's shared `--ease-out` cubic-bezier(0.23,1,0.32,1)
 * over the elapsed frame time. At 60fps one frame is ~7% of the span
 * (~0.3 of the remaining gap), so a single notch settles in ~150-250ms and
 * accumulated notches chase the growing target with the same ease-out feel.
 * A dt >= the span (e.g. a hidden-tab rAF gap) steps fully to target.
 */
const FRAME_SPAN_MS = 240

/** Per-element animation state; WeakMap so detached scrollers GC freely. */
interface WheelScrollAnim {
  el: HTMLElement
  /** Accumulated destination for the ease, clamped to [0, maxScrollTop]. */
  target: number
  /** The `scrollTop` this engine last wrote (or anchored) — resync baseline. */
  lastWritten: number | null
  /** rAF timestamp of the previous frame, for dt. */
  lastTime: number
  /** Active rAF id; null while idle. */
  rafId: number | null
}

interface EngineInstallation {
  /** Live `installSmoothWheelScroll` callers; listener tears down at 0. */
  refCount: number
  /** Idempotent teardown: removes the listener, cancels pending frames. */
  dispose: () => void
}

/** One active engine per document — refcounted so double-mounts share it. */
const installations = new Map<Document, EngineInstallation>()

// Vite HMR: hot-replacing this module orphans the old copy's document
// listener and queued rAFs — dispose every live installation on swap.
// Guarded so non-Vite contexts (vitest, SSR-ish) skip it.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const installation of installations.values()) {
      installation.dispose()
    }
    installations.clear()
  })
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Sentinel from {@link findScrollableAncestor}: the nearest vertically
 * scrollable candidate has `scroll-behavior: smooth`, so the browser
 * already eases its wheel scrolls — our per-frame writes would be
 * re-smoothed (double inertia) and the resync guard would thrash. The
 * event passes through entirely rather than skipping to an outer scroller,
 * which would consume the wheel for the wrong element.
 */
const NATIVE_SMOOTH_SCROLLER = Symbol('native-smooth-scroller')

/**
 * Nearest ancestor of `target` that can actually scroll vertically —
 * overflow-y permits it AND the content overflows. Elements with
 * `overflow-y: hidden`/`visible` never match (the browser won't wheel-scroll
 * them either), so e.g. the `overflow-hidden` MessageScroller shell is
 * skipped and the real viewport inside wins. Returns
 * {@link NATIVE_SMOOTH_SCROLLER} when the winning candidate already scrolls
 * smoothly natively (`scroll-behavior: smooth`).
 */
function findScrollableAncestor(
  target: Element
): HTMLElement | typeof NATIVE_SMOOTH_SCROLLER | null {
  let node: Element | null = target
  while (node !== null) {
    if (node instanceof HTMLElement && node.scrollHeight - node.clientHeight > 0) {
      const styles = getComputedStyle(node)
      if (isScrollableOverflow(styles.overflowY)) {
        if (styles.scrollBehavior === 'smooth') return NATIVE_SMOOTH_SCROLLER
        return node
      }
    }
    node = node.parentElement
  }
  return null
}

function isScrollableOverflow(value: string): boolean {
  return value === 'auto' || value === 'scroll' || value === 'overlay'
}

/**
 * Whether the scroller can take a non-dominant horizontal component —
 * consumed wheel events with `0 < |deltaX| < |deltaY|` get `scrollLeft`
 * applied synchronously so the horizontal travel isn't swallowed.
 */
function canScrollHorizontally(el: HTMLElement): boolean {
  if (el.scrollWidth - el.clientWidth <= 0) return false
  return isScrollableOverflow(getComputedStyle(el).overflowX)
}

/**
 * Convert a `WheelEvent` delta to pixels. `DOM_DELTA_LINE` (Firefox discrete
 * wheels) maps through {@link LINE_HEIGHT_PX}; `DOM_DELTA_PAGE` measures
 * against the resolved scroller's viewport extent on that axis.
 */
function normalizeDelta(delta: number, deltaMode: number, viewportExtent: number): number {
  if (deltaMode === DOM_DELTA_LINE) return delta * LINE_HEIGHT_PX
  if (deltaMode === DOM_DELTA_PAGE) return delta * viewportExtent
  return delta
}

/**
 * Install the wheel interceptor on `doc` (bubble phase, `{passive:false}`)
 * and return an idempotent detach. Installations are refcounted per
 * document: concurrent mounts share one listener, and the last detach —
 * or a fatal handler failure — tears it down.
 */
export function installSmoothWheelScroll(doc: Document = document): () => void {
  let installation = installations.get(doc)
  if (installation === undefined) {
    const created: EngineInstallation = {
      refCount: 0,
      dispose: () => {}
    }
    created.dispose = createEngine(doc, () => {
      // Engine-initiated teardown (failure path): drop the registry entry so
      // a later install retries cleanly instead of joining a dead listener.
      if (installations.get(doc) === created) installations.delete(doc)
    })
    installation = created
    installations.set(doc, installation)
  }
  installation.refCount += 1

  let released = false
  return () => {
    if (released) return
    released = true
    installation.refCount -= 1
    if (installation.refCount <= 0) {
      if (installations.get(doc) === installation) installations.delete(doc)
      installation.dispose()
    }
  }
}

function createEngine(doc: Document, onTeardown: () => void): () => void {
  const anims = new WeakMap<HTMLElement, WheelScrollAnim>()
  /** Anims with a pending rAF — tracked for teardown since WeakMap can't iterate. */
  const running = new Set<WheelScrollAnim>()
  let disposed = false
  let failed = false

  const onWheel = (event: Event): void => {
    try {
      // Non-WheelEvent 'wheel' dispatches (synthetic tests, exotic webviews)
      // carry no deltas — pass through rather than animating on NaN.
      if (typeof WheelEvent !== 'function' || !(event instanceof WheelEvent)) return
      handleWheel(event)
    } catch (error) {
      fail(error)
    }
  }

  function handleWheel(event: WheelEvent): void {
    // Consumed upstream (element-level `preventDefault` earlier in the
    // bubble path — e.g. tab bars) or an event that cannot be cancelled.
    if (event.defaultPrevented || !event.cancelable) return
    // Modifier chords are gestures, not scroll steps: ctrlKey = pinch-zoom,
    // shiftKey = horizontal scroll, altKey/metaKey = app/OS shortcuts.
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return
    const target = event.target
    if (!(target instanceof Element)) return
    // Self-managed scroll engines / explicit opt-outs keep native behavior.
    if (target.closest(EXCLUDED_SCROLL_SELECTOR) !== null) return
    // Native form controls own their wheel stream (option cycling, steppers).
    if (target.closest(FORM_CONTROL_SELECTOR) !== null) return
    // While a scroll lock is active (react-remove-scroll via Radix/vaul),
    // only smooth inside the locked layer — outside-lock wheel events must
    // reach react-remove-scroll's own listener and be preventDefaulted
    // there, not animated by us behind the modal.
    if (
      doc.body.hasAttribute('data-scroll-locked') &&
      target.closest(SCROLL_LOCK_LAYER_SELECTOR) === null
    ) {
      return
    }
    // Fractional deltas mark a high-resolution stream (precision touchpad,
    // free-spin wheel) that is inertial natively — don't double-smooth.
    if (!Number.isInteger(event.deltaY) || !Number.isInteger(event.deltaX)) return

    let deltaX: number
    let deltaY: number
    let scroller: HTMLElement | typeof NATIVE_SMOOTH_SCROLLER | null
    if (event.deltaMode === DOM_DELTA_PIXEL) {
      // Cheap intent checks BEFORE the ancestor walk (each hop costs a
      // getComputedStyle + layout reads): horizontal-dominant and sub-notch
      // pixel deltas are high-res trackpad/free-spin streams that stay
      // native entirely.
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      if (Math.abs(event.deltaY) < MIN_NOTCH_DELTA_PX) return
      scroller = findScrollableAncestor(target)
      if (scroller === null || scroller === NATIVE_SMOOTH_SCROLLER) return
      deltaX = event.deltaX
      deltaY = event.deltaY
    } else {
      // Line/page deltas are inherently discrete notches — no touchpad
      // emits them — so the sub-notch floor does not apply. Normalization
      // needs the resolved scroller's viewport extent (page mode), which
      // is why the walk happens first here.
      scroller = findScrollableAncestor(target)
      if (scroller === null || scroller === NATIVE_SMOOTH_SCROLLER) return
      deltaX = normalizeDelta(event.deltaX, event.deltaMode, scroller.clientWidth)
      deltaY = normalizeDelta(event.deltaY, event.deltaMode, scroller.clientHeight)
      if (Math.abs(deltaX) >= Math.abs(deltaY)) return
    }

    // Edge guard: only consume events the element can actually use — at the
    // scroll edge, NOT preventDefaulting lets the browser chain the scroll
    // to the next scrollable ancestor natively.
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
    if (deltaY > 0 && scroller.scrollTop >= maxScrollTop) return
    if (deltaY < 0 && scroller.scrollTop <= 0) return

    event.preventDefault()
    // Non-dominant horizontal travel: the whole event is now consumed, so
    // apply deltaX synchronously when the scroller can move horizontally —
    // otherwise that component would be silently swallowed.
    if (deltaX !== 0 && canScrollHorizontally(scroller)) {
      scroller.scrollLeft += deltaX
    }
    queueDelta(scroller, deltaY)
  }

  function queueDelta(el: HTMLElement, delta: number): void {
    let anim = anims.get(el)
    if (anim === undefined) {
      anim = { el, target: el.scrollTop, lastWritten: null, lastTime: 0, rafId: null }
      anims.set(el, anim)
    }
    // Resync BEFORE accumulating: idle animations re-anchor at the real
    // position, and an external writer (RO follow, prepend-restore,
    // scrollToEnd) invalidates any target computed against the old one.
    const drifted =
      anim.lastWritten === null || Math.abs(el.scrollTop - anim.lastWritten) > RESYNC_EPSILON_PX
    const base = anim.rafId === null || drifted ? el.scrollTop : anim.target
    anim.target = clamp(base + delta, 0, Math.max(0, el.scrollHeight - el.clientHeight))
    anim.lastWritten = el.scrollTop
    if (anim.rafId === null) schedule(anim)
  }

  function schedule(anim: WheelScrollAnim): void {
    if (typeof requestAnimationFrame !== 'function') {
      // No rAF (SSR-ish): apply the step instantly rather than silently
      // dropping scroll intent — same fallback as use-pane-split-animation.
      anim.el.scrollTop = anim.target
      anim.lastWritten = anim.el.scrollTop
      return
    }
    anim.lastTime = now()
    running.add(anim)
    anim.rafId = requestAnimationFrame((time) => tick(anim, time))
  }

  function tick(anim: WheelScrollAnim, time: number): void {
    anim.rafId = null
    if (disposed) {
      // Teardown ran while this frame was still queued (raced or
      // cancelAnimationFrame unavailable) — never write after dispose.
      running.delete(anim)
      return
    }
    try {
      const el = anim.el
      if (!el.isConnected) {
        running.delete(anim)
        return
      }
      const actual = el.scrollTop
      // Resync guard: scrollTop moved since our last write → an external
      // writer owns the position now; retarget to reality and stop rather
      // than easing back and fighting it.
      if (anim.lastWritten !== null && Math.abs(actual - anim.lastWritten) > RESYNC_EPSILON_PX) {
        anim.target = actual
      }
      // Re-clamp every frame: scrollHeight can shrink or clientHeight grow
      // mid-animation (content trim, viewport resize), dropping
      // maxScrollTop below the accumulated target.
      anim.target = clamp(anim.target, 0, Math.max(0, el.scrollHeight - el.clientHeight))
      const dt = time - anim.lastTime
      anim.lastTime = time
      if (dt <= 0) {
        // No clock advance this frame — wait for a real dt.
        anim.rafId = requestAnimationFrame((t) => tick(anim, t))
        return
      }
      const gap = anim.target - actual
      if (Math.abs(gap) <= SNAP_EPSILON_PX) {
        el.scrollTop = anim.target
        anim.lastWritten = el.scrollTop
        running.delete(anim)
        return
      }
      const step = easeOutCurve(Math.min(1, dt / FRAME_SPAN_MS))
      el.scrollTop = actual + gap * step
      anim.lastWritten = el.scrollTop
      // A write that produced zero movement (range shrank to the current
      // position, or the platform ignored it) can never converge — stop
      // instead of spinning a rAF loop that goes nowhere.
      if (anim.lastWritten === actual) {
        running.delete(anim)
        return
      }
      anim.rafId = requestAnimationFrame((t) => tick(anim, t))
    } catch (error) {
      running.delete(anim)
      fail(error)
    }
  }

  function fail(error: unknown): void {
    if (failed) return
    failed = true
    dispose()
    onTeardown()
    void logFrontendError({
      message: `Smooth wheel scroll failed; interceptor disabled: ${
        error instanceof Error ? error.message : String(error)
      }`,
      source: 'smooth-wheel',
      stack: error instanceof Error ? error.stack : undefined
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    doc.removeEventListener('wheel', onWheel)
    for (const anim of running) {
      if (anim.rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(anim.rafId)
      }
      anim.rafId = null
    }
    running.clear()
  }

  doc.addEventListener('wheel', onWheel, { passive: false })
  return dispose
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
