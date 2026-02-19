import { useState, useEffect } from 'react'
import { Minus, Square, Copy, X, PanelLeft, PanelRight, Settings, SlidersHorizontal } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSidebarStore, useSidebarVisible } from '@/stores/sidebar-store'
import { useFileExplorerStore, useFileExplorerVisible } from '@/stores/file-explorer-store'

const focusableButtonClass = 'h-full px-3 hover:bg-secondary inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset'

export function TitleBar(): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)
  const isSidebarVisible = useSidebarVisible()
  const isExplorerVisible = useFileExplorerVisible()
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    return window.api.window.onMaximizeChange((maximized) => {
      setIsMaximized(maximized)
    })
  }, [])

  return (
    <header
      className="h-8 flex items-center justify-between bg-card border-b border-border select-none shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="text-xs font-semibold text-muted-foreground tracking-wider uppercase px-3">
        termul
      </span>

      <div
        className="flex items-center h-full"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={() => useSidebarStore.getState().toggleVisibility()}
          className={focusableButtonClass}
          title="Toggle sidebar"
          aria-label={isSidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={isSidebarVisible}
        >
          <PanelLeft
            size={16}
            className={isSidebarVisible ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>

        <button
          onClick={() => useFileExplorerStore.getState().toggleVisibility()}
          className={focusableButtonClass}
          title="Toggle file explorer"
          aria-label={isExplorerVisible ? 'Hide file explorer' : 'Show file explorer'}
          aria-pressed={isExplorerVisible}
        >
          <PanelRight
            size={16}
            className={isExplorerVisible ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>

        <button
          onClick={() => navigate('/settings')}
          className={focusableButtonClass}
          title="Settings"
          aria-label="Open settings"
          aria-current={location.pathname === '/settings' ? 'page' : undefined}
        >
          <Settings
            size={16}
            className={location.pathname === '/settings' ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>

        <button
          onClick={() => navigate('/preferences')}
          className={focusableButtonClass}
          title="Preferences"
          aria-label="Open preferences"
          aria-current={location.pathname === '/preferences' ? 'page' : undefined}
        >
          <SlidersHorizontal
            size={16}
            className={location.pathname === '/preferences' ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>

        <div className="w-px h-4 bg-border mx-1" aria-hidden="true" />

        <button
          onClick={() => window.api.window.minimize()}
          className={focusableButtonClass}
          title="Minimize"
          aria-label="Minimize window"
        >
          <Minus size={16} />
        </button>

        <button
          onClick={() => window.api.window.toggleMaximize()}
          className={focusableButtonClass}
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>

        <button
          onClick={() => window.api.window.close()}
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
