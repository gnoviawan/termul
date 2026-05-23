import { useState, useEffect } from 'react'
import { Minus, Square, Copy, X, PanelLeft, PanelRight, Settings, SlidersHorizontal, Globe, Keyboard } from 'lucide-react'
import { TitleBarShortcutsPopover } from '@/components/TitleBarShortcutsPopover'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { windowApi } from '@/lib/api'
import { toast } from 'sonner'
import { isMac } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'

const focusableButtonClass = 'h-full px-2.5 hover:bg-secondary inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset transition-colors'

interface TitleBarProps {
  isShortcutsOpen?: boolean
  onShortcutsOpenChange?: (open: boolean) => void
}

export function TitleBar({
  isShortcutsOpen,
  onShortcutsOpenChange
}: TitleBarProps = {}): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)
  const isDesktopApp = isTauriContext()
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
    <header className="h-9 flex items-center bg-sidebar select-none shrink-0 border-b border-border/50">
      {isMac && (
        <div className="flex items-center h-full" style={{ width: '70px', paddingLeft: '14px' }} data-tauri-drag-region>
          <div className="flex items-center gap-2" />
        </div>
      )}

      <div className="flex items-center h-full px-3 gap-2" data-tauri-drag-region>
        <div className="w-2 h-2 rounded-full bg-primary" />
        <span className="text-[11px] font-semibold text-foreground/80 tracking-wide uppercase pointer-events-none">
          termul
        </span>
      </div>

      <div className="flex-1 h-full" data-tauri-drag-region />

      <div
        className="flex items-center h-full relative z-[100]"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={(e) => { void handleToggleSidebar(e) }}
          className={cn(focusableButtonClass, 'rounded-md mx-0.5')}
          title="Toggle sidebar"
          aria-label={isSidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={isSidebarVisible}
        >
          <PanelLeft size={14} className={isSidebarVisible ? 'text-foreground' : 'text-muted-foreground'} />
        </button>

        <button
          onClick={(e) => { void handleToggleFileExplorer(e) }}
          className={cn(focusableButtonClass, 'rounded-md mx-0.5')}
          title="Toggle file explorer"
          aria-label={isExplorerVisible ? 'Hide file explorer' : 'Show file explorer'}
          aria-pressed={isExplorerVisible}
        >
          <PanelRight size={14} className={isExplorerVisible ? 'text-foreground' : 'text-muted-foreground'} />
        </button>

        {isDesktopApp && (
          <>
            <TitleBarShortcutsPopover
              buttonClassName={cn(focusableButtonClass, 'rounded-md mx-0.5')}
              open={isShortcutsOpen}
              onOpenChange={onShortcutsOpenChange}
            />

            <button
              onClick={(e) => { e.stopPropagation(); navigate('/settings'); }}
              className={cn(focusableButtonClass, 'rounded-md mx-0.5')}
              title="Settings"
              aria-label="Open settings"
              aria-current={location.pathname === '/settings' ? 'page' : undefined}
            >
              <Settings size={14} className={location.pathname === '/settings' ? 'text-foreground' : 'text-muted-foreground'} />
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); navigate('/preferences'); }}
              className={cn(focusableButtonClass, 'rounded-md mx-0.5')}
              title="Preferences"
              aria-label="Open preferences"
              aria-current={location.pathname === '/preferences' ? 'page' : undefined}
            >
              <SlidersHorizontal size={14} className={location.pathname === '/preferences' ? 'text-foreground' : 'text-muted-foreground'} />
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); navigate('/remote'); }}
              className={cn(focusableButtonClass, 'rounded-md mx-0.5')}
              title="Remote Coding"
              aria-label="Open remote coding"
              aria-current={location.pathname === '/remote' ? 'page' : undefined}
            >
              <Globe size={14} className={location.pathname === '/remote' ? 'text-foreground' : 'text-muted-foreground'} />
            </button>

            <div className="w-px h-3.5 bg-border/60 mx-1.5" aria-hidden="true" />
          </>
        )}

        {!isMac && isDesktopApp && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); void windowApi.minimize(); }}
              className={cn(focusableButtonClass, 'cursor-pointer')}
              title="Minimize"
              aria-label="Minimize window"
            >
              <Minus size={14} />
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); void windowApi.toggleMaximize(); }}
              className={cn(focusableButtonClass, 'cursor-pointer')}
              title={isMaximized ? 'Restore' : 'Maximize'}
              aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
            >
              {isMaximized ? <Copy size={12} /> : <Square size={12} />}
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); void windowApi.close(); }}
              className="h-full px-2.5 hover:bg-red-500/90 hover:text-white inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer transition-colors"
              title="Close"
              aria-label="Close window"
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
