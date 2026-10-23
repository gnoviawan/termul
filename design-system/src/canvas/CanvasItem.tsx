import { type KeyboardEvent, memo, type PointerEvent, useEffect, useRef, useState } from 'react'
import { GripVertical } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { PlacedEntry } from '../registry/types'
import { clampPoint, type Point } from './camera'

const KEY_STEP = 8
const KEY_STEP_LARGE = 40
const DRAG_THRESHOLD = 3

type CopyState = 'idle' | 'copied' | 'failed'

interface CanvasItemProps {
  entry: PlacedEntry
  position: Point
  getZoom: () => number
  onMove: (id: string, position: Point) => void
}

/**
 * One canvas item: a header with a move handle and a copyable name, and a
 * fixed-size frame that renders the live preview. The preview owns its own
 * pointer and keyboard behavior; only the handle moves the item.
 */
export const CanvasItem = memo(function CanvasItem({
  entry,
  position,
  getZoom,
  onMove
}: CanvasItemProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const copyTimer = useRef<number | undefined>(undefined)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: Point
    current: Point
    moved: boolean
  } | null>(null)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const place = (point: Point) => {
    const node = rootRef.current
    if (!node) return
    node.style.left = `${point.x}px`
    node.style.top = `${point.y}px`
  }

  const copyName = async () => {
    window.clearTimeout(copyTimer.current)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(entry.name)
      setCopyState('copied')
      copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1400)
    } catch {
      setCopyState('failed')
    }
  }

  const onHandlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
      current: position,
      moved: false
    }
  }

  const onHandlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    const zoom = getZoom()
    drag.current = clampPoint({ x: drag.origin.x + dx / zoom, y: drag.origin.y + dy / zoom })
    place(drag.current)
  }

  const endDrag = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!drag.moved) return
    if (commit) {
      onMove(entry.id, drag.current)
    } else {
      place(drag.origin)
    }
  }

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const delta: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step }
    }
    const move = delta[event.key]
    if (!move) return
    event.preventDefault()
    event.stopPropagation()
    onMove(entry.id, clampPoint({ x: position.x + move.x, y: position.y + move.y }))
  }

  return (
    <div
      ref={rootRef}
      data-canvas-item={entry.id}
      className="absolute flex flex-col gap-2"
      style={{ left: position.x, top: position.y, width: entry.width }}
    >
      <div className="flex h-7 min-w-0 items-center gap-1 text-xs">
        <button
          type="button"
          aria-label={`Move ${entry.name}`}
          aria-describedby="canvas-move-hint"
          className={cn(
            'grid size-7 shrink-0 cursor-default touch-none place-items-center rounded-md text-muted-foreground',
            'transition-colors duration-[var(--duration-quick)] hover:bg-row-hover hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={(event) => endDrag(event, true)}
          onPointerCancel={(event) => endDrag(event, false)}
          onLostPointerCapture={(event) => endDrag(event, true)}
          onKeyDown={onHandleKeyDown}
        >
          <GripVertical size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={cn(
            'group/name flex min-w-0 max-w-[75%] shrink-0 cursor-default items-center gap-2 rounded-md px-1.5 py-1 font-medium text-foreground',
            'transition-colors duration-[var(--duration-quick)] hover:bg-row-hover',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
          onClick={copyName}
          aria-label={`${entry.name}. Copy name`}
        >
          <span className="truncate">{entry.name}</span>
          <span
            className={cn(
              'shrink-0 font-normal text-muted-foreground',
              copyState === 'idle' &&
                'hidden group-hover/name:inline group-focus-visible/name:inline'
            )}
          >
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? '' : 'Copy name'}
          </span>
        </button>
        {copyState === 'failed' ? (
          <input
            readOnly
            aria-label={`${entry.name}, select to copy`}
            value={entry.name}
            className="h-6 min-w-0 flex-1 rounded-md border border-field-border bg-background px-1.5 text-xs text-foreground"
            onFocus={(event) => event.currentTarget.select()}
            // biome-ignore lint/a11y/noAutofocus: focus moves to the fallback right after a failed copy.
            autoFocus
            onBlur={() => setCopyState('idle')}
          />
        ) : (
          <span
            title={entry.source}
            className="ml-auto min-w-0 truncate pl-2 font-mono text-2xs text-muted-foreground"
          >
            {entry.source.replace(/^src\/renderer\//, '')}
          </span>
        )}
        <span className="sr-only" aria-live="polite">
          {copyState === 'copied' ? `Copied ${entry.name}` : ''}
          {copyState === 'failed' ? 'Copy unavailable. The name is selected for manual copy.' : ''}
        </span>
      </div>
      <div
        className="relative overflow-auto overscroll-contain rounded-xl border border-border bg-background text-foreground"
        style={{ height: entry.height }}
        data-preview-frame
      >
        <entry.Preview />
      </div>
    </div>
  )
})
