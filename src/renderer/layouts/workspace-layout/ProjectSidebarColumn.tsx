import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { panelEdgeToggleButtonClass, SidebarToggleButton } from '@/components/TitlebarPanelToggles'
import { edgeToggleMotion, panelRevealMotion } from '@/layouts/workspace-layout/panel-motion'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useProjectActions } from '@/stores/project-store'
import { useSidebarVisible } from '@/stores/sidebar-store'
import type { Project } from '@/types/project'

interface ProjectSidebarColumnProps {
  projects: Project[]
  activeProjectId: string
  onSelectProject: (id: string) => void
  onNewProject: () => void
  onSSHConnect: (profileId: string) => void
  onSelectSSHProfile: (profileId: string) => void
  activeSSHProfileId: string | null
}

/** Left sidebar column: width-reveal projects sidebar or the web-only edge toggle. */
export function ProjectSidebarColumn({
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onSSHConnect,
  onSelectSSHProfile,
  activeSSHProfileId
}: ProjectSidebarColumnProps): React.JSX.Element {
  const reducedMotion = useReducedMotion() ?? false
  const isSidebarVisible = useSidebarVisible()
  const { updateProject, deleteProject, archiveProject, restoreProject, reorderProjects } =
    useProjectActions()

  return (
    <AnimatePresence initial={false}>
      {isSidebarVisible ? (
        <motion.div
          key="project-sidebar"
          className="flex-shrink-0 h-full overflow-hidden"
          {...panelRevealMotion(reducedMotion)}
        >
          <div className="h-full">
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
          </div>
        </motion.div>
      ) : (
        !isTauriContext() && (
          // Web-only slim edge toggle so a hidden sidebar stays
          // re-openable. Desktop re-opens via the TitleBar toggle.
          // Its enter is deferred until the panel's collapse exits
          // (edgeToggleMotion) — see the helper's comment.
          <motion.div
            key="sidebar-edge-toggle"
            className="flex items-start pt-0 overflow-hidden"
            {...edgeToggleMotion(reducedMotion)}
          >
            <SidebarToggleButton className={panelEdgeToggleButtonClass} />
          </motion.div>
        )
      )}
    </AnimatePresence>
  )
}
