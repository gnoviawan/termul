/**
 * Subject B: the same rows written directly against GPUIX (what a native
 * override of `ProjectItem` would be), styled with the same class strings
 * through tw(). Like an override, it uses the native ui primitives
 * (`src/ui` context menu, tooltip, kbd) the real row gets through the
 * `@/components/ui` aliases. Throwaway, for the compat performance gate.
 */

import { memo, useState } from 'react'
import { getColorClasses } from '@/lib/colors'
import type { Project } from '@/types/project'
import { Settings } from '../../../src/icons'
import { tw } from '../../../src/style/tw'
import { ContextMenu, ContextMenuTrigger } from '../../../src/ui/context-menu'
import { Kbd } from '../../../src/ui/kbd'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../src/ui/tooltip'
import { useBenchStore } from './data'

const LIST = tw('flex w-[260px] flex-col gap-0.5 bg-sidebar p-2')
const ROW_ACTIVE = tw(
  'group flex h-8 w-full cursor-pointer select-none items-center pr-1.5 text-left text-xs rounded-lg gap-2 px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring keycap text-foreground'
)
const ROW = tw(
  'group flex h-8 w-full cursor-pointer select-none items-center pr-1.5 text-left text-xs rounded-lg gap-2 px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-row-hover'
)
const ICON_BOX = tw('flex size-4 shrink-0 items-center justify-center')
const ICON = tw(
  'flex shrink-0 select-none items-center justify-center rounded font-semibold leading-none text-primary-foreground'
)
const NAME_BOX = tw('relative flex min-w-0 flex-1 items-center gap-2')
const NAME = tw('min-w-0 flex-1 truncate font-medium text-secondary-foreground')
const NAME_HOVER = tw('min-w-0 flex-1 truncate font-medium text-foreground')
const ACTIONS = tw('absolute inset-y-0 right-0 flex items-center gap-1 pl-6')
const SETTINGS = tw(
  'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground'
)

const Row = memo(function Row({ project, index }: { project: Project; index: number }) {
  const [hovered, setHovered] = useState(false)
  const active = index === 0
  const shortcut = index < 9 ? `Ctrl+${index + 1}` : undefined
  return (
    <div testId={`project-item-${project.id}`}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            style={active ? ROW_ACTIVE : ROW}
            tabIndex={0}
            role="button"
            aria-label={`Project: ${project.name}${active ? ' (active)' : ''}`}
            onClick={() => {}}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <div style={ICON_BOX}>
              <div
                style={{
                  ...ICON,
                  ...tw(getColorClasses(project.color).bg),
                  width: 16,
                  height: 16,
                  fontSize: 10
                }}
              >
                <text>{project.name.charAt(0).toUpperCase()}</text>
              </div>
            </div>
            <div style={NAME_BOX}>
              <text style={hovered || active ? NAME_HOVER : NAME}>{project.name}</text>
              {hovered && (
                <div style={ACTIONS}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div style={SETTINGS} onClick={() => {}}>
                        <Settings size={12} />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className="flex flex-col gap-0.5 px-2.5 py-1.5 text-xs"
                    >
                      <text>Project settings</text>
                    </TooltipContent>
                  </Tooltip>
                  {shortcut && (
                    <Kbd className="inline-flex h-4.5 shrink-0 items-center px-1">{shortcut}</Kbd>
                  )}
                </div>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
      </ContextMenu>
    </div>
  )
})

export function HandList() {
  const projects = useBenchStore((s) => s.projects)
  return (
    <TooltipProvider delayDuration={80}>
      <div testId="bench-ready" style={LIST}>
        {projects.map((project, index) => (
          <Row key={project.id} project={project} index={index} />
        ))}
      </div>
    </TooltipProvider>
  )
}
