import { useMemo, useState } from 'react'
import { Check, Plus } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { railButtonClass } from '@/components/shell/rail-button'
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from '@/components/ui/menu-styles'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverSearchBand } from '@/components/ui/popover-search-band'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'

/**
 * cmdk marks every item `data-disabled="false"`, and `MENU_ITEM_CLASS` matches
 * the bare `data-disabled` attribute (Radix sets it only when disabled), which
 * would make every row ignore the pointer. Re-enable the pointer on the
 * not-disabled state.
 */
const SWITCHER_ITEM_CLASS = cn(
  MENU_ITEM_CLASS,
  'gap-2 data-[disabled=false]:pointer-events-auto! data-[disabled=false]:opacity-100!'
)

interface ProjectSwitcherProps {
  projects: Project[]
  activeProject: Project | undefined
  /** Switches to the project and goes to the workspace (`useProjectRail`). */
  openProject: (projectId: string) => void
  onNewProject: () => void
  /** Content of the trigger button (an icon, or a count). */
  trigger: React.ReactNode
  /** Accessible name and tooltip of the trigger. */
  label: string
  /** The trigger takes the keycap "you are here" surface while closed. */
  pressed: boolean
}

/**
 * Collapsed Rail's Project switcher: a trigger button opens a popover with a
 * search field, the open Projects and `New project`. Enter switches (as the
 * sidebar's `openProject`) and closes; Esc closes with focus back on the
 * trigger (Radix restores it).
 */
export function ProjectSwitcher({
  projects,
  activeProject,
  openProject,
  onNewProject,
  trigger,
  label,
  pressed
}: ProjectSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const live = projects.filter((project) => !project.isArchived)
    if (!needle) return live
    return live.filter((project) => project.name.toLowerCase().includes(needle))
  }, [projects, query])

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) setQuery('')
  }

  const selectProject = (projectId: string): void => {
    handleOpenChange(false)
    openProject(projectId)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={railButtonClass(open || pressed)}
              aria-label={label}
              aria-haspopup="dialog"
              aria-expanded={open}
            >
              {trigger}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" className="px-2.5 py-1.5 text-xs">
          <span className="text-popover-foreground">{label}</span>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className={cn(MENU_CONTENT_CLASS, 'w-72 p-0')}
        aria-label="Switch project"
      >
        {/* Filtering is by name here, so cmdk's own filter is off. */}
        <Command shouldFilter={false} className="rounded-xl">
          <PopoverSearchBand
            value={query}
            onChange={setQuery}
            placeholder="Search projects…"
            ariaLabel="Search projects"
            autoFocus
            inputClassName="text-xs"
          />
          <CommandList className="max-h-72 p-1">
            {matches.length === 0 ? (
              <p role="status" className="py-6 text-center text-xs text-muted-foreground">
                No projects found
              </p>
            ) : (
              <CommandGroup className="p-0">
                {matches.map((project) => {
                  const isActive = project.id === activeProject?.id
                  return (
                    <CommandItem
                      key={project.id}
                      value={project.id}
                      onSelect={() => selectProject(project.id)}
                      className={SWITCHER_ITEM_CLASS}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <ProjectIcon project={project} size={16} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{project.name}</span>
                        {project.path && (
                          <span className="block truncate text-2xs text-muted-foreground">
                            {project.path}
                          </span>
                        )}
                      </span>
                      {isActive && (
                        <Check
                          size={14}
                          aria-label="Active project"
                          className="shrink-0 text-foreground"
                        />
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
            <CommandSeparator className="my-1" />
            <CommandItem
              value="__new-project__"
              onSelect={() => {
                handleOpenChange(false)
                onNewProject()
              }}
              className={SWITCHER_ITEM_CLASS}
            >
              <Plus size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
              New project
            </CommandItem>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
