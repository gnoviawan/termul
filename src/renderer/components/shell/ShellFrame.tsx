import { type ReactNode, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { ResizeEdges } from '@/components/ResizeEdges'
import { ShellRail } from '@/components/shell/ShellRail'
import { SidePanelColumn } from '@/components/shell/SidePanelColumn'
import { TopRowFallbackBar } from '@/components/shell/TopRowFallbackBar'
import { TopRowProvider } from '@/components/shell/top-row-context'
import { getTrafficLightInset } from '@/components/shell/traffic-light-inset'
import { useNativeWebviewOcclusion } from '@/hooks/use-native-webview-occlusion'
import { PaneDndProvider } from '@/hooks/use-pane-dnd'
import { ExplorerColumn } from '@/layouts/workspace-layout/ExplorerColumn'
import { getExplorerColumnBlocks } from '@/layouts/workspace-layout/explorer-column-blocks'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import {
  getTopRowPlatform,
  selectTopRowRoles,
  type TopRowMode,
  type TopRowPlatform,
  type TopRowRoles
} from '@/lib/top-row'
import { isWorkspaceRoutePath } from '@/lib/workspace-route'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { useThemePickerOpen } from '@/stores/theme-picker-store'
import { useFullscreenPaneId, usePaneRoot } from '@/stores/workspace-store'
import type { Project } from '@/types/project'

export interface ShellFrameProps {
  projects: Project[]
  activeProject: Project | undefined
  activeProjectId: string
  ssh: SSHWorkspaceState
  isShortcutMenuOpen: boolean
  setIsShortcutMenuOpen: (open: boolean) => void
  setIsCommandPaletteOpen: (open: boolean) => void
  setIsNewProjectModalOpen: (open: boolean) => void
  onSelectProject: (id: string) => void
  handleAddGitTab: (paneId?: string) => void
  handleAddGitHistoryTab: (paneId?: string) => void
  handleToggleThemePicker: () => void
  handleOpenAgentChat: () => void
  handleOpenCanvas: () => void
  /** The `workspaceMain` element, rendered inside the main card. */
  workspaceMain: ReactNode
  /** The `appModals` element, rendered after the shell. */
  appModals: ReactNode
}

/** 8px drag gutter above the Side panel and main card (there is no title strip). */
function TopGutter({ dragRegion }: { dragRegion: boolean }): React.JSX.Element {
  return (
    <div
      className="h-2 shrink-0"
      data-testid="top-gutter"
      data-tauri-drag-region={dragRegion ? true : undefined}
    />
  )
}

/**
 * {@link TopRowProvider} plus the main card's traffic-light start inset. It
 * owns the Side panel visibility subscription, so a Side panel toggle
 * re-renders only this provider and the top-row consumers, not the frame.
 */
function ShellTopRowProvider({
  roles,
  platform,
  railExpanded,
  activeProject,
  ssh,
  children
}: {
  roles: TopRowRoles
  platform: TopRowPlatform
  railExpanded: boolean
  activeProject: Project | undefined
  ssh: SSHWorkspaceState
  children: ReactNode
}): React.JSX.Element {
  const isExplorerVisible = useFileExplorerVisible()
  const trafficLightInset = getTrafficLightInset(platform, railExpanded)
  // Same condition as `ExplorerColumn`: with no Side panel column the main
  // card sits next to the collapsed Rail, under the traffic lights.
  const explorerColumn = getExplorerColumnBlocks({
    isExplorerVisible,
    activeProject,
    ssh,
    hasSidePanel: Boolean(activeProject)
  })
  const mainStartInsetPx =
    trafficLightInset && !explorerColumn.showFileColumn && !explorerColumn.sftpSession
      ? trafficLightInset.panelHeaderStartPx
      : 0
  // With the Side panel column on screen its header carries the toggle.
  const railToggleInMain = !railExpanded && !explorerColumn.showFileColumn
  return (
    <TopRowProvider
      roles={roles}
      platform={platform}
      mainStartInsetPx={mainStartInsetPx}
      railToggleInMain={railToggleInMain}
    >
      {children}
    </TopRowProvider>
  )
}

/**
 * Desktop frame: Rail | Side panel | main area. The Rail is a full-height
 * column (its sidebar surface runs from the window top to the bottom edge);
 * the right column holds the 8px top gutter, then the Side panel and the main
 * card. The window has no title strip: the Rail header, the Side panel header
 * and the top-edge pane tab bars share one top row (roles come from
 * `selectTopRowRoles`).
 */
export function ShellFrame({
  projects,
  activeProject,
  activeProjectId,
  ssh,
  isShortcutMenuOpen,
  setIsShortcutMenuOpen,
  setIsCommandPaletteOpen,
  setIsNewProjectModalOpen,
  onSelectProject,
  handleToggleThemePicker,
  handleOpenCanvas,
  workspaceMain,
  appModals
}: ShellFrameProps): React.JSX.Element {
  const isThemePickerOpen = useThemePickerOpen()
  const railExpanded = useSidebarVisible()
  const { activeSSHProfileId, handleSSHConnect, handleSelectSSHProfile } = ssh

  const paneRoot = usePaneRoot()
  const fullscreenPaneId = useFullscreenPaneId()
  const pathname = useLocation().pathname
  const mode: TopRowMode = ssh.workspaceOpen
    ? 'ssh'
    : projects.length === 0 || !isWorkspaceRoutePath(pathname)
      ? 'fallback'
      : 'panes'
  const roles = useMemo(
    () => selectTopRowRoles({ root: paneRoot, fullscreenPaneId, mode }),
    [paneRoot, fullscreenPaneId, mode]
  )
  const platform = useMemo(() => getTopRowPlatform(), [])

  // Native browser webviews paint above the DOM: hide them while a shell
  // popover is open so it is never drawn underneath.
  useNativeWebviewOcclusion(isShortcutMenuOpen)
  useNativeWebviewOcclusion(isThemePickerOpen)

  return (
    <ShellTopRowProvider
      roles={roles}
      platform={platform}
      railExpanded={railExpanded}
      activeProject={activeProject}
      ssh={ssh}
    >
      <div className="h-screen flex flex-col overflow-hidden bg-background">
        <ResizeEdges />
        {/* Rail (full height) | right column: gutter, then Side panel and main
            card. `pl-2` is the 8px gap between the Rail and the Side panel. */}
        <div className="flex-1 flex overflow-hidden min-h-0 h-full">
          <ShellRail
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectProject={onSelectProject}
            onNewProject={() => setIsNewProjectModalOpen(true)}
            onSSHConnect={handleSSHConnect}
            onSelectSSHProfile={handleSelectSSHProfile}
            activeSSHProfileId={activeSSHProfileId}
            onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
            onOpenCanvas={handleOpenCanvas}
            canOpenCanvas={Boolean(activeProject?.path)}
            isShortcutsOpen={isShortcutMenuOpen}
            onShortcutsOpenChange={setIsShortcutMenuOpen}
            isThemePickerOpen={isThemePickerOpen}
            onToggleThemePicker={handleToggleThemePicker}
          />

          <div className="flex-1 flex flex-col overflow-hidden min-h-0 min-w-0 h-full">
            <TopGutter dragRegion={platform.dragRegions} />

            {/* Side panel | main card. The columns set their own surface; the
                8px gutter above replaces the top padding. */}
            <div
              className="flex-1 flex overflow-hidden min-h-0 h-full pb-2 pr-2 pl-2"
              data-testid="shell-row"
            >
              <PaneDndProvider>
                {/* No gap here: the Side panel owns its 8px gutter so its resize handle
                    sits on the main container border. */}
                <div className="flex-1 flex min-h-0 h-full overflow-hidden min-w-0">
                  {/* `ExplorerColumn` stays the outer shell (reveal motion,
                      visibility, SSH file browser); the Column tabs panel is
                      injected through its `sidePanel` slot. */}
                  <ExplorerColumn
                    activeProject={activeProject}
                    ssh={ssh}
                    sidePanel={
                      activeProject ? <SidePanelColumn activeProject={activeProject} /> : undefined
                    }
                  />

                  {/* Same top in every Rail and Side panel state. Under the
                      macOS traffic lights the top row pads its start instead
                      (`mainStartInsetPx`), and with the Rail collapsed it
                      starts with the expand toggle (see `ShowSidePanelSlot`). */}
                  <main className="flex-1 flex flex-col min-w-0 rounded-xl border border-border bg-card overflow-clip">
                    {roles.controlsOwner === 'fallback-bar' && <TopRowFallbackBar />}
                    {workspaceMain}
                  </main>
                </div>
              </PaneDndProvider>
            </div>
          </div>
        </div>

        {/* Modals */}
        {appModals}
      </div>
    </ShellTopRowProvider>
  )
}
