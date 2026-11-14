import { Edit2, Search, Workflow } from '@/components/icons'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { RailFooter } from '@/components/shell/RailFooter'
import { RailHeader } from '@/components/shell/RailHeader'
import { RailProjectChats } from '@/components/shell/rail/RailProjectChats'
import { logRailEvent } from '@/components/shell/rail/rail-log'
import { RailNav, RailNavRow } from '@/components/shell/rail/rail-nav'
import { useNewChat } from '@/components/shell/use-new-chat'
import { useShortcutLabel } from '@/components/shell/use-shortcut-label'
import { useProjectActions } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'

interface RailBodyProps {
  projects: Project[]
  activeProjectId: string
  onSelectProject: (id: string) => void
  onNewProject: () => void
  onSSHConnect: (profileId: string) => void
  onSelectSSHProfile: (profileId: string) => void
  activeSSHProfileId: string | null
  onOpenCommandPalette: () => void
  onOpenCanvas: () => void
  canOpenCanvas: boolean
  isShortcutsOpen: boolean
  onShortcutsOpenChange: (open: boolean) => void
  isThemePickerOpen: boolean
  onToggleThemePicker?: () => void
}

const NEED_PROJECT = 'Open a project first'

/**
 * Rail body, top to bottom: the header (top row part, ending in the Rail
 * toggle), the nav (New chat, Search, Canvas, Automations), the Projects
 * section with the active project's chats (and the SSH section on desktop),
 * and the icon-only footer. Fills the width its container gives it and
 * inherits the Rail's surface.
 *
 * One tree for both Rail states: every part reads the density from
 * `RailDensityProvider` (set by `ShellRail`). Collapsed, the rows keep their
 * heights and only drop labels and meta, so every icon stays at its y.
 */
export function RailBody({
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onSSHConnect,
  onSelectSSHProfile,
  activeSSHProfileId,
  onOpenCommandPalette,
  onOpenCanvas,
  canOpenCanvas,
  isShortcutsOpen,
  onShortcutsOpenChange,
  isThemePickerOpen,
  onToggleThemePicker
}: RailBodyProps): React.JSX.Element {
  const { updateProject, deleteProject, archiveProject, restoreProject, reorderProjects } =
    useProjectActions()
  const searchShortcut = useShortcutLabel('commandPalette')
  const newChat = useNewChat()
  const activeProject = projects.find((project) => project.id === activeProjectId)

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <RailHeader />

      <RailNav>
        <RailNavRow
          label="New chat"
          icon={<Edit2 />}
          onClick={() => {
            logRailEvent('new chat')
            newChat()
          }}
        />
        <RailNavRow
          label="Search"
          shortcut={searchShortcut}
          icon={<Search />}
          onClick={onOpenCommandPalette}
        />
        <RailNavRow
          label="Canvas"
          name="Open canvas"
          hint={canOpenCanvas ? undefined : NEED_PROJECT}
          icon={<Edit2 />}
          disabled={!canOpenCanvas}
          onClick={onOpenCanvas}
        />
        <RailNavRow
          label="Automations"
          name="Open automations"
          hint={activeProjectId ? undefined : NEED_PROJECT}
          icon={<Workflow />}
          disabled={!activeProjectId}
          onClick={() => useWorkspaceStore.getState().addAutomationsTab(activeProjectId)}
        />
      </RailNav>

      <ProjectSidebar
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={onSelectProject}
        onNewProject={onNewProject}
        onUpdateProject={updateProject}
        onDeleteProject={deleteProject}
        onArchiveProject={archiveProject}
        onRestoreProject={restoreProject}
        onReorderProjects={reorderProjects}
        onSSHConnect={onSSHConnect}
        onSelectSSHProfile={onSelectSSHProfile}
        activeSSHProfileId={activeSSHProfileId}
        activeProjectContent={
          activeProject ? <RailProjectChats key={activeProject.id} project={activeProject} /> : null
        }
      />

      <RailFooter
        isShortcutsOpen={isShortcutsOpen}
        onShortcutsOpenChange={onShortcutsOpenChange}
        isThemePickerOpen={isThemePickerOpen}
        onToggleThemePicker={onToggleThemePicker}
      />
    </div>
  )
}
