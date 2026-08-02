import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { parseSkillSegments } from '@/lib/skill-tokens'
import { cn } from '@/lib/utils'
import { SkillChip } from './SkillChip'

interface SkillComposerOverlayProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  className?: string
}

/**
 * Metrics read off the underlying `<textarea>` so the overlay's text wraps
 * identically (same font, padding, line-height, width, white-space,
 * word-break). Reading computed style (rather than re-declaring Tailwind
 * classes) keeps the overlay aligned if the textarea's styling ever changes.
 */
interface TextareaMetrics {
  fontFamily: string
  fontSize: string
  fontWeight: string
  fontStyle: string
  fontVariant: string
  lineHeight: string
  letterSpacing: string
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
  borderTopWidth: string
  borderRightWidth: string
  borderBottomWidth: string
  borderLeftWidth: string
  width: string
  height: string
  boxSizing: string
  textTransform: string
  tabSize: string
  whiteSpace: string
  wordBreak: string
  overflowWrap: string
}

function readMetrics(ta: HTMLTextAreaElement): TextareaMetrics {
  const cs = window.getComputedStyle(ta)
  return {
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    fontVariant: cs.fontVariant,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    paddingTop: cs.paddingTop,
    paddingRight: cs.paddingRight,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
    borderTopWidth: cs.borderTopWidth,
    borderRightWidth: cs.borderRightWidth,
    borderBottomWidth: cs.borderBottomWidth,
    borderLeftWidth: cs.borderLeftWidth,
    width: cs.width,
    height: cs.height,
    boxSizing: cs.boxSizing,
    textTransform: cs.textTransform,
    tabSize: cs.tabSize,
    whiteSpace: cs.whiteSpace,
    wordBreak: cs.wordBreak,
    overflowWrap: cs.overflowWrap
  }
}

/**
 * Transparent-textarea overlay that mirrors the composer value and replaces
 * skill tokens with `SkillChip` pills. The textarea sits on top
 * (`color: transparent`, visible `caret-color`) so `useComposerTextarea`
 * (IME/OSK/draft/mentions/slash) is untouched; this overlay renders the
 * visible text + chips in the exact same metrics so the caret stays aligned.
 * `pointer-events: none` keeps all input flowing to the textarea; scroll
 * position is mirrored via a scroll listener.
 */
export function SkillComposerOverlay({
  textareaRef,
  value,
  className
}: SkillComposerOverlayProps): React.JSX.Element | null {
  const [metrics, setMetrics] = useState<TextareaMetrics | null>(null)
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  // Previous metrics serialized, so a re-read that yields identical values does
  // not trigger a state update (avoids churn re-renders on every keystroke).
  const prevMetricsKeyRef = useRef<string>('')

  // Read the textarea's computed metrics, skipping the setState when nothing
  // changed. Stable callback shared by the mount/resize effect and the
  // value-change effect below.
  const readMetricsIfChanged = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    const next = readMetrics(ta)
    const key = JSON.stringify(next)
    if (key === prevMetricsKeyRef.current) return
    prevMetricsKeyRef.current = key
    setMetrics(next)
  }, [textareaRef])

  // Mount + resize-driven re-read. The ResizeObserver catches every textarea
  // resize (including the auto-grow height change when the value changes).
  useEffect(() => {
    readMetricsIfChanged()
    const ta = textareaRef.current
    if (!ta) return
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(readMetricsIfChanged) : null
    ro?.observe(ta)
    return () => {
      ro?.disconnect()
    }
  }, [textareaRef, readMetricsIfChanged])

  // (Value-driven changes are covered by the ResizeObserver above: typing onto a
  // new line auto-grows the textarea box, which fires the observer and re-reads.
  // Typing on an unchanged line box changes no metrics, so no re-read is needed.
  // A font-family/theme switch without a box resize is a known rare gap — it
  // would need a theme-change signal this component does not own.)

  // Sync scroll position from the textarea to the overlay content so long
  // text stays aligned when the textarea scrolls.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const sync = (): void => setScroll({ top: ta.scrollTop, left: ta.scrollLeft })
    sync()
    ta.addEventListener('scroll', sync, { passive: true })
    return () => {
      ta.removeEventListener('scroll', sync)
    }
  }, [textareaRef])

  if (!metrics) return null
  const segments = parseSkillSegments(value)

  // Overlay box matches the textarea's border box (same padding + border +
  // width + box-sizing). Text wraps with the same white-space/word-break so
  // chip positions line up with the transparent textarea text. The content
  // layer is translated by the textarea's scroll offset to mirror scrolling.
  const overlayStyle: CSSProperties = {
    fontFamily: metrics.fontFamily,
    fontSize: metrics.fontSize,
    fontWeight: metrics.fontWeight,
    fontStyle: metrics.fontStyle,
    fontVariant: metrics.fontVariant,
    lineHeight: metrics.lineHeight,
    letterSpacing: metrics.letterSpacing,
    paddingTop: metrics.paddingTop,
    paddingRight: metrics.paddingRight,
    paddingBottom: metrics.paddingBottom,
    paddingLeft: metrics.paddingLeft,
    borderTopWidth: metrics.borderTopWidth,
    borderRightWidth: metrics.borderRightWidth,
    borderBottomWidth: metrics.borderBottomWidth,
    borderLeftWidth: metrics.borderLeftWidth,
    width: metrics.width,
    height: metrics.height,
    boxSizing: metrics.boxSizing as CSSProperties['boxSizing'],
    textTransform: metrics.textTransform,
    tabSize: metrics.tabSize,
    whiteSpace: metrics.whiteSpace || 'pre-wrap',
    wordBreak: (metrics.wordBreak || 'break-word') as CSSProperties['wordBreak'],
    overflowWrap: (metrics.overflowWrap || 'break-word') as CSSProperties['overflowWrap'],
    color: 'var(--foreground, currentColor)'
  }

  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 z-0 overflow-hidden', className)}
      style={overlayStyle}
    >
      <div
        style={{
          transform: `translate(${-scroll.left}px, ${-scroll.top}px)`,
          willChange: 'transform'
        }}
      >
        {segments.length === 0 ? (
          <span>{''}</span>
        ) : (
          segments.map((seg, i) =>
            seg.kind === 'skill' ? (
              <SkillChip key={`skill-${i}`} name={seg.name} />
            ) : (
              <span key={`text-${i}`}>{seg.text}</span>
            )
          )
        )}
      </div>
    </div>
  )
}
