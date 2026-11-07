import type { ReactNode } from 'react'
import { Check, Download, GitBranch, Terminal, Wifi } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { type ProjectRowStatus, ProjectStatusMarks } from '@/components/sidebar/indicators'
import {
  STATUS_BAR_HIT_GLYPH,
  STATUS_BAR_HIT_TARGET,
  STATUS_BAR_HOVER_CLASS,
  STATUS_BAR_ITEM_CLASS
} from '@/components/status-bar-hit'
import { TermulMark } from '@/components/TermulMark'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'
import { Caption, Pad } from './kit'
import { MOCK_PROJECTS } from './mocks'

const PROJECTS: Project[] = MOCK_PROJECTS.map((project) => ({ ...project }))

export function ProjectIcons() {
  return (
    <Pad className="gap-4">
      <div className="grid grid-cols-3 gap-3">
        {PROJECTS.map((project) => (
          <div key={project.id} className="flex items-center gap-2 text-xs">
            <ProjectIcon project={project} size={18} />
            <span className="truncate">{project.name}</span>
            <span className="ml-auto font-mono text-3xs text-muted-foreground">
              {project.color}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-end gap-4">
        {[13, 16, 18, 24].map((size) => (
          <div key={size} className="flex flex-col items-center gap-1">
            <ProjectIcon project={PROJECTS[0]} size={size} />
            <span className="font-mono text-3xs text-muted-foreground">{size}</span>
          </div>
        ))}
      </div>
      <Caption>Monogram tile on bg-project-* when no resolved icon exists.</Caption>
    </Pad>
  )
}

export function BrandMark() {
  return (
    <Pad className="gap-4">
      <div className="flex items-end gap-6 text-foreground">
        {[16, 22, 32, 48].map((size) => (
          <div key={size} className="flex flex-col items-center gap-2">
            <TermulMark size={size} />
            <span className="font-mono text-3xs text-muted-foreground">{size}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <TermulMark size={22} className="text-primary" />
        <TermulMark size={22} className="text-muted-foreground" />
      </div>
      <Caption>Inline SVG on currentColor, so it follows the theme.</Caption>
    </Pad>
  )
}

const ROWS: { project: Project; status: ProjectRowStatus; active?: boolean }[] = [
  {
    project: PROJECTS[0],
    status: { live: 'activity', attentionCount: 0, crashed: false },
    active: true
  },
  { project: PROJECTS[1], status: { live: 'idle-agent', attentionCount: 2, crashed: false } },
  { project: PROJECTS[2], status: { live: null, attentionCount: 0, crashed: true } },
  { project: PROJECTS[3], status: { live: null, attentionCount: 0, crashed: false } },
  { project: PROJECTS[6], status: { live: null, attentionCount: 0, crashed: false } }
]

export function SidebarRows() {
  return (
    <div className="flex h-full flex-col gap-3 bg-sidebar-background p-3">
      <span className="label-section px-2 text-sidebar-foreground/70">Projects</span>
      <ul className="flex flex-col gap-0.5">
        {ROWS.map(({ project, status, active }) => (
          <li
            key={project.id}
            className={cn(
              'flex h-8 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground',
              active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-row-hover'
            )}
          >
            <ProjectIcon project={project} size={16} />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            <ProjectStatusMarks status={status} onOpenNeedsYou={() => {}} />
          </li>
        ))}
      </ul>
      <Caption>
        Mock rows built from ProjectIcon and ProjectStatusMarks. Not the live ProjectSidebar.
      </Caption>
    </div>
  )
}

function BarItem({
  icon,
  children,
  className
}: {
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn(STATUS_BAR_ITEM_CLASS, STATUS_BAR_HOVER_CLASS, className)}>
      {icon ? <span className="flex shrink-0 items-center">{icon}</span> : null}
      {children}
    </div>
  )
}

export function StatusBarAnatomy() {
  return (
    <Pad className="gap-4">
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="h-16 bg-background" />
        <div className="relative flex h-7 select-none items-center gap-0.5 border-t border-border bg-card px-1.5 font-sans text-2xs text-muted-foreground">
          <BarItem
            icon={<GitBranch size={12} />}
            className="max-w-40 font-medium text-secondary-foreground"
          >
            <span className="truncate leading-none">feature/canvas</span>
          </BarItem>
          <BarItem className="max-w-64 font-normal text-muted-foreground/70">
            <span className="truncate leading-none">~/code/termul</span>
          </BarItem>
          <div className="min-w-2 flex-1" />
          <BarItem className="tabular-nums" icon={<Check size={12} className="text-success" />}>
            <span className="leading-none">Exit 0</span>
          </BarItem>
          <BarItem icon={<Download size={12} />} className="text-secondary-foreground">
            <span className="leading-none">Update ready</span>
          </BarItem>
          <span aria-hidden="true" className="mx-1 h-3 w-px shrink-0 bg-border" />
          <button type="button" aria-label="Remote access" className={STATUS_BAR_HIT_TARGET}>
            <span className={STATUS_BAR_HIT_GLYPH}>
              <Wifi size={12} aria-hidden />
            </span>
          </button>
          <button type="button" aria-label="New terminal" className={STATUS_BAR_HIT_TARGET}>
            <span className={STATUS_BAR_HIT_GLYPH}>
              <Terminal size={12} aria-hidden />
            </span>
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="font-mono text-muted-foreground">STATUS_BAR_ITEM_CLASS</dt>
        <dd>24px text slot, icon + label</dd>
        <dt className="font-mono text-muted-foreground">STATUS_BAR_HOVER_CLASS</dt>
        <dd>Neutral hover wash</dd>
        <dt className="font-mono text-muted-foreground">STATUS_BAR_HIT_TARGET</dt>
        <dd>24px icon button, padded hit area, 44px on coarse pointers</dd>
        <dt className="font-mono text-muted-foreground">Bar</dt>
        <dd>28px, bg-card, border-t, text-2xs</dd>
      </dl>
      <Caption>Replica built from status-bar-hit constants with mock values.</Caption>
    </Pad>
  )
}
