import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from '@/components/icons'
import { TOOL_STRIP_WIDTH } from '@/components/shell/tool-strip/ToolStrip'
import { TRAFFIC_LIGHT_CLEARANCE_PX } from '@/components/shell/traffic-light-inset'
import { windowApi } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Marks the controls non-draggable so they stay clickable inside a drag-region row. */
const titlebarNoDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

/** Three 40px buttons. */
export const WINDOW_CONTROLS_WIDTH = 120

/** What the controls take from the top row left of the tool strip. */
export const WINDOW_CONTROLS_INSET_PX = WINDOW_CONTROLS_WIDTH - TOOL_STRIP_WIDTH

const WINDOW_CONTROL_BASE =
  'h-full w-10 inline-flex items-center justify-center focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset cursor-pointer'
const windowControlClass = `${WINDOW_CONTROL_BASE} hover:bg-secondary/80`

/**
 * Windows/Linux window controls (minimize, maximize or restore, close). The
 * shell renders them once, in the window's top-right corner above the tool
 * strip (`ShellFrame`). Renders nothing unless `windowControls`.
 */
export function WindowControls({
  windowControls,
  className
}: {
  windowControls: boolean
  className?: string
}): React.JSX.Element | null {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!windowControls) return
    return windowApi.onMaximizeChange((maximized) => {
      setIsMaximized(maximized)
    })
  }, [windowControls])

  if (!windowControls) return null

  return (
    <div
      className={cn('relative z-[100] flex h-full shrink-0 items-center', className)}
      style={{ ...titlebarNoDragStyle, width: WINDOW_CONTROLS_WIDTH }}
      data-testid="window-controls"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void windowApi.minimize()
        }}
        className={windowControlClass}
        title="Minimize"
        aria-label="Minimize window"
      >
        <Minus size={16} />
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void windowApi.toggleMaximize().then((result) => {
            if (!result.success) {
              console.error(`Failed to toggle maximize: ${result.error ?? 'unknown error'}`)
            }
          })
        }}
        className={windowControlClass}
        title={isMaximized ? 'Restore' : 'Maximize'}
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
      >
        {isMaximized ? <Copy size={14} /> : <Square size={14} />}
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void windowApi.close()
        }}
        className={`${WINDOW_CONTROL_BASE} hover:bg-destructive-fill hover:text-destructive-foreground`}
        title="Close"
        aria-label="Close window"
      >
        <X size={16} />
      </button>
    </div>
  )
}

/**
 * End of the top row surface next to the window controls: a drag-region
 * spacer as wide as the part of the controls left of the tool strip
 * ({@link WINDOW_CONTROLS_INSET_PX}). Renders nothing unless `windowControls`.
 */
export function WindowControlsInset({
  windowControls
}: {
  windowControls: boolean
}): React.JSX.Element | null {
  if (!windowControls) return null
  return (
    <div
      className="h-full shrink-0"
      style={{ width: WINDOW_CONTROLS_INSET_PX }}
      data-testid="window-controls-inset"
      data-tauri-drag-region
    />
  )
}

/**
 * Spacer that clears the native macOS traffic lights
 * ({@link TRAFFIC_LIGHT_CLEARANCE_PX}). It is its own drag handle. Renders
 * nothing unless `trafficLights`.
 */
export function TrafficLightClearance({
  trafficLights
}: {
  trafficLights: boolean
}): React.JSX.Element | null {
  if (!trafficLights) return null
  return (
    <div
      className="shrink-0"
      style={{ width: TRAFFIC_LIGHT_CLEARANCE_PX }}
      data-testid="traffic-light-clearance"
      data-tauri-drag-region
    />
  )
}
