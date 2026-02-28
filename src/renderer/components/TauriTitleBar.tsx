import { useState, useEffect, useCallback } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'

const focusableButtonClass =
  'h-full px-3 hover:bg-secondary inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset'

export function TauriTitleBar(): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)
  const appWindow = getCurrentWindow()

  const checkMaximized = useCallback(async () => {
    const maximized = await appWindow.isMaximized()
    setIsMaximized(maximized)
  }, [appWindow])

  useEffect(() => {
    checkMaximized()

    // Listen for resize events to track maximize state
    let unlisten: (() => void) | undefined
    appWindow.onResized(() => {
      checkMaximized()
    }).then((fn) => {
      unlisten = fn
    })

    return () => {
      unlisten?.()
    }
  }, [appWindow, checkMaximized])

  return (
    <header
      className="h-8 flex items-center justify-between bg-card border-b border-border select-none shrink-0"
      data-tauri-drag-region
    >
      <span
        className="text-xs font-semibold text-muted-foreground tracking-wider uppercase px-3"
        data-tauri-drag-region
      >
        termul
      </span>

      <div className="flex items-center h-full">
        <button
          onClick={() => appWindow.minimize()}
          className={focusableButtonClass}
          title="Minimize"
          aria-label="Minimize window"
        >
          <Minus size={16} />
        </button>

        <button
          onClick={() => appWindow.toggleMaximize()}
          className={focusableButtonClass}
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>

        <button
          onClick={() => appWindow.close()}
          className="h-full px-3 hover:bg-red-500/90 hover:text-white inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          title="Close"
          aria-label="Close window"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  )
}
