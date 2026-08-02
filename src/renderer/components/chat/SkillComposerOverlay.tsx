import { type CSSProperties, useEffect, useRef, useState } from 'react'
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

  // Read the textarea's computed metrics so the overlay text wraps identically.
  // The ResizeObserver catches every textarea resize (including the auto-grow
  // height change when the value changes), so the metrics stay current without
  // listing `value` as a dependency (mutating it doesn't re-run the effect).
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const read = (): void => setMetrics(readMetrics(ta))
    read()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    ro?.observe(ta)
    return () => {
      ro?.disconnect()
    }
  }, [textareaRef])

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
              <SkillChip key={`skill-${i}`} name={seg.name} readOnly />
            ) : (
              <span key={`text-${i}`}>{seg.text}</span>
            )
          )
        )}
      </div>
    </div>
  )
}
