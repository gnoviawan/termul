import { ChevronsLeft, ChevronsRight } from '@/components/icons'
import { useShortcutLabel, withShortcut } from '@/components/shell/use-shortcut-label'
import { useSidePanelToggle } from '@/components/shell/use-side-panel-toggle'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useActiveProject } from '@/stores/project-store'

const ACTIONS = {
  hide: { label: 'Hide side panel', Icon: ChevronsLeft },
  show: { label: 'Show side panel', Icon: ChevronsRight }
} as const

/**
 * Hides or shows the Side panel, by the same persisted path as Ctrl+B. `hide`
 * lives in the panel's own header, so it acts on the panel it sits in; `show`
 * sits where the panel edge was (see {@link ShowSidePanelSlot}).
 */
export function SidePanelVisibilityButton({
  action
}: {
  action: keyof typeof ACTIONS
}): React.JSX.Element {
  const { toggle } = useSidePanelToggle()
  const shortcut = useShortcutLabel('toggleFileExplorer')
  const { label, Icon } = ACTIONS[action]
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        toggle()
      }}
      className={PANEL_ICON_BUTTON_CLASS}
      title={withShortcut(label, shortcut)}
      aria-label={label}
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  )
}

/**
 * Whether the Show side panel button belongs in the top row: the panel is
 * hidden and the active project has a folder to show (the same condition the
 * Side panel column uses).
 */
export function useShowSidePanelVisible(): boolean {
  const visible = useFileExplorerVisible()
  const hasPath = Boolean(useActiveProject()?.path)
  return !visible && hasPath
}

/**
 * Start of the top-row bar that owns the Show side panel button (the leftmost
 * top-edge tab bar, the SSH header or the fallback bar, see `showPanelOwner`):
 * the button and a hairline, while {@link useShowSidePanelVisible}. Renders
 * nothing otherwise.
 */
export function ShowSidePanelSlot(): React.JSX.Element | null {
  if (!useShowSidePanelVisible()) return null
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 pl-2"
      data-testid="show-side-panel-slot"
    >
      <SidePanelVisibilityButton action="show" />
      <span aria-hidden className="ml-1 h-5 w-px shrink-0 bg-border/60" />
    </div>
  )
}
