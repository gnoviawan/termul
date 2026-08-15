import { PanelLeft, PanelRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useSidebarVisible } from '@/stores/sidebar-store'

/**
 * Shared button style for panel-visibility toggles rendered inside a titlebar.
 *
 * Mirrors the window-control button metrics (`h-full px-3`, 16px icons matching
 * Minimize/Close) so the toggles visually belong to the titlebar strip rather
 * than the activity rail, which used 18px icons in a taller `h-11` rail.
 */
const titlebarToggleButtonClass =
  'h-full px-3 hover:bg-secondary/80 inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset cursor-pointer'

/**
 * Marks an element non-draggable so buttons stay clickable inside a
 * `data-tauri-drag-region` titlebar strip. Shared by the Windows/Linux
 * `TitleBar` and the macOS `MacOsTitlebarStrip`.
 */
export const titlebarNoDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

interface ToggleButtonProps {
  /** Overrides the default titlebar button metrics. */
  className?: string
}

/**
 * Left-sidebar visibility toggle rendered in the titlebar.
 *
 * Behavior contract preserved from the former ActivityRail placement:
 * persistence-aware update via `useUpdatePanelVisibility`, error toast on
 * failure, and accessible pressed/label state.
 */
export function SidebarToggleButton({
  className = titlebarToggleButtonClass
}: ToggleButtonProps): React.JSX.Element {
  const { t } = useTranslation('shell')
  const isVisible = useSidebarVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation()
    try {
      await updatePanelVisibility('sidebarVisible', !isVisible)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('titleBar.failedSidebar'))
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        void handleClick(e)
      }}
      className={className}
      title={t('titleBar.toggleSidebar')}
      aria-label={isVisible ? t('titleBar.hideSidebar') : t('titleBar.showSidebar')}
      aria-pressed={isVisible}
    >
      <PanelLeft size={16} className={isVisible ? 'text-foreground' : 'text-muted-foreground'} />
    </button>
  )
}

/**
 * Right-sidebar (file explorer) visibility toggle rendered in the titlebar.
 *
 * Behavior contract preserved from the former ActivityRail placement:
 * persistence-aware update via `useUpdatePanelVisibility`, error toast on
 * failure, and accessible pressed/label state.
 */
export function FileExplorerToggleButton({
  className = titlebarToggleButtonClass
}: ToggleButtonProps): React.JSX.Element {
  const { t } = useTranslation('shell')
  const isVisible = useFileExplorerVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation()
    try {
      await updatePanelVisibility('fileExplorerVisible', !isVisible)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('titleBar.failedFileExplorer'))
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        void handleClick(e)
      }}
      className={className}
      title={t('titleBar.toggleFileExplorer')}
      aria-label={isVisible ? t('titleBar.hideFileExplorer') : t('titleBar.showFileExplorer')}
      aria-pressed={isVisible}
    >
      <PanelRight size={16} className={isVisible ? 'text-foreground' : 'text-muted-foreground'} />
    </button>
  )
}
