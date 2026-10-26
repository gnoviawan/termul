/**
 * The `<Toaster />` of the sonner shim: the queue `toast(...)` publishes,
 * painted the way sonner 1.7 paints `src/renderer/components/ui/sonner.tsx`
 * with `sonner.css`: a 356 px card 20 px from the bottom-right corner, the
 * status icon tinted by kind, the round close button over the top-left
 * corner, cancel and action buttons at the end of the row. The newest toast
 * is in front; up to three older ones pile behind it, each 14 px higher and
 * 5 % narrower with its content hidden, and hovering the pile spreads it out
 * and pauses every timer. GPUIX has no transforms, so the pile's scale is a
 * smaller box instead.
 */

import type { EventPayload, StyleDesc } from '@gpuix/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useAppearanceMode } from '@/stores/app-settings-store'
import { createPortal } from '../compat/react-dom'
import { tw } from '../style/tw'
import { subscribeToasts, type ToastButton, type ToastKind, type ToastRecord } from './sonner'

export interface ToasterProps {
  visibleToasts?: number
  duration?: number
  closeButton?: boolean
  offset?: unknown
  [prop: string]: unknown
}

const WIDTH = 356
const GAP = 14
const EDGE = 20
const PILE_SCALE_STEP = 0.05
/**
 * sonner sets its own stack on the toaster (`ui-sans-serif, system-ui, ...,
 * Arial, ...`), so toasts are not in Inter. GPUIX takes one family; Arial is
 * the entry Chromium lands on under Linux, where fontconfig serves Liberation
 * Sans for it.
 */
const TOAST_FONT = 'Arial'

