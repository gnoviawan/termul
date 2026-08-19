import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileExplorerToggleButton,
  SidebarToggleButton,
  titlebarNoDragStyle
} from '@/components/TitlebarPanelToggles'
import { windowApi } from '@/lib/api'
import { isMac } from '@/lib/platform'
import { useActiveProject } from '@/stores/project-store'

const windowControlClass =
  'h-full px-3 hover:bg-secondary/80 inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset cursor-pointer'

/**
 * Slim window-control strip for Windows/Linux.
 *
 * The app runs with `decorations: false` on Windows/Linux, so the in-app
 * minimize/maximize/close controls are required. The strip sits at the top of
 * the content column (right of the ActivityRail) and doubles as a window drag
 * region. On macOS this renders nothing — native traffic lights handle window
 * controls, and WorkspaceLayout provides a unified top drag strip instead.
 *
 * Global actions (shortcuts, preferences) no longer live here; they moved to
 * the ActivityRail. The sidebar and file-explorer visibility toggles were
 * relocated back to this strip — left toggle at the far left, right toggle
 * just before the window controls — so they sit beside the OS window
 * controls instead of pinned to the bottom of the rail.
 */
export function TitleBar(): React.JSX.Element | null {
  const { t } = useTranslation('shell')
  const [isMaximized, setIsMaximized] = useState(false)
  const activeProject = useActiveProject()

  useEffect(() => {
    return windowApi.onMaximizeChange((maximized) => {
      setIsMaximized(maximized)
    })
  }, [])

  // macOS uses native traffic lights — no in-app window controls.
  if (isMac) return null

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
          title={t('titleBar.minimize')}
          aria-label={t('titleBar.minimizeWindow')}
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
          title={isMaximized ? t('titleBar.restore') : t('titleBar.maximize')}
          aria-label={isMaximized ? t('titleBar.restoreWindow') : t('titleBar.maximizeWindow')}
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation()
            void windowApi.close()
          }}
          className="h-full px-3 hover:bg-red-500/90 hover:text-white inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer"
          title={t('titleBar.close')}
          aria-label={t('titleBar.closeWindow')}
        >
          <X size={16} />
        </button>
      </div>
    </header>
  )
}
