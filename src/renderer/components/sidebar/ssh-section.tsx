import { useCallback, useEffect, useRef } from 'react'
import { PANEL_HEADER_CLASS } from '@/components/ui/panel-styles'
import { useHostGate } from '@/hooks/use-host-gate'
import { canUseHostSsh } from '@/lib/ssh-api'
import { cn } from '@/lib/utils'
import { useShellLayoutStore, useSshSectionHeight } from '@/stores/shell-layout-store'
import { useSSHPanelVisible } from '@/stores/ssh-panel-store'
import { SSHPanel } from '../ssh/SSHPanel'
import { SSHSectionChevron } from '../ssh/SSHSectionChevron'

// ============================================================================
// SSH Resizable Section
// ============================================================================

export function SSHResizableSection({
  onSSHConnect,
  onSelectProfile,
  activeProfileId
}: {
  onSSHConnect?: (profileId: string) => void
  onSelectProfile?: (profileId: string) => void
  activeProfileId?: string | null
}): React.JSX.Element | null {
  const isVisible = useSSHPanelVisible()
  const height = useSshSectionHeight()
  const hostSsh = useHostGate(canUseHostSsh)

  const isDragging = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)
  // Tracks the document listeners for the in-flight resize so they can be torn
  // down if the component unmounts mid-drag (e.g. SSH panel toggled off).
  const activeDragCleanup = useRef<(() => void) | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startY.current = e.clientY
      startHeight.current = height
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return
        // Dragging UP = increase height (startY - currentY)
        const delta = startY.current - ev.clientY
        // The store clamps to SHELL_LAYOUT_BOUNDS and persists the shell-layout record.
        useShellLayoutStore.getState().setSshSectionHeight(startHeight.current + delta)
      }

      const handleMouseUp = () => {
        isDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        activeDragCleanup.current = null
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      // Expose a teardown for unmount-during-drag cleanup.
      activeDragCleanup.current = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    },
    [height]
  )

  // Tear down an in-flight resize: remove the document listeners and reset the
  // body styles. Stable across renders (refs only).
  const teardownActiveDrag = useCallback(() => {
    if (!activeDragCleanup.current) return
    activeDragCleanup.current()
    activeDragCleanup.current = null
    isDragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  // Clean up an in-flight resize when the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      teardownActiveDrag()
    }
  }, [teardownActiveDrag])

  // Also clean up when the panel is hidden: the component returns null but stays
  // mounted, so the unmount effect above does not run on visibility change.
  useEffect(() => {
    if (!isVisible) {
      teardownActiveDrag()
    }
  }, [isVisible, teardownActiveDrag])

  // Issue #843: the SSH/SFTP panel shows only where the host runs SSH for
  // this client (desktop, host-local web), rather than rendering profiles
  // with disabled Connect actions.
  if (!hostSsh) return null

  // The section collapses to a header-only row instead of disappearing, so it
  // can be expanded again from the same place.
  if (!isVisible) {
    return (
      <div className="flex-shrink-0 border-t border-border">
        <div className={cn(PANEL_HEADER_CLASS, 'h-9 justify-start gap-1')}>
          <SSHSectionChevron expanded={false} />
          <span className="label-panel">SSH</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-shrink-0 flex flex-col" style={{ height: `${height}px` }}>
      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className="group flex h-0.75 cursor-row-resize items-center justify-center border-t border-border transition-colors duration-150 ease-out hover:bg-foreground/[0.06] active:bg-foreground/[0.1]"
        title="Drag to resize"
      >
        <div className="h-0.5 w-8 rounded-full bg-muted-foreground/0 group-hover:bg-muted-foreground/30 transition-colors" />
      </div>
      {/* SSH Panel content */}
      <div className="flex-1 overflow-hidden">
        <SSHPanel
          onConnect={onSSHConnect}
          onSelectProfile={onSelectProfile}
          activeProfileId={activeProfileId}
          headerLead={<SSHSectionChevron expanded />}
        />
      </div>
    </div>
  )
}
