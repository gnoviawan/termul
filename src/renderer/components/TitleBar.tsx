import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { windowApi } from '@/lib/api'
import { isMac } from '@/lib/platform'

const windowControlClass =
  'h-full px-3 hover:bg-secondary/80 inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset cursor-pointer'

/**
 * Slim window-control strip for Windows/Linux.
 *
 * The app runs with `decorations: false` on Windows/Linux, so the in-app
 * minimize/maximize/close controls are required. The strip sits at the top of
 * the content column (right of the ActivityRail) and doubles as a window drag
 * region. On macOS this renders nothing — native traffic lights handle window
 * controls, and the ActivityRail carries the drag affordance instead.
 *
 * Global actions (sidebar/explorer toggles, shortcuts, preferences) no longer
 * live here; they moved to the ActivityRail.
 */
export function TitleBar(): React.JSX.Element | null {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    return windowApi.onMaximizeChange((maximized) => {
      setIsMaximized(maximized)
    })
  }, [])

  // macOS uses native traffic lights — no in-app window controls.
  if (isMac) return null

  return (
    <header
      className="h-8 flex items-center bg-background select-none shrink-0"
      data-tauri-drag-region
    >
      <div className="flex-1 h-full" data-tauri-drag-region />

      <div
        className="flex items-center h-full relative z-[100]"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
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
          onClick={(e) => {
            e.stopPropagation()
            void windowApi.close()
          }}
          className="h-full px-3 hover:bg-red-500/90 hover:text-white inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer"
          title="Close"
          aria-label="Close window"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  )
}
