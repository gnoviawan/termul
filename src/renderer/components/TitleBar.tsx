import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  FileExplorerToggleButton,
  SidebarToggleButton,
  titlebarNoDragStyle
} from '@/components/TitlebarPanelToggles'
import { windowApi } from '@/lib/api'
import { isMac } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useActiveProject } from '@/stores/project-store'

const windowControlClass =
  'h-full px-3 hover:bg-secondary/80 inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset cursor-pointer'

/**
 * Top-of-content titlebar strip.
 *
 * Three modes:
 * - macOS desktop (Tauri): renders nothing — native traffic lights handle
 *   window controls, and WorkspaceLayout renders a unified top drag strip.
 * - Windows/Linux desktop (Tauri): the in-app minimize/maximize/close controls
 *   are required (`decorations: false`); the sidebar and file-explorer
 *   visibility toggles sit beside the OS controls.
 * - Web (browser tab): renders only the centered active-project name. The
 *   window controls are no-ops in a tab, and the panel toggles live in their
 *   own panel headers (plus a slim edge toggle when hidden) — see
 *   WorkspaceLayout, ProjectSidebar, and FileExplorer.
 *
 * Global actions (shortcuts, preferences) live in the ActivityRail.
 */
export function TitleBar(): React.JSX.Element | null {
  const [isMaximized, setIsMaximized] = useState(false)
  const activeProject = useActiveProject()

  useEffect(() => {
    return windowApi.onMaximizeChange((maximized) => {
      setIsMaximized(maximized)
    })
  }, [])

  // macOS desktop uses native traffic lights — no in-app window controls.
  // Gate on Tauri so a Mac *browser* falls through to the web branch below.
  if (isMac && isTauriContext()) return null

  // Web (browser): no window controls and no panel toggles in the strip —
  // the toggles live beside their panels. Keep the strip for the project name.
  if (!isTauriContext()) {
    return (
      <header className="h-8 flex items-center bg-background select-none shrink-0 relative">
        {activeProject && (
          <span className="absolute left-1/2 -translate-x-1/2 text-sm text-muted-foreground pointer-events-none select-none truncate max-w-[50%]">
            {activeProject.name}
          </span>
        )}
      </header>
    )
  }

  return (
    <header
      className="h-8 flex items-center bg-background select-none shrink-0 relative"
      data-tauri-drag-region
    >
      {/* Left-sidebar toggle — top-left of the content column. */}
      <div className="flex items-center h-full relative z-[100]" style={titlebarNoDragStyle}>
        <SidebarToggleButton />
      </div>

      {activeProject && (
        <span className="absolute left-1/2 -translate-x-1/2 text-sm text-muted-foreground pointer-events-none select-none truncate max-w-[50%]">
          {activeProject.name}
        </span>
      )}

      <div className="flex-1 h-full" data-tauri-drag-region />

      {/* Right-sidebar toggle + window controls — top-right. */}
      <div className="flex items-center h-full relative z-[100]" style={titlebarNoDragStyle}>
        <FileExplorerToggleButton />

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
