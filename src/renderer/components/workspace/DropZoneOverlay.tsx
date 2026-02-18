import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import type { DropPosition } from '@/types/workspace.types'

interface DropZoneOverlayProps {
  paneId: string
}

export function DropZoneOverlay({ paneId }: DropZoneOverlayProps): React.JSX.Element {
  const { handleDrop, previewTarget, setPreviewTarget, clearPreviewTarget } = usePaneDnd()

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

  return (
    <div
      className="absolute inset-0 z-50 pointer-events-auto"
      onDragLeave={onOverlayDragLeave}
    >
      <div
        className={cn(
          'absolute left-0 top-0 w-1/4 h-full transition-colors',
          hoveredZone === 'left' && 'bg-primary/10'
        )}
        {...createZoneHandlers('left')}
      />

      <div
        className={cn(
          'absolute right-0 top-0 w-1/4 h-full transition-colors',
          hoveredZone === 'right' && 'bg-primary/10'
        )}
        {...createZoneHandlers('right')}
      />

      <div
        className={cn(
          'absolute left-1/4 top-0 w-1/2 h-1/4 transition-colors',
          hoveredZone === 'top' && 'bg-primary/10'
        )}
        {...createZoneHandlers('top')}
      />

      <div
        className={cn(
          'absolute left-1/4 bottom-0 w-1/2 h-1/4 transition-colors',
          hoveredZone === 'bottom' && 'bg-primary/10'
        )}
        {...createZoneHandlers('bottom')}
      />

      <div
        className={cn(
          'absolute left-1/4 top-1/4 w-1/2 h-1/2 transition-colors',
          hoveredZone === 'center' && 'bg-primary/10'
        )}
        {...createZoneHandlers('center')}
      />
    </div>
  )
}
