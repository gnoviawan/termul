import { ShowSidePanelSlot } from '@/components/shell/SidePanelVisibilityButtons'
import { WindowControls } from '@/components/shell/TopRowChrome'
import { useTopRow } from '@/components/shell/top-row-context'

/**
 * Top row of the main area when no pane tab bar exists (no projects, or a
 * routed page): a drag bar that carries the Show side panel button at its
 * start (while the panel is hidden) and the window controls at its end.
 * Rendered by `ShellFrame` only when the fallback bar owns the controls.
 */
export function TopRowFallbackBar(): React.JSX.Element {
  const topRow = useTopRow()
  const dragRegion = topRow?.platform.dragRegions ?? false
  const showSidePanel = topRow?.roles.showPanelOwner === 'fallback-bar'
  const windowControls = Boolean(
    topRow && topRow.roles.controlsOwner === 'fallback-bar' && topRow.platform.windowControls
  )
  return (
    <div
      className="flex h-10 shrink-0 items-center bg-card"
      data-testid="top-row-fallback-bar"
      data-tauri-drag-region={dragRegion ? true : undefined}
    >
      {showSidePanel && <ShowSidePanelSlot />}
      <div
        className="h-full min-w-0 flex-1"
        data-tauri-drag-region={dragRegion ? true : undefined}
      />
      <WindowControls windowControls={windowControls} />
    </div>
  )
}
