import { motion, useReducedMotion } from 'framer-motion'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { cn } from '@/lib/utils'
import type { DropPosition } from '@/types/workspace.types'

interface DropZoneOverlayProps {
  paneId: string
}

/**
 * Geometry of each drop zone as insets (percentages of the pane). The single
 * highlight rect morphs between these by transitioning its edges, instead of
 * five independent zones flashing on hover.
 */
const ZONE_RECT: Record<DropPosition, React.CSSProperties> = {
  left: { top: '0%', right: '75%', bottom: '0%', left: '0%' },
  right: { top: '0%', right: '0%', bottom: '0%', left: '75%' },
  top: { top: '0%', right: '25%', bottom: '75%', left: '25%' },
  bottom: { top: '75%', right: '25%', bottom: '0%', left: '25%' },
  center: { top: '25%', right: '25%', bottom: '25%', left: '25%' }
}

const OVERLAY_FADE_S = 0.15

export function DropZoneOverlay({ paneId }: DropZoneOverlayProps): React.JSX.Element {
  const { handleDrop, isDragging, previewTarget, setPreviewTarget, clearPreviewTarget } =
    usePaneDnd()
  const reducedMotion = useReducedMotion() ?? false
  // Remember the last hovered rect so a leave fades the highlight out in
  // place instead of jumping back to the center geometry first.
  const lastRectRef = useRef<React.CSSProperties>(ZONE_RECT.center)

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onZoneDragEnter = useCallback(
    (position: DropPosition, e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setPreviewTarget(paneId, position)
    },
    [paneId, setPreviewTarget]
  )

  const onOverlayDragLeave = useCallback(
    (e: React.DragEvent) => {
      const nextTarget = e.relatedTarget as Node | null
      if (nextTarget && e.currentTarget.contains(nextTarget)) {
        return
      }
      clearPreviewTarget(paneId)
    },
    [paneId, clearPreviewTarget]
  )

  const onZoneDrop = useCallback(
    (position: DropPosition, e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      clearPreviewTarget(paneId, position)
      handleDrop(paneId, position, e)
    },
    [paneId, clearPreviewTarget, handleDrop]
  )

  const createZoneHandlers = useCallback(
    (position: DropPosition) => ({
      onDragEnter: (e: React.DragEvent) => onZoneDragEnter(position, e),
      onDragOver,
      onDrop: (e: React.DragEvent) => onZoneDrop(position, e)
    }),
    [onDragOver, onZoneDragEnter, onZoneDrop]
  )

  const hoveredZone = previewTarget?.paneId === paneId ? previewTarget.position : null
  // Derived each render; the ref only updates post-commit so a discarded
  // concurrent render can't move the highlight.
  const activeRect = hoveredZone ? ZONE_RECT[hoveredZone] : lastRectRef.current
  useLayoutEffect(() => {
    if (hoveredZone) {
      lastRectRef.current = ZONE_RECT[hoveredZone]
    }
  }, [hoveredZone])

  return (
    <motion.div
      className={cn(
        'absolute inset-0 z-50',
        // While the exit fade plays the drag is over — keep the overlay
        // click-through so it can't swallow pane clicks.
        isDragging ? 'pointer-events-auto' : 'pointer-events-none'
      )}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={reducedMotion ? { duration: 0 } : { duration: OVERLAY_FADE_S }}
      onDragLeave={onOverlayDragLeave}
    >
      {/* Single morphing preview highlight — one rect whose edges transition
          to the hovered zone's geometry (150ms, --ease-out). The zone divs
          below are invisible hit targets only. */}
      <div
        aria-hidden
        className="absolute rounded-sm border border-primary/40 bg-primary/10 pointer-events-none transition-[top,right,bottom,left,opacity] duration-150 ease-[var(--ease-out)] motion-reduce:transition-none"
        style={{ ...activeRect, opacity: hoveredZone ? 1 : 0 }}
      />

      <div className="absolute left-0 top-0 w-1/4 h-full" {...createZoneHandlers('left')} />
      <div className="absolute right-0 top-0 w-1/4 h-full" {...createZoneHandlers('right')} />
      <div className="absolute left-1/4 top-0 w-1/2 h-1/4" {...createZoneHandlers('top')} />
      <div className="absolute left-1/4 bottom-0 w-1/2 h-1/4" {...createZoneHandlers('bottom')} />
      <div className="absolute left-1/4 top-1/4 w-1/2 h-1/2" {...createZoneHandlers('center')} />
    </motion.div>
  )
}
