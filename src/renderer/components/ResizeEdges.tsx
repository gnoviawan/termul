import { useCallback } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isLinux } from '@/lib/platform'

/**
 * Resize edges (Linux only).
 *
 * Tauri windows on Linux use `decorations: false` so the WM doesn't draw
 * the title bar / borders. The trade-off is that GTK no longer offers
 * native edge-resize hit zones — users can't grab the edges of the window
 * to resize it.
 *
 * We add eight thin invisible regions (4 edges + 4 corners) that call
 * `startResizeDragging(direction)` on pointer-down. They are absolutely
 * positioned, kept narrow (4px edges, 8px corners), and have
 * `pointer-events: auto` so they don't interfere with the rest of the UI.
 *
 * No-op on macOS / Windows: the OS's own decorations + drag handlers
 * already manage resize there. Render nothing to avoid a phantom layer.
 */

type Direction =
  | 'North'
  | 'NorthEast'
  | 'East'
  | 'SouthEast'
  | 'South'
  | 'SouthWest'
  | 'West'
  | 'NorthWest'

const EDGE = 4 // px — narrow enough not to swallow nearby clicks
const CORNER = 8 // px — slightly bigger so corner is grabbable

interface Region {
  direction: Direction
  cursor: React.CSSProperties['cursor']
  style: React.CSSProperties
}

const REGIONS: Region[] = [
  // Edges
  {
    direction: 'North',
    cursor: 'n-resize',
    style: { top: 0, left: 0, right: 0, height: EDGE },
  },
  {
    direction: 'South',
    cursor: 's-resize',
    style: { bottom: 0, left: 0, right: 0, height: EDGE },
  },
  {
    direction: 'West',
    cursor: 'w-resize',
    style: { top: 0, bottom: 0, left: 0, width: EDGE },
  },
  {
    direction: 'East',
    cursor: 'e-resize',
    style: { top: 0, bottom: 0, right: 0, width: EDGE },
  },
  // Corners (rendered after edges so they win on z-order overlap).
  {
    direction: 'NorthWest',
    cursor: 'nw-resize',
    style: { top: 0, left: 0, width: CORNER, height: CORNER },
  },
  {
    direction: 'NorthEast',
    cursor: 'ne-resize',
    style: { top: 0, right: 0, width: CORNER, height: CORNER },
  },
  {
    direction: 'SouthWest',
    cursor: 'sw-resize',
    style: { bottom: 0, left: 0, width: CORNER, height: CORNER },
  },
  {
    direction: 'SouthEast',
    cursor: 'se-resize',
    style: { bottom: 0, right: 0, width: CORNER, height: CORNER },
  },
]

export function ResizeEdges(): React.JSX.Element | null {
  const handlePointerDown = useCallback(
    (direction: Direction) => async (event: React.PointerEvent) => {
      // Only the primary (left) button starts a resize.
      if (event.button !== 0) return
      // Don't fight other drag handlers (e.g. tab reorder).
      event.preventDefault()
      try {
        await getCurrentWindow().startResizeDragging(direction)
      } catch {
        // Resize can fail when the window is maximized; that's fine,
        // just no-op. The WM handles maximized windows itself.
      }
    },
    [],
  )

  // Only render on Linux. On Windows/macOS the OS handles edge resize.
  if (!isLinux) return null

  return (
    <div
      className="pointer-events-none fixed inset-0 z-50"
      aria-hidden="true"
    >
      {REGIONS.map((region) => (
        <div
          key={region.direction}
          className="pointer-events-auto absolute"
          style={{ ...region.style, cursor: region.cursor }}
          onPointerDown={handlePointerDown(region.direction)}
        />
      ))}
    </div>
  )
}