const svg = (viewBox: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="black">${body}</svg>`

/** sonner's own icons (`dist/index.mjs`), painted in the kind's colour. */
const ICONS: Partial<Record<ToastKind, string>> = {
  success: svg(
    '0 0 20 20',
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"/>'
  ),
  warning: svg(
    '0 0 24 24',
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z"/>'
  ),
  info: svg(
    '0 0 20 20',
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"/>'
  ),
  error: svg(
    '0 0 20 20',
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"/>'
  ),
  loading: svg(
    '0 0 16 16',
    Array.from({ length: 12 }, (_, i) => {
      const angle = (i * 30 * Math.PI) / 180
      const x = 8 + Math.sin(angle) * 5
      const y = 8 - Math.cos(angle) * 5
      return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="1" opacity="${(0.15 + (i / 12) * 0.85).toFixed(2)}"/>`
    }).join('')
  )
}
const CLOSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`

/** `sonner.css`: status lives on the icon; info stays neutral. */
const ICON_CLASS: Record<ToastKind, string> = {
  default: 'text-muted-foreground',
  success: 'text-success',
  error: 'text-destructive',
  info: 'text-muted-foreground',
  warning: 'text-warning',
  loading: 'text-muted-foreground'
}

/** Tailwind important markers (`ml-2!`) are how shared code beats sonner's CSS; here there is nothing to beat. */
const extra = (classes: string | undefined): StyleDesc =>
  classes ? tw(classes.replace(/!/g, '')) : {}

/** The card's content box: sonner's `--width` less its 16px padding and 1px border. */
const CONTENT_WIDTH = WIDTH - 2 * 16 - 2

/**
 * Classes on a child of the card. GPUI lengths have no calc() over a
 * percentage, so a percentage inside calc() resolves here against the card's
 * content box, which is fixed (`basis-[calc(100%-28px)]` on the update toast).
 */
const childExtra = (classes: string | undefined): StyleDesc =>
  extra(
    classes?.replace(/calc\([^)]*\)/g, (expr) =>
      expr.replace(/(\d+(?:\.\d+)?)%/g, (_, pct) => `${(Number(pct) * CONTENT_WIDTH) / 100}px`)
    )
  )

function cardStyle(dark: boolean): StyleDesc {
  return {
    ...tw('bg-card border border-border text-foreground'),
    position: 'absolute',
    right: 0,
    borderRadius: 8,
    ...(dark
      ? {
          boxShadow: {
            offsetX: 0,
            offsetY: 4,
            blurRadius: 12,
            spreadRadius: 0,
            color: 'rgba(0, 0, 0, 0.4)'
          }
        }
      : {})
  }
}

/** sonner closes the toast after either button's handler runs. */
function ButtonBox({
  button,
  classes,
  base,
  onDone
}: {
  button: ToastButton
  classes: string
  base: string
  onDone: () => void
}) {
  return (
    <div
      role="button"
      style={{
        ...tw(base),
        height: 24,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 4,
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        ...extra(classes)
      }}
      onClick={(event) => {
        button.onClick(event)
        onDone()
      }}
    >
      <text>{button.label}</text>
    </div>
  )
}

export function Toaster({
  visibleToasts = 3,
  duration = 4000,
  closeButton = false
}: ToasterProps): ReactNode {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  /** Hovered: the pile spreads out and every timer pauses, as in sonner. */
  const [expanded, setExpanded] = useState(false)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const clocks = useRef(new Map<string | number, { remaining: number; started: number | null }>())
  const dark = useAppearanceMode() !== 'light'

  /** A button click closes the toast without `onDismiss`, as sonner's `deleteToast` does. */
  const remove = useCallback((toast: ToastRecord, reason: 'dismiss' | 'auto' | 'button') => {
    clocks.current.delete(toast.id)
    setToasts((list) => list.filter((t) => t.id !== toast.id))
    if (reason === 'auto') toast.onAutoClose?.(toast)
    else if (reason === 'dismiss') toast.onDismiss?.(toast)
  }, [])

  useEffect(
    () =>
      subscribeToasts((event) => {
        if (event.type === 'dismiss') {
          setToasts((list) => {
            const gone = list.filter((t) => event.id === undefined || t.id === event.id)
            for (const t of gone) {
              clocks.current.delete(t.id)
              t.onDismiss?.(t)
            }
            return list.filter((t) => !gone.includes(t))
          })
          return
        }
        clocks.current.delete(event.toast.id)
        setToasts((list) => {
          const at = list.findIndex((t) => t.id === event.toast.id)
          if (at < 0) return [...list, event.toast]
          const next = [...list]
          next[at] = event.toast
          return next
        })
      }),
    []
  )

  useEffect(() => {
    if (expanded) return
    const now = performance.now()
    const timers: Array<ReturnType<typeof setTimeout>> = []
    for (const t of toasts) {
      const total = t.duration ?? duration
      if (t.kind === 'loading' || !Number.isFinite(total)) continue
      const clock = clocks.current.get(t.id) ?? { remaining: total, started: null }
      clock.started = now
      clocks.current.set(t.id, clock)
      timers.push(setTimeout(() => remove(t, 'auto'), Math.max(0, clock.remaining)))
    }
    return () => {
      const stopped = performance.now()
      for (const timer of timers) clearTimeout(timer)
      for (const clock of clocks.current.values()) {
        if (clock.started === null) continue
        clock.remaining -= stopped - clock.started
        clock.started = null
      }
    }
  }, [toasts, expanded, duration, remove])

  useEffect(() => {
    if (toasts.length === 0) setExpanded(false)
  }, [toasts.length])

  if (toasts.length === 0) return null
  const shown = toasts.slice(-visibleToasts)
  const front = shown[shown.length - 1]
  const frontHeight = heights[String(front.id)] ?? 0
  const measure = (id: string | number) => (event: EventPayload) => {
    const height = event.height
    if (height === undefined) return
    setHeights((map) => (map[String(id)] === height ? map : { ...map, [String(id)]: height }))
  }

  const full = (t: ToastRecord, bottom: number) => {
    const icon = ICONS[t.kind]
    return (
      <div
        key={t.id}
        testId="toast"
        onLayout={measure(t.id)}
        style={{
          ...cardStyle(dark),
          bottom,
          width: WIDTH,
          padding: 16,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          fontFamily: TOAST_FONT,
          ...extra(t.classNames?.toast)
        }}
      >
        {closeButton ? (
          <div
            role="button"
            aria-label="Close toast"
            style={{
              ...tw('bg-card border border-border text-muted-foreground'),
              position: 'absolute',
              left: -7,
              top: -7,
              width: 20,
              height: 20,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              hover: tw('bg-secondary text-foreground')
            }}
            onClick={() => remove(t, 'dismiss')}
          >
            <svg source={CLOSE_ICON} style={{ width: 12, height: 12 }} />
          </div>
        ) : null}
        {icon ? (
          <svg
            source={icon}
            style={{
              ...tw(ICON_CLASS[t.kind]),
              width: 16,
              height: 16,
              flexShrink: 0,
              marginLeft: -3,
              marginRight: 4
            }}
          />
        ) : null}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            ...childExtra(t.classNames?.content)
          }}
        >
          <text style={{ fontWeight: 500, lineHeight: 19.5, ...extra(t.classNames?.title) }}>
            {t.message}
          </text>
          {t.description ? (
            <text
              style={{
                ...tw('text-muted-foreground'),
                fontWeight: 400,
                lineHeight: 18.2,
                ...extra(t.classNames?.description)
              }}
            >
              {t.description}
            </text>
          ) : null}
        </div>
        {t.cancel || t.action ? <div style={{ flexGrow: 1 }} /> : null}
        {t.cancel ? (
          <ButtonBox
            button={t.cancel}
            classes={t.classNames?.cancelButton ?? ''}
            base="bg-secondary text-secondary-foreground"
            onDone={() => remove(t, 'button')}
          />
        ) : null}
        {/* Both buttons take `margin-left: auto` in sonner, so the free space splits around the cancel button. */}
        {t.cancel && t.action && !t.classNames?.actionButton ? (
          <div style={{ flexGrow: 1 }} />
        ) : null}
        {t.action ? (
          <ButtonBox
            button={t.action}
            classes={t.classNames?.actionButton ?? ''}
            base="bg-primary-fill text-primary-foreground"
            onDone={() => remove(t, 'button')}
          />
        ) : null}
      </div>
    )
  }

  let stack: ReactNode[]
  let height: number
  if (expanded && shown.length > 1) {
    let bottom = 0
    stack = [...shown].reverse().map((t) => {
      const node = full(t, bottom)
      bottom += (heights[String(t.id)] ?? frontHeight) + GAP
      return node
    })
    stack.reverse()
    height = Math.max(0, bottom - GAP)
  } else {
    // sonner: an older toast takes the front toast's height, scales by 1 - 0.05n about its centre and lifts 14n px.
    stack = shown.slice(0, -1).map((t, index) => {
      const n = shown.length - 1 - index
      const scale = 1 - PILE_SCALE_STEP * n
      return (
        <div
          key={t.id}
          style={{
            ...cardStyle(dark),
            right: (WIDTH * (1 - scale)) / 2,
            width: WIDTH * scale,
            height: frontHeight * scale,
            bottom: (frontHeight * (1 - scale)) / 2 + GAP * n
          }}
        />
      )
    })
    stack.push(full(front, 0))
    height = frontHeight
  }

  return createPortal(
    <div
      testId="toaster"
      style={{ position: 'absolute', bottom: EDGE, right: EDGE, width: WIDTH, height }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {stack}
    </div>,
    null
  )
}
