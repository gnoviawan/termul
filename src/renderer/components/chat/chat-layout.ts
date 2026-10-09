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

/**
 * Hit area for text controls in the chat pane.
 * 44px on a narrow pane, 40px when the pane is at least 400px.
 * No min width: a long label must not become a square.
 */
export const CHAT_HIT_MIN_H = 'min-h-11 @[400px]:min-h-10'

/**
 * Hit area for icon controls. The box is the target, so do not add a
 * pseudo-element that can overlap the next control.
 */
export const CHAT_HIT_ICON =
  'relative inline-flex shrink-0 items-center justify-center size-11 @[400px]:size-10'

/**
 * Visually hides a composer control's text label while keeping it in the
 * accessible name. Applies at a pane width of 360px or less: Tailwind v4
 * `@max-[N]` means container width < N, so 361px is the first width that keeps
 * the label. On the mobile web shell the pane equals the viewport, so this is
 * the "ModeChip goes icon-only" truncation step of the one-row composer.
 */
export const CHAT_COMPACT_LABEL = '@max-[361px]:sr-only'

/**
 * Dense agent-activity rows (tool calls, thought and turn headers). The row is
 * a full-width target, so 28px meets WCAG 2.5.8 for mouse; touch input gets
 * 44px. Keyed on pointer type, not pane width: a narrow desktop pane still has
 * a mouse. Stacked rows touch, so never extend their hit area vertically.
 */
export const CHAT_ROW_MIN_H = 'min-h-7 pointer-coarse:min-h-11'

/** Icon control inside a dense activity row; must not grow the row past {@link CHAT_ROW_MIN_H}. */
export const CHAT_ROW_ICON = 'size-7 pointer-coarse:size-11'

/**
 * Max height for the scrollable body of an inline agent prompt panel
 * (`AskUserQuestion`, `ElicitationQuestions`). Bounded so a long question
 * batch can never push the message list off-screen.
 */
export const QUESTION_PANEL_MAX_H = 'max-h-[min(55vh,30rem)]'

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
