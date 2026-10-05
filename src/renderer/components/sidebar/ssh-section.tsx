import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useSSHPanelVisible } from '@/stores/ssh-panel-store'
import { SSHPanel } from '../ssh/SSHPanel'

// ============================================================================
// SSH Resizable Section
// ============================================================================

const SSH_HEIGHT_KEY = 'termul-ssh-panel-height'
const SSH_MIN_HEIGHT = 48
const SSH_MAX_HEIGHT = 400
const SSH_DEFAULT_HEIGHT = 140

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
  const [height, setHeight] = useState(() => {
    try {
      const saved = localStorage.getItem(SSH_HEIGHT_KEY)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= SSH_MIN_HEIGHT && parsed <= SSH_MAX_HEIGHT) return parsed
      }
    } catch {
      return SSH_DEFAULT_HEIGHT
    }
    return SSH_DEFAULT_HEIGHT
  })

  const isDragging = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)
  const latestHeight = useRef(height)
  // Tracks the document listeners for the in-flight resize so they can be torn
  // down if the component unmounts mid-drag (e.g. SSH panel toggled off).
  const activeDragCleanup = useRef<(() => void) | null>(null)

  useEffect(() => {
    latestHeight.current = height
  }, [height])

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
        const newHeight = Math.min(
          SSH_MAX_HEIGHT,
          Math.max(SSH_MIN_HEIGHT, startHeight.current + delta)
        )
        setHeight(newHeight)
      }

      const handleMouseUp = () => {
        isDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        activeDragCleanup.current = null
        // Persist
        try {
          localStorage.setItem(SSH_HEIGHT_KEY, String(latestHeight.current))
        } catch {
          // Ignore storage errors in restricted environments.
        }
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

  // Persist on height change (debounced via ref)
  useEffect(() => {
    try {
      localStorage.setItem(SSH_HEIGHT_KEY, String(height))
    } catch {
      // Ignore storage errors in restricted environments.
    }
  }, [height])

  // Tear down an in-flight resize: remove the document listeners, reset the body
  // styles, and persist the latest height. Stable across renders (refs only).
  const teardownActiveDrag = useCallback(() => {
    if (!activeDragCleanup.current) return
    activeDragCleanup.current()
    activeDragCleanup.current = null
    isDragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    try {
      localStorage.setItem(SSH_HEIGHT_KEY, String(latestHeight.current))
    } catch {
      // Ignore storage errors in restricted environments.
    }
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

  // Desktop-only surface (issue #843): the SSH/SFTP panel is hidden on web —
  // connect/SFTP/port-forwarding are `WEB_UNSUPPORTED` — rather than
  // rendering profiles with disabled Connect actions.
  if (!isTauriContext() || !isVisible) return null

  return (
    <div className="flex-shrink-0 flex flex-col" style={{ height: `${height}px` }}>
      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className="h-[3px] border-t border-sidebar-border cursor-row-resize hover:bg-primary/30 active:bg-primary/50 transition-colors group flex items-center justify-center"
        title="Drag to resize"
      >
        <div className="w-8 h-[2px] rounded-full bg-muted-foreground/0 group-hover:bg-muted-foreground/30 transition-colors" />
      </div>
      {/* SSH Panel content */}
      <div className="flex-1 overflow-hidden">
        <SSHPanel
          onConnect={onSSHConnect}
          onSelectProfile={onSelectProfile}
          activeProfileId={activeProfileId}
        />
      </div>
    </div>
  )
}
