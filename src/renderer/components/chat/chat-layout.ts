/**
 * Pane-scoped responsive layout helpers for ACP chat (Story 5.1).
 *
 * Breakpoints are **pane width**, not viewport — split panes on desktop make
 * `sm:`/`md:` viewport utilities wrong. Gutters use Tailwind `@container`
 * variants on the chat pane root; the composer toolbar uses a ResizeObserver
 * seam (`data-composer-toolbar`) because jsdom does not layout CSS container
 * queries reliably.
 */

import { type RefObject, useEffect, useState } from 'react'

/** Pane width below which the composer toolbar uses the explicit two-row layout. */
export const NARROW_PANE_PX = 400

/**
 * Horizontal chat column gutter: tighter on narrow panes, `px-3` (12px) or
 * `px-5` (20px) when the pane container is ≥ {@link NARROW_PANE_PX}.
 */
export const CHAT_GUTTER_X = 'px-3 @[400px]:px-5'

export type ComposerToolbarMode = 'narrow' | 'wide'

/**
 * Resolve narrow vs wide from a measured pane/composer width.
 * Width ≤ 0 (jsdom / pre-layout) stays `wide` so desktop tests keep the
 * single-row toolbar without mocking ResizeObserver.
 */
export function resolveComposerToolbarMode(
  widthPx: number,
  thresholdPx: number = NARROW_PANE_PX
): ComposerToolbarMode {
  if (widthPx <= 0) return 'wide'
  return widthPx < thresholdPx ? 'narrow' : 'wide'
}

/**
 * Observe an element's content box and report `narrow` | `wide` for the
 * composer toolbar. Defaults to `wide` until a positive width is measured.
 */
export function useComposerToolbarMode(
  ref: RefObject<HTMLElement | null>,
  thresholdPx: number = NARROW_PANE_PX
): ComposerToolbarMode {
  const [mode, setMode] = useState<ComposerToolbarMode>('wide')

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const apply = (width: number): void => {
      setMode(resolveComposerToolbarMode(width, thresholdPx))
    }

    // Measure border-box width consistently for both the initial read and the
    // observer callback. The composer root spans the full pane, so its
    // border-box width matches the `@container` (pane) width that the CSS
    // `@[400px]:` gutter variant resolves against — using `contentRect.width`
    // here would exclude the gutter padding and disagree with the CSS threshold
    // by 12–20px, causing a visible narrow↔wide flip near 400px.
    const measureBorderBox = (): number => el.getBoundingClientRect().width

    apply(measureBorderBox())

    // Older mobile WebViews / SSR / jsdom-without-setup may not expose
    // ResizeObserver; fall back to the initial measurement so the composer
    // still renders (wide) instead of throwing inside the effect and
    // unmounting the chat subtree.
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      apply(measureBorderBox())
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, thresholdPx])

  return mode
}
