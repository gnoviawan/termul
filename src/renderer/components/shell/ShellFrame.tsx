import type { ShellInfo } from '@shared/types/ipc.types'
import { type ReactNode, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { ResizeEdges } from '@/components/ResizeEdges'
import { ShellRail } from '@/components/shell/ShellRail'
import { SidePanelColumn } from '@/components/shell/SidePanelColumn'
import { WindowControls } from '@/components/shell/TopRowChrome'
import { TopRowFallbackBar } from '@/components/shell/TopRowFallbackBar'
import { ShellToolStrip } from '@/components/shell/tool-strip/ShellToolStrip'
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
  /** Opens a new terminal tab in the active pane (tool strip): the default shell, or `shell`. */
  handleNewTerminal: (shell?: ShellInfo) => void
  /** Opens a new browser tab in the active pane (tool strip). */
  handleNewBrowserTab: () => void
  /** The `workspaceMain` element, rendered inside the main area. */
  workspaceMain: ReactNode
  /** The `appModals` element, rendered after the shell. */
  appModals: ReactNode
}

/**
 * {@link TopRowProvider} plus the main area's start slot: with the Rail
 * collapsed the main area's top row starts with the expand toggle, padded
 * past the macOS traffic lights.
 */
function ShellTopRowProvider({
  roles,
  platform,
  railExpanded,
  children
}: {
  roles: TopRowRoles
  platform: TopRowPlatform
  railExpanded: boolean
  children: ReactNode
}): React.JSX.Element {
  const trafficLightInset = getTrafficLightInset(platform, railExpanded)
  return (
    <TopRowProvider
      roles={roles}
      platform={platform}
      mainStartInsetPx={trafficLightInset?.mainStartPx ?? 0}
      railToggleInMain={!railExpanded}
    >
      {children}
    </TopRowProvider>
  )
}

/**
 * Desktop frame (Paper "2.2 main screen"): Rail | main area | right panel |
 * tool strip, edge to edge with no gutter or card. Every column runs the full
 * window height on the background surface, split by 0.5px hairlines. The
 * window has no title strip: the Rail header, the 44px tab bar and the right
 * panel header share one top row (roles come from `selectTopRowRoles`). On
 * Windows and Linux the window controls sit in the top-right corner, above
 * the tool strip.
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
  handleNewTerminal,
  handleNewBrowserTab,
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
  // Same rule as `ExplorerColumn`: is the right panel on screen?
  const isExplorerVisible = useFileExplorerVisible()
  const panelBlocks = getExplorerColumnBlocks({
    isExplorerVisible,
    activeProject,
    ssh,
    hasSidePanel: Boolean(activeProject)
  })
  const rightPanelOpen = panelBlocks.showFileColumn || panelBlocks.sftpSession !== null
  const roles = useMemo(
    () => selectTopRowRoles({ root: paneRoot, fullscreenPaneId, mode, rightPanelOpen }),
    [paneRoot, fullscreenPaneId, mode, rightPanelOpen]
  )
  const platform = useMemo(() => getTopRowPlatform(), [])

  // Native browser webviews paint above the DOM: hide them while a shell
  // popover is open so it is never drawn underneath.
  useNativeWebviewOcclusion(isShortcutMenuOpen)
  useNativeWebviewOcclusion(isThemePickerOpen)

  return (
    <ShellTopRowProvider roles={roles} platform={platform} railExpanded={railExpanded}>
      <div className="h-screen flex flex-col overflow-hidden bg-background">
        <ResizeEdges />
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

          {/* Shell row: main area | right panel | tool strip. */}
          <div
            className="relative flex-1 flex overflow-hidden min-h-0 min-w-0 h-full"
            data-testid="shell-row"
          >
            <PaneDndProvider>
              <main className="flex-1 flex flex-col min-w-0 border-l-[0.5px] border-border bg-background overflow-clip">
                {roles.showPanelOwner === 'fallback-bar' && <TopRowFallbackBar />}
                {workspaceMain}
              </main>

              {/* `ExplorerColumn` owns the right panel (width, resize, reveal
                  motion, SSH file browser); the project body comes through
                  its `sidePanel` slot. */}
              <ExplorerColumn
                activeProject={activeProject}
                ssh={ssh}
                sidePanel={
                  activeProject ? <SidePanelColumn activeProject={activeProject} /> : undefined
                }
              />
            </PaneDndProvider>

            <ShellToolStrip
              activeProject={activeProject}
              sshOpen={ssh.workspaceOpen}
              onNewTerminal={handleNewTerminal}
              onNewBrowserTab={handleNewBrowserTab}
            />

            {/* Windows/Linux: the window controls in the top-right corner,
                above the tool strip (which starts below them). The top row
                surface on their left ends with the matching spacer. */}
            <WindowControls
              windowControls={platform.windowControls}
              className="absolute top-0 right-0 h-11 border-b-[0.5px] border-border bg-background"
            />
          </div>
        </div>

        {/* Modals */}
        {appModals}
      </div>
    </ShellTopRowProvider>
  )
}
