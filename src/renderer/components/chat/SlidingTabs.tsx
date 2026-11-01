import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef
} from 'react'
import { cn } from '@/lib/utils'

export interface SlidingTab<T extends string> {
  id: T
  label: ReactNode
  panel: ReactNode
}

interface SlidingTabsProps<T extends string> {
  tabs: readonly SlidingTab<T>[]
  active: T
  onActiveChange: (id: T) => void
  /** Accessible name of the tab list. */
  label: string
  /** Drag the panels with a horizontal touch swipe (phone sheet). */
  swipe?: boolean
  tabListClassName?: string
}

/** Movement before a drag commits to an axis; vertical keeps scrolling the list. */
const AXIS_LOCK_PX = 8
/** Resistance past the first or last tab. */
const RUBBER_BAND = 0.3
/** A release past this share of the width, or faster than this, changes tab. */
const SNAP_DISTANCE = 0.25
const SNAP_VELOCITY_PX_PER_MS = 0.4

const SLIDE =
  'duration-[var(--duration-medium)] ease-[var(--ease-smooth-out)] motion-reduce:transition-none group-data-[dragging]/tabs:transition-none'

interface Drag {
  pointerId: number
  x: number
  y: number
  startedAt: number
  width: number
  dx: number
  axis: 'x' | 'y' | null
}

function placeTrack(
  indicator: HTMLElement | null,
  track: HTMLElement | null,
  index: number,
  count: number,
  dragPx: number,
  width: number
): void {
  const position = Math.min(count - 1, Math.max(0, index - dragPx / width))
  if (indicator) indicator.style.transform = `translateX(${position * 100}%)`
  if (track) track.style.transform = `translateX(calc(${(-index * 100) / count}% + ${dragPx}px))`
}

function fitViewport(viewport: HTMLElement | null, panel: HTMLElement | null | undefined): void {
  if (viewport && panel) viewport.style.height = `${panel.offsetHeight}px`
}

/**
 * Tabs whose panels sit side by side in one track. A switch slides the track,
 * the indicator and the viewport height without remounting either panel, so
 * the overlay around them stays put. Positions are written straight to the
 * DOM: a drag moves only transforms, with no React render per frame.
 */
export function SlidingTabs<T extends string>({
  tabs,
  active,
  onActiveChange,
  label,
  swipe = false,
  tabListClassName
}: SlidingTabsProps<T>): React.JSX.Element {
  const baseId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const panelRefs = useRef<(HTMLDivElement | null)[]>([])
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)

  const count = tabs.length
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === active)
  )
  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex

  const place = (dragPx: number, width: number) =>
    placeTrack(indicatorRef.current, trackRef.current, activeIndexRef.current, count, dragPx, width)

  useLayoutEffect(() => {
    placeTrack(indicatorRef.current, trackRef.current, activeIndex, count, 0, 1)
    panelRefs.current.forEach((panel, i) => {
      panel?.toggleAttribute('inert', i !== activeIndex)
    })
    fitViewport(viewportRef.current, panelRefs.current[activeIndex])
  }, [activeIndex, count])

  useEffect(() => {
    const observer = new ResizeObserver(() =>
      fitViewport(viewportRef.current, panelRefs.current[activeIndexRef.current])
    )
    for (let i = 0; i < count; i++) {
      const panel = panelRefs.current[i]
      if (panel) observer.observe(panel)
    }
    return () => observer.disconnect()
  }, [count])

  const select = (index: number) => {
    const next = tabs[Math.min(count - 1, Math.max(0, index))]
    if (next.id !== active) onActiveChange(next.id)
  }

  const onTabKeyDown = (event: KeyboardEvent) => {
    const target = {
      ArrowRight: activeIndex + 1,
      ArrowLeft: activeIndex - 1,
      Home: 0,
      End: count - 1
    }[event.key]
    if (target === undefined) return
    event.preventDefault()
    const index = Math.min(count - 1, Math.max(0, target))
    tabRefs.current[index]?.focus()
    select(index)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!swipe || event.pointerType === 'mouse') return
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      width: viewportRef.current?.offsetWidth || 1,
      dx: 0,
      axis: null
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (!current.axis) {
      if (Math.hypot(dx, dy) < AXIS_LOCK_PX) return
      current.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (current.axis === 'x') rootRef.current?.setAttribute('data-dragging', '')
    }
    if (current.axis !== 'x') return
    const index = activeIndexRef.current
    const pastEdge = (index === 0 && dx > 0) || (index === count - 1 && dx < 0)
    current.dx = pastEdge ? dx * RUBBER_BAND : dx
    place(current.dx, current.width)
  }

  const onPointerCancel = (event: PointerEvent) => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    drag.current = null
    if (current.axis !== 'x') return
    rootRef.current?.removeAttribute('data-dragging')
    place(0, 1)
  }

  const onPointerEnd = (event: PointerEvent) => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    drag.current = null
    if (current.axis !== 'x') return
    rootRef.current?.removeAttribute('data-dragging')
    // The release would also click the row under the finger.
    suppressClick.current = true
    setTimeout(() => {
      suppressClick.current = false
    }, 0)
    const elapsed = Math.max(1, performance.now() - current.startedAt)
    const flung =
      Math.abs(current.dx) > current.width * SNAP_DISTANCE ||
      Math.abs(current.dx) / elapsed > SNAP_VELOCITY_PX_PER_MS
    const index = activeIndexRef.current
    const target = Math.min(
      count - 1,
      Math.max(0, flung ? index + (current.dx < 0 ? 1 : -1) : index)
    )
    if (target === index) place(0, 1)
    else select(target)
  }

  return (
    <div ref={rootRef} className="group/tabs">
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onTabKeyDown}
        className={cn('relative mb-1 flex border-b border-border p-1', tabListClassName)}
      >
        <span
          ref={indicatorRef}
          aria-hidden="true"
          className={cn(
            'absolute inset-y-1 left-1 rounded-md bg-muted transition-transform will-change-transform',
            SLIDE
          )}
          style={{ width: `calc((100% - 0.5rem) / ${count})` }}
        />
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab.id}`}
            aria-selected={i === activeIndex}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={i === activeIndex ? 0 : -1}
            onClick={() => select(i)}
            className={cn(
              'relative z-[1] flex min-h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs transition-colors duration-200 ease-out pointer-coarse:min-h-10 pointer-coarse:text-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              i === activeIndex ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        ref={viewportRef}
        data-tab-viewport=""
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerCancel}
        onClickCapture={(event) => {
          if (!suppressClick.current) return
          event.preventDefault()
          event.stopPropagation()
        }}
        className={cn(
          'overflow-hidden transition-[height]',
          SLIDE,
          swipe && 'touch-pan-y [&_*]:touch-pan-y'
        )}
      >
        <div
          ref={trackRef}
          className={cn('flex items-start transition-transform will-change-transform', SLIDE)}
          style={{ width: `${count * 100}%` }}
        >
          {tabs.map((tab, i) => (
            <div
              key={tab.id}
              ref={(el) => {
                panelRefs.current[i] = el
              }}
              role="tabpanel"
              id={`${baseId}-panel-${tab.id}`}
              aria-labelledby={`${baseId}-tab-${tab.id}`}
              className={cn('min-w-0 flex-none transition-opacity [&[inert]]:opacity-40', SLIDE)}
              style={{ width: `${100 / count}%` }}
            >
              {tab.panel}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
