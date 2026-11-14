import { WindowControlsInset } from '@/components/shell/TopRowChrome'
import { TopRowStartSlot } from '@/components/shell/TopRowStartSlot'
import { useTopRow } from '@/components/shell/top-row-context'

/**
 * Top row of the main area when no pane tab bar exists (no projects, or a
 * routed page): a 44px drag bar that carries the start slot (expand-Rail
 * toggle) and, unless the open right panel's header does, the window
 * controls spacer at its end. Rendered by `ShellFrame` in fallback mode.
 */
export function TopRowFallbackBar(): React.JSX.Element {
  const topRow = useTopRow()
  const dragRegion = topRow?.platform.dragRegions ?? false
  const startSlot = topRow?.roles.showPanelOwner === 'fallback-bar'
  const windowControls = Boolean(
    topRow && topRow.roles.controlsOwner === 'fallback-bar' && topRow.platform.windowControls
  )
  return (
    <div
      className="flex h-11 shrink-0 items-center border-b-[0.5px] border-border bg-background"
      data-testid="top-row-fallback-bar"
      data-tauri-drag-region={dragRegion ? true : undefined}
    >
      {startSlot && <TopRowStartSlot />}
      <div
        className="h-full min-w-0 flex-1"
        data-tauri-drag-region={dragRegion ? true : undefined}
      />
      <WindowControlsInset windowControls={windowControls} />
    </div>
  )
}
