import { ChevronsLeft, ChevronsRight } from '@/components/icons'
import { RailToggleButton } from '@/components/shell/RailToggleButton'
import { useTopRow } from '@/components/shell/top-row-context'
import { useShortcutLabel, withShortcut } from '@/components/shell/use-shortcut-label'
import { useSidePanelToggle } from '@/components/shell/use-side-panel-toggle'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
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

/** Whether {@link ShowSidePanelSlot} renders: the Rail toggle, the button, the traffic-light inset, or a mix. */
export function useShowSidePanelSlotVisible(): boolean {
  const topRow = useTopRow()
  const inset = topRow?.mainStartInsetPx ?? 0
  return useShowSidePanelVisible() || inset > 0 || Boolean(topRow?.railToggleInMain)
}

/**
 * Start of the top-row bar that touches the Rail (the leftmost top-edge tab
 * bar, the SSH header or the fallback bar, see `showPanelOwner`). Left to
 * right: under the macOS traffic lights the start padding
 * (`mainStartInsetPx`, 24px); the expand-Rail toggle while the Rail is
 * collapsed (`railToggleInMain`, Sidebar V2); the Show side panel button and
 * a hairline while {@link useShowSidePanelVisible}. Renders nothing when none
 * applies.
 */
export function ShowSidePanelSlot(): React.JSX.Element | null {
  const topRow = useTopRow()
  const inset = topRow?.mainStartInsetPx ?? 0
  const railToggle = Boolean(topRow?.railToggleInMain)
  const showButton = useShowSidePanelVisible()
  if (!showButton && !railToggle && inset === 0) return null
  return (
    <div
      className={cn('flex h-full shrink-0 items-center gap-1', inset === 0 && 'pl-2')}
      style={inset > 0 ? { paddingLeft: inset } : undefined}
      data-testid="show-side-panel-slot"
    >
      {railToggle && <RailToggleButton />}
      {showButton && (
        <>
          <SidePanelVisibilityButton action="show" />
          <span aria-hidden className="ml-1 h-5 w-px shrink-0 bg-border/60" />
        </>
      )}
    </div>
  )
}
