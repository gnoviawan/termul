import { useMemo } from 'react'
import { AlertTriangle } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { ProjectSwitcher } from '@/components/shell/ProjectSwitcher'
import { RailButton } from '@/components/shell/rail-button'
import type { ProjectRowStatus } from '@/components/sidebar/indicators'
import { orderRailProjects } from '@/components/sidebar/rail-project-order'
import { useProjectRail } from '@/components/sidebar/use-project-rail'
import { needsYouLabel } from '@/lib/agent-chat-attention'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'

/** Other projects shown as icons under the active one; the rest go behind "+N". */
export const RAIL_STACK_OTHERS = 4

interface RailProjectStackProps {
  projects: Project[]
  activeProject: Project | undefined
  onSelectProject: (id: string) => void
  onNewProject: () => void
}

/** Tooltip and accessible description of the one badge a project icon shows. */
function statusHint(status: ProjectRowStatus): string | undefined {
  if (status.attentionCount > 0) return needsYouLabel(status.attentionCount)
  if (status.crashed) return 'Terminal crashed'
  if (status.live === 'activity') return 'Running'
  return undefined
}

/** Warning count on an icon's top-right corner: how many chats need you. */
function NeedsYouBadge({ count }: { count: number }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -top-1 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-3xs font-semibold tabular-nums text-warning-foreground ring-2 ring-sidebar"
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

/**
 * One badge on the icon's top-right corner, in the same order as the
 * expanded row: needs you (warning count), crash (warning glyph), live work
 * (primary dot, blue is for live work only).
 */
function StatusBadge({ status }: { status: ProjectRowStatus }): React.JSX.Element | null {
  if (status.attentionCount > 0) return <NeedsYouBadge count={status.attentionCount} />
  if (status.crashed) {
    return (
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-sidebar text-warning"
      >
        <AlertTriangle size={10} />
      </span>
    )
  }
  if (status.live === 'activity') {
    return (
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary ring-2 ring-sidebar"
      />
    )
  }
  return null
}

/**
 * Collapsed Rail projects: the active project (the Project switcher trigger,
 * on the keycap), then up to {@link RAIL_STACK_OTHERS} other open projects
 * with their status, in the expanded Rail's order (so an icon never moves
 * under the pointer when a status changes), then "+N" for the rest (the same
 * switcher). The "+N" button carries one needs-you badge when a hidden
 * project needs you. An icon's click is the expanded row's main click
 * (`openProject`); the status is a badge and a description, not an action.
 */
export function RailProjectStack({
  projects,
  activeProject,
  onSelectProject,
  onNewProject
}: RailProjectStackProps): React.JSX.Element {
  const { status, openProject } = useProjectRail({
    activeProjectId: activeProject?.id,
    onSelectProject
  })
  const storeGroups = useProjectStore((state) => state.groups)
  const groups = useMemo(() => storeGroups ?? [], [storeGroups])

  const ordered = useMemo(() => orderRailProjects(projects, groups), [projects, groups])
  const others = useMemo(
    () => ordered.filter((project) => project.id !== activeProject?.id),
    [ordered, activeProject?.id]
  )
  const shown = others.slice(0, RAIL_STACK_OTHERS)
  const hidden = others.slice(RAIL_STACK_OTHERS)
  const hiddenNeedsYou = hidden.reduce((sum, project) => sum + status(project.id).attentionCount, 0)

  const switcherProps = { projects: ordered, activeProject, openProject, onNewProject }
  const moreLabel = `${hidden.length} more projects`

  return (
    <div className="flex flex-col items-center gap-0.5" data-testid="rail-project-stack">
      <ProjectSwitcher
        {...switcherProps}
        label={activeProject ? `Switch project (${activeProject.name})` : 'Switch project'}
        pressed={Boolean(activeProject)}
        trigger={
          activeProject ? (
            <ProjectIcon project={activeProject} size={20} />
          ) : (
            <span
              aria-hidden="true"
              className="size-5 rounded border border-dashed border-muted-foreground/60"
            />
          )
        }
      />

      {shown.map((project) => {
        const projectStatus = status(project.id)
        const hint = statusHint(projectStatus)
        return (
          <RailButton
            key={project.id}
            label={project.name}
            hint={hint}
            aria-label={`Open ${project.name}`}
            description={hint}
            badge={<StatusBadge status={projectStatus} />}
            onClick={() => openProject(project.id)}
          >
            <ProjectIcon project={project} size={20} />
          </RailButton>
        )
      })}

      {hidden.length > 0 && (
        <ProjectSwitcher
          {...switcherProps}
          label={hiddenNeedsYou > 0 ? `${moreLabel}, ${needsYouLabel(hiddenNeedsYou)}` : moreLabel}
          pressed={false}
          trigger={
            <>
              <span className="text-2xs font-semibold tabular-nums text-muted-foreground">
                +{hidden.length}
              </span>
              {hiddenNeedsYou > 0 && <NeedsYouBadge count={hiddenNeedsYou} />}
            </>
          }
        />
      )}
    </div>
  )
}
