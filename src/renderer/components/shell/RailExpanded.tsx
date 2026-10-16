import { Edit2, Search } from '@/components/icons'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { RailFooter } from '@/components/shell/RailFooter'
import { RailHeader } from '@/components/shell/RailHeader'
import { RailRow } from '@/components/shell/RailRow'
import { useShortcutLabel } from '@/components/shell/use-shortcut-label'
import { useProjectActions } from '@/stores/project-store'
import type { Project } from '@/types/project'

interface RailExpandedProps {
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
 * Expanded Rail body, top to bottom: the header (top row part, ending in the
 * Rail toggle), Search, Canvas, the Projects section (with the SSH section on
 * desktop), and the icon-only footer. Fills the width its container gives it
 * and inherits the Rail's sidebar surface.
 */
export function RailExpanded({
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
}: RailExpandedProps): React.JSX.Element {
  const { updateProject, deleteProject, archiveProject, restoreProject, reorderProjects } =
    useProjectActions()
  const searchShortcut = useShortcutLabel('commandPalette')

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <RailHeader />

      <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-2">
        <RailRow
          label="Search"
          chip={searchShortcut}
          icon={<Search size={16} />}
          onClick={onOpenCommandPalette}
        />
        <RailRow
          label="Canvas"
          name="Open canvas"
          hint={canOpenCanvas ? undefined : NEED_PROJECT}
          icon={<Edit2 size={16} />}
          disabled={!canOpenCanvas}
          onClick={onOpenCanvas}
        />
      </div>

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
