/**
 * Subject B: the same rows written directly against GPUIX (what a native
 * override of `ProjectItem` would be), styled with the same class strings
 * through tw(). Throwaway, for the compat performance gate.
 */

import type { EventPayload } from '@gpuix/react'
import { memo, useState } from 'react'
import { getColorClasses } from '@/lib/colors'
import type { Project } from '@/types/project'
import { Settings } from '../../../src/icons'
import { tw } from '../../../src/style/tw'
import { useBenchStore } from './data'

const ROW_ACTIVE = tw('group flex h-8 w-full cursor-pointer select-none items-center pr-1.5 text-left text-xs rounded-lg gap-2 px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring keycap text-foreground')
const ROW = tw('group flex h-8 w-full cursor-pointer select-none items-center pr-1.5 text-left text-xs rounded-lg gap-2 px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-row-hover')
const ICON_BOX = tw('flex size-4 shrink-0 items-center justify-center')
const ICON = tw('flex shrink-0 select-none items-center justify-center rounded font-semibold leading-none text-primary-foreground')
const NAME_BOX = tw('relative flex min-w-0 flex-1 items-center gap-2')
const NAME = tw('min-w-0 flex-1 truncate font-medium text-secondary-foreground')
const NAME_HOVER = tw('min-w-0 flex-1 truncate font-medium text-foreground')
const ACTIONS = tw('absolute inset-y-0 right-0 flex items-center gap-1 pl-6')
const SETTINGS = tw('flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground')
const KBD = tw('rounded border border-border font-sans text-3xs font-medium text-muted-foreground flex h-4.5 shrink-0 items-center px-1')

/** A closed tooltip still owns open state and hover listeners, as Radix's does. */
function TooltipLite({ children }: { children: (handlers: Record<string, unknown>) => React.ReactNode }) {
  const [, setOpen] = useState(false)
  return <>{children({ onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false) })}</>
}

const Row = memo(function Row({ project, index }: { project: Project; index: number }) {
  const [hovered, setHovered] = useState(false)
  const [, setMenu] = useState(false)
  const active = index === 0
  const shortcut = index < 9 ? `Ctrl+${index + 1}` : undefined
  return (
    <div testId={`project-item-${project.id}`}>
      <div
        style={active ? ROW_ACTIVE : ROW}
        tabIndex={0}
        role="button"
        aria-label={`Project: ${project.name}${active ? ' (active)' : ''}`}
        onClick={() => {}}
        onAuxClick={(e: EventPayload) => e.isRightClick && setMenu(true)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div style={ICON_BOX}>
          <div style={{ ...ICON, ...tw(getColorClasses(project.color).bg), width: 16, height: 16, fontSize: 10 }}>
            <text>{project.name.charAt(0).toUpperCase()}</text>
          </div>
        </div>
        <div style={NAME_BOX}>
          <text style={hovered || active ? NAME_HOVER : NAME}>{project.name}</text>
          {hovered && (
            <div style={ACTIONS}>
              <TooltipLite>
                {(handlers) => (
                  <div style={SETTINGS} onClick={() => {}} {...handlers}>
                    <Settings size={12} />
                  </div>
                )}
              </TooltipLite>
              {shortcut && (
                <div style={KBD}>
                  <text>{shortcut}</text>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

export function HandList() {
  const projects = useBenchStore((s) => s.projects)
  return (
    <div testId="bench-ready" style={{ ...tw('flex w-[260px] flex-col gap-0.5 bg-sidebar p-2') }}>
      {projects.map((project, index) => (
        <Row key={project.id} project={project} index={index} />
      ))}
    </div>
  )
}
