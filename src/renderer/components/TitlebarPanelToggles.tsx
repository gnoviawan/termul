import { toast } from 'sonner'
import { PanelLeft, PanelRight } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useActiveProject } from '@/stores/project-store'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { useActiveTab } from '@/stores/workspace-store'

/** Hover wash, neutral inset focus ring and pointer shared by both toggle looks. */
const toggleButtonBaseClass = `inline-flex items-center cursor-pointer transition-colors duration-150 ease-out hover:bg-foreground/[0.03] ${FOCUS_RING_CLASS} focus-visible:ring-inset`

/**
 * Shared button style for panel-visibility toggles rendered inside a titlebar.
 *
 * Mirrors the window-control button metrics (`h-full px-3`, 16px icons matching
 * Minimize/Close) so the toggles visually belong to the titlebar strip.
 * Icon ink is foreground while the panel is visible, muted when hidden.
 */
const titlebarToggleButtonClass = `h-full px-3 ${toggleButtonBaseClass}`

/**
 * Neutral edge toggle shown beside a hidden panel on web (32px square).
 * Same states as the titlebar toggle.
 */
export const panelEdgeToggleButtonClass = `h-8 w-8 justify-center rounded-md ${toggleButtonBaseClass}`

function fileBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/**
 * Centered title of the title strip: "project · file". The file part shows
 * only when the active workspace tab is an editor tab, in a lighter ink.
 */
export function TitleStripTitle(): React.JSX.Element | null {
  const activeProject = useActiveProject()
  const activeTab = useActiveTab()
  if (!activeProject) return null
  const fileName = activeTab?.type === 'editor' ? fileBaseName(activeTab.filePath) : null
  return (
    <span
      data-testid="title-strip-title"
      className="absolute left-1/2 max-w-[50%] -translate-x-1/2 truncate text-sm text-muted-foreground pointer-events-none select-none"
    >
      {activeProject.name}
      {fileName && <span className="text-muted-foreground/60"> · {fileName}</span>}
    </span>
  )
}

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

interface PanelVisibilityToggleProps extends ToggleButtonProps {
  setting: 'sidebarVisible' | 'fileExplorerVisible'
  /** Lower-case panel name for labels and the error toast ("sidebar"). */
  panelName: string
  isVisible: boolean
  icon: typeof PanelLeft
}

/**
 * Panel visibility toggle. Behavior contract preserved from the former
 * ActivityRail placement: persistence-aware update via
 * `useUpdatePanelVisibility`, error toast on failure, and accessible
 * pressed/label state.
 */
function PanelVisibilityToggle({
  setting,
  panelName,
  isVisible,
  icon: Icon,
  className = titlebarToggleButtonClass
}: PanelVisibilityToggleProps): React.JSX.Element {
  const updatePanelVisibility = useUpdatePanelVisibility()

  const handleClick = async (): Promise<void> => {
    try {
      await updatePanelVisibility(setting, !isVisible)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Failed to update ${panelName} visibility`
      )
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void handleClick()
      }}
      className={className}
      title={`Toggle ${panelName}`}
      aria-label={`${isVisible ? 'Hide' : 'Show'} ${panelName}`}
      aria-pressed={isVisible}
    >
      <Icon size={16} className={isVisible ? 'text-foreground' : 'text-muted-foreground'} />
    </button>
  )
}

/** Left-sidebar visibility toggle rendered in the titlebar. */
export function SidebarToggleButton({ className }: ToggleButtonProps): React.JSX.Element {
  const isVisible = useSidebarVisible()
  return (
    <PanelVisibilityToggle
      setting="sidebarVisible"
      panelName="sidebar"
      isVisible={isVisible}
      icon={PanelLeft}
      className={className}
    />
  )
}

/** Right-sidebar (file explorer) visibility toggle rendered in the titlebar. */
export function FileExplorerToggleButton({ className }: ToggleButtonProps): React.JSX.Element {
  const isVisible = useFileExplorerVisible()
  return (
    <PanelVisibilityToggle
      setting="fileExplorerVisible"
      panelName="file explorer"
      isVisible={isVisible}
      icon={PanelRight}
      className={className}
    />
  )
}
