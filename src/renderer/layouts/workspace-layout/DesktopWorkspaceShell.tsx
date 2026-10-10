import type { ReactNode } from 'react'
import { ActivityRail } from '@/components/ActivityRail'
import { ResizeEdges } from '@/components/ResizeEdges'
import { TitleBar } from '@/components/TitleBar'
import { WorkspaceConflictBanner } from '@/components/workspace/WorkspaceConflictBanner'
import { PaneDndProvider } from '@/hooks/use-pane-dnd'
import { ExplorerColumn } from '@/layouts/workspace-layout/ExplorerColumn'
import { MacOsTitlebarStrip } from '@/layouts/workspace-layout/MacOsTitlebarStrip'
import { ProjectSidebarColumn } from '@/layouts/workspace-layout/ProjectSidebarColumn'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import { useThemePickerOpen } from '@/stores/theme-picker-store'
import type { Project } from '@/types/project'

interface DesktopWorkspaceShellProps {
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

/** Desktop shell: title strip, activity rail, sidebar | main card | explorer, and modals. */
export function DesktopWorkspaceShell({
  projects,
  activeProject,
  activeProjectId,
  ssh,
  isShortcutMenuOpen,
  setIsShortcutMenuOpen,
  setIsCommandPaletteOpen,
  setIsNewProjectModalOpen,
  onSelectProject,
  handleAddGitTab,
  handleAddGitHistoryTab,
  handleToggleThemePicker,
  handleOpenAgentChat,
  handleOpenCanvas,
  workspaceMain,
  appModals
}: DesktopWorkspaceShellProps): React.JSX.Element {
  const isThemePickerOpen = useThemePickerOpen()
  const { activeSSHProfileId, handleSSHConnect, handleSelectSSHProfile } = ssh

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      <ResizeEdges />
      <div className="flex-1 flex flex-col overflow-hidden min-h-0 h-full">
        <MacOsTitlebarStrip />
        <div className="flex-1 flex overflow-hidden min-h-0">
          <ActivityRail
            isShortcutsOpen={isShortcutMenuOpen}
            onShortcutsOpenChange={setIsShortcutMenuOpen}
            onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
            onOpenGitChanges={() => handleAddGitTab()}
            canOpenGitChanges={Boolean(activeProject?.path)}
            onOpenGitHistory={() => handleAddGitHistoryTab()}
            canOpenGitHistory={Boolean(activeProject?.path)}
            isThemePickerOpen={isThemePickerOpen}
            onToggleThemePicker={handleToggleThemePicker}
            onOpenAgentChat={handleOpenAgentChat}
            canOpenAgentChat={Boolean(activeProject?.path)}
            onOpenCanvas={handleOpenCanvas}
            canOpenCanvas={Boolean(activeProject?.path)}
          />
          <div className="flex-1 flex flex-col min-w-0">
            <TitleBar />

            {/* Shell row: sidebar | main card | explorer. gap-2 between the
                columns, pr-2 on the right edge; the side panels are flat and
                set their own surface, so the wrappers here add no fill. */}
            <div className="flex-1 flex gap-2 overflow-hidden min-h-0 h-full py-2 pr-2">
              {/* Sidebar — width reveal: the motion wrapper tweens 0↔auto and
                  clips overflow; the fixed w-64 aside inside never squishes. */}
              <ProjectSidebarColumn
                projects={projects}
                activeProjectId={activeProjectId}
                onSelectProject={onSelectProject}
                onNewProject={() => setIsNewProjectModalOpen(true)}
                onSSHConnect={handleSSHConnect}
                onSelectSSHProfile={handleSelectSSHProfile}
                activeSSHProfileId={activeSSHProfileId}
              />

              {/* Main Content and File Explorer Container */}
              <PaneDndProvider>
                <div className="flex-1 flex gap-2 min-h-0 h-full overflow-hidden min-w-0">
                  {/* Main Content Area */}
                  <main className="flex-1 flex flex-col min-w-0 rounded-xl border border-border bg-card overflow-clip">
                    <WorkspaceConflictBanner />
                    {workspaceMain}
                  </main>

                  <ExplorerColumn activeProject={activeProject} ssh={ssh} />
                </div>
              </PaneDndProvider>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {appModals}
    </div>
  )
}
