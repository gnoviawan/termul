import { useState, useEffect } from 'react'
import { Minus, Square, Copy, X, PanelLeft, PanelRight } from 'lucide-react'
import { useSidebarStore, useSidebarVisible } from '@/stores/sidebar-store'
import { useFileExplorerStore, useFileExplorerVisible } from '@/stores/file-explorer-store'

export function TitleBar(): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)
  const isSidebarVisible = useSidebarVisible()
  const isExplorerVisible = useFileExplorerVisible()

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
          className="h-full px-3 hover:bg-secondary inline-flex items-center"
          title="Toggle sidebar"
        >
          <PanelLeft
            size={16}
            className={isSidebarVisible ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>

        <button
          onClick={() => useFileExplorerStore.getState().toggleVisibility()}
          className="h-full px-3 hover:bg-secondary inline-flex items-center"
          title="Toggle file explorer"
        >
          <PanelRight
            size={16}
            className={isExplorerVisible ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>

        <div className="w-px h-4 bg-border mx-1" />

        <button
          onClick={() => window.api.window.minimize()}
          className="h-full px-3 hover:bg-secondary inline-flex items-center"
          title="Minimize"
        >
          <Minus size={16} />
        </button>

        <button
          onClick={() => window.api.window.toggleMaximize()}
          className="h-full px-3 hover:bg-secondary inline-flex items-center"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>

        <button
          onClick={() => window.api.window.close()}
          className="h-full px-3 hover:bg-red-500/90 hover:text-white inline-flex items-center"
          title="Close"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  )
}
