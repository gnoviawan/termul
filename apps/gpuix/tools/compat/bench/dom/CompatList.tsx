/** Subject A: the real `ProjectItem`, unchanged, rendered through the compat runtime. */

import { memo } from 'react'
import { ProjectItem } from '@/components/sidebar/project-item'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Project } from '@/types/project'
import { IDLE_STATUS, noop, useBenchStore } from '../data'

const Row = memo(function Row({ project, index }: { project: Project; index: number }) {
  return (
    <ProjectItem
      project={project}
      isActive={index === 0}
      isEditing={false}
      editName=""
      shortcut={index < 9 ? `Ctrl+${index + 1}` : undefined}
      status={IDLE_STATUS as never}
      onOpenNeedsYou={noop}
      onClick={noop}
      onContextMenu={noop}
      onEditNameChange={noop}
      onSaveRename={noop}
      onCancelRename={noop}
      onSettingsClick={noop}
    />
  )
})

export function CompatList() {
  const projects = useBenchStore((s) => s.projects)
  return (
    <TooltipProvider delayDuration={80}>
      <div data-testid="bench-ready" data-rail-surface className="flex w-[260px] flex-col gap-0.5 bg-sidebar p-2">
        {projects.map((project, index) => (
          <Row key={project.id} project={project} index={index} />
        ))}
      </div>
    </TooltipProvider>
  )
}
