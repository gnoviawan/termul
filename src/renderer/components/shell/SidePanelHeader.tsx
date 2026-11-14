import { X } from '@/components/icons'
import { logShellEvent } from '@/components/shell/shell-log'
import { useTopRowPlatform } from '@/components/shell/top-row-context'
import { useShortcutLabel, withShortcut } from '@/components/shell/use-shortcut-label'
import { useSidePanelToggle } from '@/components/shell/use-side-panel-toggle'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'

/**
 * Right panel header (Paper "Panel header"): 44px, a 0.5px bottom hairline,
 * the view title in 12px medium foreground, the view's actions, then Close.
 * Part of the window top row, so its empty space is a drag region on desktop.
 */
export function SidePanelHeader({
  title,
  children
}: {
  title: string
  /** The view's actions (28px icon buttons), before Close. */
  children?: React.ReactNode
}): React.JSX.Element {
  const drag = useTopRowPlatform().dragRegions ? true : undefined
  return (
    <div
      className="flex h-11 shrink-0 items-center gap-1.5 border-b-[0.5px] border-border pr-2 pl-3"
      data-tauri-drag-region={drag}
      data-testid="side-panel-header"
    >
      <h2
        className="min-w-0 flex-1 truncate text-2xs font-medium text-foreground"
        data-tauri-drag-region={drag}
      >
        {title}
      </h2>
      {children}
      <SidePanelCloseButton />
    </div>
  )
}

/** Hides the right panel, by the same persisted path as the strip and the shortcut. */
function SidePanelCloseButton(): React.JSX.Element {
  const { toggle } = useSidePanelToggle()
  const shortcut = useShortcutLabel('toggleFileExplorer')
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        logShellEvent('right panel hidden via header')
        toggle()
      }}
      className={PANEL_ICON_BUTTON_CLASS}
      title={withShortcut('Close panel', shortcut)}
      aria-label="Close panel"
    >
      <X size={13} aria-hidden="true" />
    </button>
  )
}
