import { lazy, Suspense } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus } from '@/components/icons'
import { PANEL_HEADER_CLASS, PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { ShellSkeleton } from '@/layouts/workspace-layout/ShellSkeleton'
import { cn } from '@/lib/utils'
import { selectChangedFileCount, useGitStatusStore } from '@/stores/git-status-store'
import {
  type ShellLastColumnTab,
  useLastColumnTab,
  useShellLayoutStore
} from '@/stores/shell-layout-store'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { ChangesPanel } from './ChangesPanel'
import { ChatsList } from './ChatsList'
import { ColumnTabs, columnPanelId, columnTabId } from './ColumnTabs'
import { SidePanelVisibilityButton } from './SidePanelVisibilityButtons'
import { useTopRowPlatform } from './top-row-context'
import { useTrafficLightInset } from './traffic-light-inset'
import { useColumnWorkingCopy } from './use-column-working-copy'
import { useSidePanelResize } from './use-side-panel-resize'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

const FileExplorer = lazy(() =>
  import('@/components/file-explorer/FileExplorer').then((m) => ({ default: m.FileExplorer }))
)

interface SidePanelColumnProps {
  activeProject: Project
}

const TAB_LABELS: Record<ShellLastColumnTab, string> = {
  chats: 'Chats',
  explorer: 'Explorer',
  changes: 'Changes'
}

/**
 * Shell Side panel: a header with the New chat and Hide panel buttons,
 * the Chats / Explorer / Changes Column tabs and the selected tab's body. The
 * last tab is remembered per project. The tabs render only while the Rail is
 * expanded; collapsed, the Rail's own icons select the tab. Mounted through
 * `ExplorerColumn`'s `sidePanel` slot, never in SSH mode.
 *
 * The header is the Side panel's part of the window top row (both Rail
 * states): a drag region on desktop. With the Rail collapsed on macOS the
 * column starts under the traffic lights, so the header takes the inset from
 * `useTrafficLightInset`.
 */
export function SidePanelColumn({ activeProject }: SidePanelColumnProps): React.JSX.Element {
  const projectId = activeProject.id
  const { cwd } = useColumnWorkingCopy(activeProject)
  const railExpanded = useSidebarVisible()
  const dragAttr = useTopRowPlatform().dragRegions ? true : undefined
  const trafficLightInset = useTrafficLightInset()

  const selected: ShellLastColumnTab = useLastColumnTab(projectId) ?? 'chats'
  const changedCount = useGitStatusStore(selectChangedFileCount(cwd))
  const { width, min, max, onResizeMouseDown, onResizeKeyDown } = useSidePanelResize()
  const pathname = useLocation().pathname
  const navigate = useNavigate()

  // Same as the Rail's New chat: the launcher overlay only renders on the
  // workspace route, so leave any child route first.
  const handleNewChat = (): void => {
    const open = (): void => {
      const paneId = useWorkspaceStore.getState().activePaneId
      if (paneId) useWorkspaceStore.getState().showAgentLauncher(paneId)
    }
    if (pathname !== '/') {
      navigate('/')
      requestAnimationFrame(open)
    } else {
      open()
    }
  }

  const handleSelectTab = (tab: ShellLastColumnTab): void => {
    useShellLayoutStore.getState().setLastColumnTab(projectId, tab)
  }

  return (
    // The wrapper owns the 8px gutter to the main container (pr-2) and the resize
    // handle that covers it, so the handle sits on the main container's border
    // instead of leaving a gap at the panel edge. The panel inside keeps `width`.
    <div className="relative h-full min-w-0 flex-shrink-0 pr-2" style={{ width: width + 8 }}>
      <div
        className={cn(
          'flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl',
          'bg-background text-foreground'
        )}
      >
        <div
          className={PANEL_HEADER_CLASS}
          style={
            trafficLightInset ? { paddingLeft: trafficLightInset.panelHeaderStartPx } : undefined
          }
          data-tauri-drag-region={dragAttr}
        >
          <WorkspaceSwitcher project={activeProject} />
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={handleNewChat}
              className={PANEL_ICON_BUTTON_CLASS}
              title="New chat"
              aria-label="New chat"
            >
              <Plus size={14} aria-hidden="true" />
            </button>
            <SidePanelVisibilityButton action="hide" />
          </div>
        </div>

        {railExpanded && (
          <ColumnTabs selected={selected} onSelect={handleSelectTab} changedCount={changedCount} />
        )}

        <div
          role="tabpanel"
          id={columnPanelId(selected)}
          {...(railExpanded
            ? { 'aria-labelledby': columnTabId(selected) }
            : { 'aria-label': TAB_LABELS[selected] })}
          className="flex min-h-0 flex-1 flex-col"
        >
          {selected === 'chats' && <ChatsList project={activeProject} />}
          {selected === 'explorer' && (
            <Suspense fallback={<ShellSkeleton />}>
              <FileExplorer />
            </Suspense>
          )}
          {selected === 'changes' && <ChangesPanel cwd={cwd} isVisible />}
        </div>
      </div>
      <button
        type="button"
        onMouseDown={onResizeMouseDown}
        onKeyDown={onResizeKeyDown}
        className={cn(
          'absolute right-0 top-0 h-full w-2 cursor-col-resize bg-transparent focus-visible:outline-none',
          // 1px indicator flush against the main container's left border.
          'after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-transparent after:transition-colors after:duration-150 after:ease-out',
          'hover:after:bg-muted-foreground/40 focus-visible:after:bg-muted-foreground/60 active:after:bg-muted-foreground/60'
        )}
        title="Drag to resize side panel"
        aria-label="Resize side panel"
        role="separator"
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
      />
    </div>
  )
}
