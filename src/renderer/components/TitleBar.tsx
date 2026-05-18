import { useState, useEffect } from 'react'
import { Minus, Square, Copy, X, PanelLeft, PanelRight, Settings, SlidersHorizontal } from 'lucide-react'
import { TitleBarShortcutsPopover } from '@/components/TitleBarShortcutsPopover'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { windowApi } from '@/lib/api'
import { toast } from 'sonner'
import { isMac } from '@/lib/platform'

const focusableButtonClass = 'h-full px-3 hover:bg-secondary/80 inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset'

interface TitleBarProps {
  isShortcutsOpen?: boolean
  onShortcutsOpenChange?: (open: boolean) => void
}

export function TitleBar({
  isShortcutsOpen,
  onShortcutsOpenChange
}: TitleBarProps = {}): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)
  const isSidebarVisible = useSidebarVisible()
  const isExplorerVisible = useFileExplorerVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()
  const navigate = useNavigate()
  const location = useLocation()

  const handleToggleSidebar = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation()
    try {
      await updatePanelVisibility('sidebarVisible', !isSidebarVisible)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update sidebar visibility')
    }
  }

  const handleToggleFileExplorer = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation()
    try {
      await updatePanelVisibility('fileExplorerVisible', !isExplorerVisible)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update file explorer visibility')
    }
  }

  useEffect(() => {
    return windowApi.onMaximizeChange((maximized) => {
      setIsMaximized(maximized)
    })
  }, [])

  return (
    <header
      className="h-8 flex items-center bg-background select-none shrink-0"
    >
      {/* macOS: spacer for native traffic lights (close/minimize/zoom) */}
      {isMac && (
        <div className="flex items-center h-full" style={{ width: '70px', paddingLeft: '14px' }} data-tauri-drag-region>
          <div className="flex items-center gap-2">
            {/* Native traffic lights are rendered by macOS automatically */}
          </div>
        </div>
      )}

      <div
        className="flex items-center h-full px-3"
        data-tauri-drag-region
      >
        <span
          className="text-xs font-semibold text-muted-foreground tracking-wider uppercase pointer-events-none"
        >
          termul
        </span>
      </div>

      <div className="flex-1 h-full" data-tauri-drag-region />

      <div
        className="flex items-center h-full relative z-[100]"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={(e) => {
            void handleToggleSidebar(e)
          }}
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
          onClick={(e) => {
            void handleToggleFileExplorer(e)
          }}
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

        <TitleBarShortcutsPopover
          buttonClassName={focusableButtonClass}
          open={isShortcutsOpen}
          onOpenChange={onShortcutsOpenChange}
        />

        <button
          onClick={(e) => { e.stopPropagation(); navigate('/settings'); }}
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
          onClick={(e) => { e.stopPropagation(); navigate('/preferences'); }}
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

        {/* Window controls — hidden on macOS (native traffic lights) */}
        {!isMac && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); void windowApi.minimize(); }}
              className={`${focusableButtonClass} cursor-pointer`}
              title="Minimize"
              aria-label="Minimize window"
            >
              <Minus size={16} />
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); void windowApi.toggleMaximize(); }}
              className={`${focusableButtonClass} cursor-pointer`}
              title={isMaximized ? 'Restore' : 'Maximize'}
              aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
            >
              {isMaximized ? <Copy size={14} /> : <Square size={14} />}
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); void windowApi.close(); }}
              className="h-full px-3 hover:bg-red-500/90 hover:text-white inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer"
              title="Close"
              aria-label="Close window"
            >
              <X size={16} />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
