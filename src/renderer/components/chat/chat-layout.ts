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
 * Horizontal chat column gutter: tighter on narrow panes, `px-5` (16px) when the
 * pane container is ≥ {@link NARROW_PANE_PX}.
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

    apply(el.getBoundingClientRect().width)

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width != null) apply(width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, thresholdPx])

  return mode
}
